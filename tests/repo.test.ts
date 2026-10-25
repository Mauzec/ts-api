import { AppError } from "../src/errors";
import { Repository } from "../src/repo";
import { SyncStateRepository } from "../src/sync-state";
import { fixture, quote, seedUser } from "./helpers";

let f: Awaited<ReturnType<typeof fixture>>;
let repo: Repository;
let alice: number, bob: number;
beforeEach(async () => {
  f = await fixture();
  repo = new Repository(f.db);
  alice = await seedUser(f.db, "alice");
  bob = await seedUser(f.db, "bob");
});
afterEach(async () => { await f.close(); });

const tracking = () => f.db.read(sql => sql.all("SELECT * FROM active_tracking ORDER BY id"));
const page = () => repo.activePage(0, Number.MAX_SAFE_INTEGER);

async function seedAssets(count: number) {
  await f.db.write(async sql => {
    await sql.run(`INSERT INTO cryptocurrencies(cmc_id,slug,name,created_at,last_checked_at)
      VALUES ${Array.from({ length: count }, () => "(?,?,?,1,1)").join(",")}`,
      Array.from({ length: count }, (_, i) => [i + 1, `coin-${i + 1}`, `Coin ${i + 1}`]).flat());
    await sql.run("INSERT INTO price_history(cryptocurrency_id,price,quoted_at,received_at) SELECT id,100,1,1 FROM cryptocurrencies");
    await sql.run("INSERT INTO user_currencies(user_id,cryptocurrency_id,created_at,updated_at) SELECT ?,id,1,1 FROM cryptocurrencies", [alice]);
    await sql.run("INSERT INTO active_tracking(cryptocurrency_id,sub_count) SELECT id,1 FROM cryptocurrencies");
  });
}

test("two users share one catalog and quote while names and memberships remain private", async () => {
  const a = await repo.create(alice, quote(1, 100), "Alice Bitcoin", 101);
  const b = await repo.subscribe(bob, a.cryptoId, "Bob Bitcoin", 102);
  expect(a.id).not.toBe(b.id);
  expect(a.cryptoId).toBe(b.cryptoId);
  expect(a.slug).toBe("coin-1");
  expect((await tracking())[0]).toMatchObject({ sub_count: 2 });
  expect(await f.db.read(sql => sql.get("SELECT COUNT(*) AS count FROM price_history"))).toEqual({ count: 1 });
  await repo.update(alice, a.id, { displayName: "Renamed" }, 103);
  expect((await repo.get(bob, b.id)).displayName).toBe("Bob Bitcoin");
  expect((await repo.list(alice, { afterId: 0, limit: 100 })).items.map(item => item.id)).toEqual([a.id]);
  expect((await repo.findByCmcId(1))?.hasPrice).toBe(true);
});

test("new catalog creation uses eight data statements and saves the first quote", async () => {
  const before = f.db.metrics().sql.count;
  const asset = await repo.create(alice, quote(1, 100, 120), "Mine", 101);
  expect(f.db.metrics().sql.count - before).toBe(8);
  expect(asset).toMatchObject({ name: "Coin 1", slug: "coin-1", displayName: "Mine", lastCheckedAt: 101 });
  expect((await repo.priceSnapshot(alice, asset.id)).price).toEqual({ price: 120, quotedAt: 100, receivedAt: 100 });
  expect((await tracking())[0]).toMatchObject({ sub_count: 1 });
});

test("creation fills an existing catalog without a price but preserves an existing quote", async () => {
  const cryptoId = await f.db.write(async sql => (await sql.run(
    "INSERT INTO cryptocurrencies(cmc_id,slug,name,created_at) VALUES(1,'old-slug','Old name',1)",
  )).lastID);
  const a = await repo.create(alice, quote(1, 100, 120), "Alice", 101);
  expect(a).toMatchObject({ cryptoId, name: "Coin 1", slug: "coin-1", lastCheckedAt: 101 });
  const b = await repo.create(bob, { ...quote(1, 200, 999), name: "Ignored", slug: "ignored" }, "Bob", 201);
  expect(b).toMatchObject({ cryptoId, name: "Coin 1", slug: "coin-1", lastCheckedAt: 101 });
  expect((await repo.history(bob, b.id, { limit: 10 })).items).toEqual([{ price: 120, quotedAt: 100, receivedAt: 100 }]);
  expect((await tracking())[0]).toMatchObject({ sub_count: 2 });
});

