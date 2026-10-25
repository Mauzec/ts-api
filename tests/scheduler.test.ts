import { setTimeout as realTimeout } from "node:timers/promises";
import timers from "node:timers";
import { Repository } from "../src/repo";
import { SyncStateRepository } from "../src/sync-state";
import { SyncService } from "../src/services";
import { Scheduler } from "../src/scheduler";
import { AppError } from "../src/errors";
import {
  config,
  FakeProvider,
  fixture,
  logger,
  quote,
  seedUser,
} from "./helpers";
import type { SyncState } from "../src/types";

async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await realTimeout(10);
  }
  throw new Error("Scheduler did not settle");
}

describe("persistent scheduler", () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    provider: FakeProvider,
    sync: SyncService,
    scheduler: Scheduler;
  beforeEach(async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 19) });

    jest.spyOn(timers, "clearTimeout").mockImplementation(clearTimeout);
    f = await fixture();
    const repository = new Repository(f.db);
    provider = new FakeProvider();
    await repository.create(
      await seedUser(f.db),
      quote(1, Date.now() - 60000),
      null,
      Date.now(),
    );
    sync = new SyncService(
      new SyncStateRepository(f.db),
      repository,
      provider,
      config({ cmcPriceSyncIntervalMs: 900000 }),
      logger,
    );
    await sync.initialize();
    scheduler = new Scheduler(sync, logger);
  });
  afterEach(async () => {
    scheduler.stop();
    await sync.stop();
    await f.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  const armed = () =>
    until(
      () =>
        jest.getTimerCount() === 1 &&
        f.db.metrics().readers.active === 0 &&
        f.db.metrics().writer.active === 0,
    );
  async function completed(calls: number): Promise<void> {
    await until(
      () => provider.prices.mock.calls.length === calls && !sync.isRunning,
    );
    await armed();
  }

  test("one timer, no overlap, next run after the persisted due time", async () => {
    scheduler.start();
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(0);
    await completed(1);
    await jest.advanceTimersByTimeAsync(899999);
    expect(provider.prices).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await completed(2);
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
  test("restart does not immediately replay a reserved run", async () => {
    await f.db.write((sql) =>
      sql.run("UPDATE sync_state SET scheduled_at=?", [Date.now() + 120000]),
    );
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(119999);
    expect(provider.prices).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await completed(1);
  });
  test("an upstream Retry-After defers only scheduled work and recovers without account probing", async () => {
    const due = Date.now() + 1800000;
    provider.prices.mockRejectedValueOnce(
      new AppError(429, "CMC_RATE_LIMITED", "Limited", { retryAt: due }),
    );
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(0);
    await completed(1);
    expect(await sync.state()).toMatchObject({ scheduledAt: due });
    await jest.advanceTimersByTimeAsync(1799999);
    expect(provider.prices).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await completed(2);
  });
  test("a persisted due time beyond the timer maximum rearms until its actual date", async () => {
    const due = Date.now() + 31 * 86400000;
    await f.db.write((sql) =>
      sql.run("UPDATE sync_state SET scheduled_at=?", [due]),
    );
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(2147483647);
    await armed();
    expect(provider.prices).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(due - Date.now());
    await completed(1);
  });
  test("a failed SQLite scheduling write cannot cause a zero-delay retry loop or any network call", async () => {
    await f.db.write((sql) =>
      sql.run(
        "CREATE TRIGGER deny_sync BEFORE UPDATE ON sync_state BEGIN SELECT RAISE(ABORT,'denied'); END;",
      ),
    );
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(0);
    await until(() => !sync.isRunning);
    await armed();
    await jest.advanceTimersByTimeAsync(1000);
    expect(provider.prices).not.toHaveBeenCalled();
    await f.db.write((sql) => sql.run("DROP TRIGGER deny_sync"));
    await jest.advanceTimersByTimeAsync(59000);
    await completed(1);
  });
  test("failed completion writes retain the scheduled delay and recover without a process restart", async () => {
    await f.db.write((sql) =>
      sql.run(
        "CREATE TRIGGER fail_final_state BEFORE UPDATE OF last_finished_at ON sync_state BEGIN SELECT RAISE(ABORT,'transient storage failure'); END;",
      ),
    );
    const started = Date.now();
    scheduler.start();
    await armed();
    await jest.advanceTimersByTimeAsync(0);
    await completed(1);
    expect(await sync.state()).toMatchObject({
      status: "running",
      scheduledAt: started + 900000,
    });
    await jest.advanceTimersByTimeAsync(899999);
    expect(provider.prices).toHaveBeenCalledTimes(1);
    await f.db.write((sql) => sql.run("DROP TRIGGER fail_final_state"));
    await jest.advanceTimersByTimeAsync(1);
    await completed(2);
    expect(await sync.state()).toMatchObject({
      status: "success",
      scheduledAt: started + 1800000,
    });
  });
  test("a state-read failure after arming rejects safely and recovers after SQLite is available again", async () => {
    await f.db.write((sql) =>
      sql.run("UPDATE sync_state SET scheduled_at=?", [Date.now() + 1000]),
    );
    scheduler.start();
    await armed();
    await f.db.write((sql) =>
      sql.run("ALTER TABLE sync_state RENAME TO unavailable_sync_state"),
    );
    await jest.advanceTimersByTimeAsync(1000);
    await until(() => !sync.isRunning);
    await armed();
    expect(provider.prices).not.toHaveBeenCalled();
    await f.db.write((sql) =>
      sql.run("ALTER TABLE unavailable_sync_state RENAME TO sync_state"),
    );
    await jest.advanceTimersByTimeAsync(59999);
    expect(provider.prices).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await armed();
    await jest.advanceTimersByTimeAsync(0);
    await completed(1);
    expect((await sync.state()).status).toBe("success");
  });
  test.each(["resolve", "reject"])(
    "stop while reading state cannot create a timer after %s",
    async (outcome) => {
      const state = await sync.state();
      let resolve!: (state: SyncState) => void, reject!: (error: Error) => void;
      jest.spyOn(sync, "state").mockImplementationOnce(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      scheduler.start();
      scheduler.stop();
      if (outcome === "resolve") resolve(state);
      else reject(new Error("state unavailable"));
      await Promise.resolve();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  test("stale state completion cannot replace a newer schedule", async () => {
    const state = await sync.state();
    let release!: (state: SyncState) => void;
    jest
      .spyOn(sync, "state")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...state, scheduledAt: Date.now() + 120000 });
    scheduler.start();
    sync.onSettled!();
    await armed();
    release({ ...state, scheduledAt: 0 });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(119999);
    expect(provider.prices).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await completed(1);
  });
});