test("failed canonical update rolls back the first quote for an existing catalog", async () => {
  await f.db.write(async sql => {
    await sql.run("INSERT INTO cryptocurrencies(cmc_id,slug,name,created_at) VALUES(1,'old-slug','Old name',1)");
    await sql.run("CREATE TRIGGER fail_catalog BEFORE UPDATE ON cryptocurrencies BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  });
  await expect(repo.create(alice, quote(1, 100), null, 101)).rejects.toMatchObject({ code: "DB_ERROR" });
  expect(await repo.findByCmcId(1)).toMatchObject({ name: "Old name", slug: "old-slug", hasPrice: false, lastCheckedAt: null });
  expect((await repo.list(alice, { afterId: 0, limit: 10 })).items).toEqual([]);
  expect(await tracking()).toEqual([]);
});

test("PATCH uses two data statements, supports clearing the name and rejects a missing subscription", async () => {
  const asset = await repo.create(alice, quote(1, 100), "Original", 101);
  for (const displayName of ["Renamed", null]) {
    const before = f.db.metrics().sql.count;
    const updated = await repo.update(alice, asset.id, { displayName }, 102);
    expect(f.db.metrics().sql.count - before).toBe(2);
    expect(updated).toMatchObject({ id: asset.id, displayName, updatedAt: 102 });
  }
  await expect(repo.update(alice, asset.id + 1, { displayName: "Missing" }, 103))
    .rejects.toMatchObject({ status: 404, code: "ASSET_NOT_FOUND" });
});

test("price, history and OHLC use the shared crypto ID rather than the personal subscription ID", async () => {
  const a = await repo.create(alice, quote(1, 100, 120), "Alice", 101);
  const b = await repo.subscribe(bob, a.cryptoId, "Bob", 102);
  const other = await repo.create(alice, quote(2, 100, 999), "Other coin", 103);
  expect(b.id).not.toBe(b.cryptoId);
  expect(b.id).toBe(other.cryptoId);
  expect(await repo.priceSnapshot(bob, b.id)).toMatchObject({ asset: b, price: { price: 120, quotedAt: 100 } });
  expect(await repo.history(bob, b.id, { limit: 10 })).toEqual({
    items: [{ price: 120, quotedAt: 100, receivedAt: 100 }], nextAfter: null,
  });
  expect(await repo.ohlc(bob, b.id, 0, 1000, 1000)).toEqual([
    { bucket: 0, open: 120, high: 120, low: 120, close: 120, count: 1 },
  ]);
});

test("all personal reads and writes reject a foreign ID exactly like a missing ID", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  const actions = [
    () => repo.get(bob, a.id),
    () => repo.priceSnapshot(bob, a.id),
    () => repo.history(bob, a.id, { limit: 10 }),
    () => repo.ohlc(bob, a.id, 0, 1000, 1000),
    () => repo.update(bob, a.id, { displayName: "stolen" }, 102),
    () => repo.remove(bob, a.id),
  ];
  for (const action of actions)
    await expect(action()).rejects.toMatchObject({ status: 404, code: "ASSET_NOT_FOUND" });
  expect((await repo.get(alice, a.id)).displayName).toBeNull();
  expect((await tracking())[0]).toMatchObject({ sub_count: 1 });
});

test("duplicate concurrent subscriptions increment the shared count only once", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  const results = await Promise.allSettled([
    repo.subscribe(bob, a.cryptoId, null, 102),
    repo.subscribe(bob, a.cryptoId, null, 102),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "ASSET_EXISTS" } });
  expect((await tracking())[0]).toMatchObject({ sub_count: 2 });
});

test("last removal deletes activation, retains history and rejoin gets fresh IDs", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  const b = await repo.subscribe(bob, a.cryptoId, null, 102);
  const oldActivation = (await page())[0]!;
  await repo.remove(alice, a.id);
  expect((await tracking())[0]).toMatchObject({ sub_count: 1 });
  await expect(repo.remove(alice, a.id)).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  await repo.remove(bob, b.id);
  expect(await tracking()).toEqual([]);
  await expect(repo.history(alice, a.id, { limit: 10 })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  const rejoined = await repo.subscribe(alice, a.cryptoId, "Again", 103);
  expect(rejoined.id).toBeGreaterThan(b.id);
  expect((await page())[0]!.id).toBeGreaterThan(oldActivation.id);
  expect((await repo.history(alice, rejoined.id, { limit: 10 })).items).toHaveLength(1);
});

test("failed creation rolls back catalog, history, personal subscription and count", async () => {
  await f.db.write(sql => sql.run("CREATE TRIGGER fail_subscription BEFORE INSERT ON user_currencies BEGIN SELECT RAISE(ABORT, 'fixture'); END"));
  await expect(repo.create(alice, quote(), null, 100)).rejects.toMatchObject({ code: "DB_ERROR" });
  for (const table of ["cryptocurrencies", "price_history", "user_currencies", "active_tracking"])
    expect(await f.db.read(sql => sql.get(`SELECT COUNT(*) AS count FROM ${table}`))).toEqual({ count: 0 });
});

test("failed count change restores the removed personal subscription", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  await f.db.write(sql => sql.run("CREATE TRIGGER fail_tracking BEFORE DELETE ON active_tracking BEGIN SELECT RAISE(ABORT, 'fixture'); END"));
  await expect(repo.remove(alice, a.id)).rejects.toMatchObject({ code: "DB_ERROR" });
  expect((await repo.get(alice, a.id)).id).toBe(a.id);
  expect((await tracking())[0]).toMatchObject({ sub_count: 1 });
});

test("late quotes from an old activation cannot alter a reactivated coin", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  const snapshots = await page();
  await repo.remove(alice, a.id);
  const b = await repo.subscribe(bob, a.cryptoId, null, 102);
  expect(await repo.saveQuotes(snapshots, [quote(1, 200, 120)], 201)).toMatchObject({ discarded: 1, inserted: 0 });
  expect((await repo.priceSnapshot(bob, b.id)).price?.price).toBe(100);
  expect((await repo.get(bob, b.id)).lastCheckedAt).toBe(101);
});

test("removing one subscriber does not invalidate another subscriber's active quote", async () => {
  const a = await repo.create(alice, quote(1, 100), "Alice", 101);
  const b = await repo.subscribe(bob, a.cryptoId, "Bob", 102);
  const snapshots = await page();
  await repo.remove(alice, a.id);
  expect(await repo.saveQuotes(snapshots, [{ ...quote(1, 200, 120), slug: "new-slug", name: "New name" }], 201)).toMatchObject({ inserted: 1 });
  expect(await repo.get(bob, b.id)).toMatchObject({ displayName: "Bob", slug: "new-slug", name: "New name", lastCheckedAt: 201 });
});

test("batch classifies duplicates, older values, equal-time conflicts and unknown assets", async () => {
  for (let i = 1; i <= 4; i++) await repo.create(alice, quote(i, 100), null, 101);
  const result = await repo.saveQuotes(await page(), [
    quote(1, 200, 120), quote(2, 100), quote(3, 99), quote(4, 100, 999), quote(5, 200),
  ], 201);
  expect(result).toEqual({ inserted: 1, duplicates: 1, outdated: 1, conflicts: 1, discarded: 1 });
  expect((await repo.findByCmcId(2))?.lastCheckedAt).toBe(201);
  expect((await repo.findByCmcId(3))?.lastCheckedAt).toBe(101);
  expect((await repo.findByCmcId(4))?.lastCheckedAt).toBe(101);
});

test("repeated entries in a batch do not create duplicate history", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  expect(await repo.saveQuotes(await page(), [quote(1, 200), quote(1, 200), quote(1, 150)], 201))
    .toMatchObject({ inserted: 1, duplicates: 1, outdated: 1 });
  expect((await repo.history(alice, a.id, { limit: 10 })).items.map(item => item.quotedAt)).toEqual([100, 200]);
});

test("failed bulk UPDATE also rolls back the preceding history INSERT", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  await f.db.write(sql => sql.run("CREATE TRIGGER fail_catalog BEFORE UPDATE ON cryptocurrencies BEGIN SELECT RAISE(ABORT, 'fixture'); END"));
  await expect(repo.saveQuotes(await page(), [quote(1, 200)], 201)).rejects.toMatchObject({ code: "DB_ERROR" });
  expect((await repo.history(alice, a.id, { limit: 10 })).items).toHaveLength(1);
  expect((await repo.get(alice, a.id)).lastCheckedAt).toBe(101);
});

test("250-asset save uses exactly three data statements and bounded active paging excludes new activations", async () => {
  await seedAssets(251);
  const sync = new SyncStateRepository(f.db);
  const { upperId } = await sync.start(100, 1000);
  const first = await repo.activePage(0, upperId);
  expect(first).toHaveLength(250);
  const before = f.db.metrics().sql.count;
  expect(await repo.saveQuotes(first, first.map(item => quote(item.cmcId, 200, 120)), 201)).toMatchObject({ inserted: 250 });
  expect(f.db.metrics().sql.count - before).toBe(3);
  await repo.create(alice, quote(252, 200), null, 201);
  const second = await repo.activePage(first.at(-1)!.id, upperId);
  expect(second.map(item => item.cmcId)).toEqual([251]);
  expect(await repo.activePage(second[0]!.id, upperId)).toEqual([]);
  expect(await repo.saveQuotes([], [], 201)).toEqual({ inserted: 0, duplicates: 0, outdated: 0, conflicts: 0, discarded: 0 });
  await expect(repo.saveQuotes([...first, first[0]!], [], 201)).rejects.toMatchObject({ code: "INVALID_QUOTE_BATCH" });
});

test("history uses [from,to), exclusive continuation and indexed chronological order", async () => {
  const a = await repo.create(alice, quote(1, 100), null, 101);
  await repo.saveQuotes(await page(), [quote(1, 200), quote(1, 300), quote(1, 400)], 401);
  const first = await repo.history(alice, a.id, { from: 100, to: 400, limit: 2 });
  expect(first.items.map(item => item.quotedAt)).toEqual([100, 200]);
  expect(first.nextAfter).toBe(200);
  expect((await repo.history(alice, a.id, { from: 100, to: 400, after: first.nextAfter!, limit: 2 })).items.map(item => item.quotedAt)).toEqual([300]);
  expect((await repo.history(alice, a.id, { from: 400, to: 400, limit: 2 })).items).toEqual([]);
  const plan = await f.db.read(sql => sql.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT price FROM price_history WHERE cryptocurrency_id=? AND quoted_at>=? ORDER BY quoted_at LIMIT 10", [a.cryptoId, 100],
  ));
  expect(plan.some(row => row.detail.includes("USING INDEX"))).toBe(true);
});

test("OHLC orders by source time, handles gaps and clips partial UTC intervals", async () => {
  const hour = 3600000, day = Date.UTC(2026, 0, 2);
  const a = await repo.create(alice, quote(1, day + 100, 100), null, day + 101);
  await f.db.write(async sql => {
    for (const [offset, price] of [[400, 105], [200, 110], [300, 90], [hour * 2, 7]])
      await sql.run("INSERT INTO price_history(cryptocurrency_id,price,quoted_at,received_at) VALUES(?,?,?,?)", [a.cryptoId, price!, day + offset!, day + offset!]);
  });
  expect(await repo.ohlc(alice, a.id, day, day + 3 * hour, hour)).toEqual([
    { bucket: day, open: 100, high: 110, low: 90, close: 105, count: 4 },
    { bucket: day + 2 * hour, open: 7, high: 7, low: 7, close: 7, count: 1 },
  ]);
  expect(await repo.ohlc(alice, a.id, day + 200, day + 400, hour)).toEqual([
    { bucket: day, open: 110, high: 110, low: 90, close: 90, count: 2 },
  ]);
});

test("sync state persists scheduling, retry backoff and clears auth pause on restart", async () => {
  const sync = new SyncStateRepository(f.db);
  expect((await sync.state()).scheduledAt).toBe(0);
  const { previous } = await sync.start(1000, 1000);
  expect(await sync.state()).toMatchObject({ scheduledAt: 2000, status: "running", lastStartedAt: 1000 });
  await sync.failure(1100, 1000, previous, new AppError(429, "CMC_RATE_LIMITED", "Rate limit", { retryAt: 5000 }));
  expect(await sync.state()).toMatchObject({ scheduledAt: 5000, blockedUntil: 5000, status: "failed", consecutiveFailures: 1 });
  await sync.failure(1200, 1000, await sync.state(), new AppError(502, "CMC_AUTH_FAILED", "Auth", { pause: true }));
  expect((await sync.state()).status).toBe("paused");
  await sync.initialize();
  expect(await sync.state()).toMatchObject({ status: "idle", lastErrorCode: null, blockedUntil: null });
  await sync.start(2000, 1000);
  await sync.initialize();
  expect(await sync.state()).toMatchObject({ status: "interrupted", lastErrorCode: "SYNC_INTERRUPTED", scheduledAt: 3000 });
  await sync.success(2000, 4500, 1000, { runId: "test", requested: 1, invalid: 1, batches: 1, status: "parted", inserted: 0, duplicates: 0, outdated: 0, conflicts: 0, discarded: 0 });
  expect(await sync.state()).toMatchObject({ scheduledAt: 5000, status: "parted", lastSuccessAt: null, consecutiveFailures: 0 });
});
