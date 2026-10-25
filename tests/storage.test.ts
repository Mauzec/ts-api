import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "sqlite3";
import { openDatabase, type SqlExecutor, type Storage } from "../src/db";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const resources: { directory: string; db: Storage }[] = [];
async function database(options: Parameters<typeof openDatabase>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-storage-"));
  const path = join(directory, "test.sqlite");
  const db = await openDatabase(path, options);
  resources.push({ directory, db });
  return { db, path, directory };
}

afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.db.close();
    rmSync(item.directory, { force: true, recursive: true });
  }
});

test("operations execute, release connections and reopen persisted data", async () => {
  const { db, path } = await database();
  const inserted = await db.write(sql => sql.run(
    "INSERT INTO users(login,password_hash,created_at) VALUES(?,?,?)", ["alice", "hash", 1],
  ));
  expect(inserted).toMatchObject({ lastID: 1, changes: 1 });
  expect(await db.read(sql => sql.get("PRAGMA foreign_keys"))).toEqual({ foreign_keys: 1 });
  expect(await db.read(sql => sql.get("PRAGMA journal_mode"))).toEqual({ journal_mode: "wal" });
  await db.write(sql => sql.run("UPDATE sync_state SET scheduled_at=123456, status='success' WHERE id=1"));
  await db.close();
  const reopened = await openDatabase(path);
  try {
    expect(await reopened.read(sql => sql.all("SELECT login FROM users"))).toEqual([{ login: "alice" }]);
    expect(await reopened.read(sql => sql.get("PRAGMA user_version"))).toEqual({ user_version: 1 });
    expect(await reopened.read(sql => sql.all("SELECT id, scheduled_at, status FROM sync_state")))
      .toEqual([{ id: 1, scheduled_at: 123456, status: "success" }]);
    expect(await reopened.read(sql => sql.all("PRAGMA foreign_key_check"))).toEqual([]);
  } finally { await reopened.close(); }
});

test("an unversioned user table resembling a SQLite internal name is preserved and rejected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-unversioned-"));
  const path = join(directory, "test.sqlite");
  const native = new Database(path);
  try {
    await new Promise<void>((resolve, reject) => native.exec(
      "CREATE TABLE sqliteXcustom(value INTEGER); INSERT INTO sqliteXcustom VALUES(42)",
      error => error ? reject(error) : resolve(),
    ));
    await expect(openDatabase(path)).rejects.toMatchObject({ code: "DB_SCHEMA_UNSUPPORTED" });
    const rows = await new Promise<unknown[]>((resolve, reject) => native.all(
      "SELECT value FROM sqliteXcustom", (error, rows) => error ? reject(error) : resolve(rows),
    ));
    expect(rows).toEqual([{ value: 42 }]);
    const tables = await new Promise<unknown[]>((resolve, reject) => native.all(
      "SELECT name FROM sqlite_schema WHERE type='table'", (error, rows) => error ? reject(error) : resolve(rows),
    ));
    expect(tables).toEqual([{ name: "sqliteXcustom" }]);
  } finally {
    await new Promise<void>((resolve, reject) => native.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each([0, 99])("rejects incompatible version %i without deleting existing data", async version => {
  const { db, path } = await database();
  await db.write(async sql => {
    await sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('kept','hash',1)");
    await sql.run(`PRAGMA user_version=${version}`);
  });
  await db.close();
  await expect(openDatabase(path)).rejects.toMatchObject({ code: "DB_SCHEMA_UNSUPPORTED" });
  const native = new Database(path);
  try {
    const row = await new Promise<unknown>((resolve, reject) => native.get(
      "SELECT login FROM users", (error, value) => error ? reject(error) : resolve(value),
    ));
    expect(row).toEqual({ login: "kept" });
  } finally {
    await new Promise<void>((resolve, reject) => native.close(error => error ? reject(error) : resolve()));
  }
});

test("writer transactions do not interleave; rollback does not affect queued success", async () => {
  const { db } = await database();
  const entered = deferred(), release = deferred();
  const first = db.write(async sql => {
    await sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('rollback','hash',1)");
    entered.resolve();
    await release.promise;
    throw new Error("rollback fixture");
  });
  const failed = expect(first).rejects.toMatchObject({ code: "DB_ERROR" });
  await entered.promise;
  const second = db.write(sql => sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('committed','hash',1)"));
  expect(db.metrics().writer.generalQueued).toBe(1);
  release.resolve();
  await failed;
  await second;
  expect(await db.read(sql => sql.all("SELECT login FROM users"))).toEqual([{ login: "committed" }]);
});

test("a composed read keeps one consistent snapshot while the writer commits", async () => {
  const { db } = await database();
  const entered = deferred(), release = deferred();
  const reading = db.read(async sql => {
    const before = await sql.get("SELECT COUNT(*) AS count FROM users");
    entered.resolve();
    await release.promise;
    return [before, await sql.get("SELECT COUNT(*) AS count FROM users")];
  });
  await entered.promise;
  await db.write(sql => sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('new','hash',1)"));
  expect(await db.read(sql => sql.get("SELECT COUNT(*) AS count FROM users"))).toEqual({ count: 1 });
  release.resolve();
  expect(await reading).toEqual([{ count: 0 }, { count: 0 }]);
});

test.each(["read", "write"] as const)("already cancelled %s never begins", async kind => {
  const { db } = await database();
  const controller = new AbortController();
  controller.abort();
  const operation = jest.fn(async () => 1);
  await expect(db[kind](operation, controller.signal)).rejects.toMatchObject({ code: "DB_CANCELLED" });
  expect(operation).not.toHaveBeenCalled();
  expect(await db.read(sql => sql.get("SELECT 1 AS value"))).toEqual({ value: 1 });
});

test("queued cancellation frees capacity and does not interrupt the next writer", async () => {
  const { db } = await database({ writeQueueLimit: 1 });
  const entered = deferred(), release = deferred();
  const first = db.write(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const controller = new AbortController(), operation = jest.fn(async () => {});
  const queued = db.write(operation, controller.signal);
  const cancelled = expect(queued).rejects.toMatchObject({ code: "DB_CANCELLED" });
  controller.abort();
  await cancelled;
  const next = db.write(sql => sql.get("SELECT 7 AS value"));
  release.resolve();
  await first;
  expect(await next).toEqual({ value: 7 });
  expect(operation).not.toHaveBeenCalled();
});

test("ordinary queue is bounded and timed out jobs are removed", async () => {
  const { db } = await database({ writeQueueLimit: 1, queueWaitMs: 20 });
  const entered = deferred(), release = deferred();
  const running = db.write(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const queued = db.write(async () => {});
  const timeout = expect(queued).rejects.toMatchObject({ code: "DB_QUEUE_TIMEOUT" });
  await expect(db.write(async () => {})).rejects.toMatchObject({ code: "DB_FULL" });
  await timeout;
  expect(db.metrics().writer.generalQueued).toBe(0);
  release.resolve();
  await running;
});

test("critical writes have priority with at most one pending operation per source", async () => {
  const { db } = await database();
  const entered = deferred(), release = deferred(), order: string[] = [];
  const running = db.write(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const ordinary = db.write(async () => { order.push("ordinary"); });
  const cmc = db.write(async () => { order.push("cmc"); }, undefined, "cmc");
  const sync = db.write(async () => { order.push("sync"); }, undefined, "sync");
  await expect(db.write(async () => {}, undefined, "cmc")).rejects.toMatchObject({ code: "DB_CRITICAL_SOURCE_CONFLICT" });
  release.resolve();
  await Promise.all([running, ordinary, cmc, sync]);
  expect(order).toEqual(["cmc", "sync", "ordinary"]);
});

test("started writes ignore client cancellation; close drains them and is idempotent", async () => {
  const { db } = await database();
  const controller = new AbortController(), entered = deferred(), release = deferred();
  const writing = db.write(async sql => {
    entered.resolve();
    await release.promise;
    return sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('committed','hash',1)");
  }, controller.signal);
  await entered.promise;
  controller.abort();
  const closing = db.close();
  expect(db.close()).toBe(closing);
  await expect(db.read(async () => 1)).rejects.toMatchObject({ code: "DB_CLOSED" });
  release.resolve();
  expect(await writing).toMatchObject({ changes: 1 });
  await closing;
});

test("stopAccept rejects ordinary work while final critical writes can complete", async () => {
  const { db } = await database();
  db.stopAccept();
  await expect(db.write(async () => {})).rejects.toMatchObject({ code: "DB_CLOSED" });
  await expect(db.write(async () => 4, undefined, "cmc")).resolves.toBe(4);
});

test("slow SQL times out on its reader while the other reader remains available", async () => {
  const { db } = await database({ readTimeoutMs: 40 });
  const entered = deferred();
  const slow = db.read(sql => {
    entered.resolve();
    return sql.get("WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<100000000) SELECT SUM(v) FROM n");
  });
  const timedOut = expect(slow).rejects.toMatchObject({ code: "DB_QUERY_TIMEOUT" });
  await entered.promise;
  expect(await db.read(sql => sql.get("SELECT 5 AS value"))).toEqual({ value: 5 });
  await timedOut;
  expect(await db.read(sql => sql.get("SELECT 6 AS value"))).toEqual({ value: 6 });
});

test("write timeout rolls back the whole transaction and releases a healthy writer", async () => {
  const onFatal = jest.fn();
  const { db } = await database({ writeTimeoutMs: 20, onFatal });
  const entered = deferred();
  const writing = db.write(async sql => {
    await sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('before-timeout','hash',1)");
    entered.resolve();
    await sql.run(
      "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<500000) INSERT INTO users(login,password_hash,created_at) SELECT CAST(v AS TEXT),'hash',1 FROM n",
    );
  });
  const timedOut = expect(writing).rejects.toMatchObject({ code: "DB_QUERY_TIMEOUT" });
  await entered.promise;
  const next = db.write(sql => sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('committed','hash',1)"));
  expect(db.metrics().writer.generalQueued).toBe(1);
  await Promise.all([timedOut, expect(next).resolves.toMatchObject({ changes: 1 })]);
  expect(onFatal).not.toHaveBeenCalled();
  expect(await db.read(sql => sql.all("SELECT login FROM users"))).toEqual([{ login: "committed" }]);
});

test("close waits for a timed-out writer to roll back and prevents its next statement", async () => {
  const onFatal = jest.fn();
  const { db, path } = await database({ writeTimeoutMs: 20, onFatal });
  const entered = deferred(), release = deferred();
  let nextStatement!: Promise<unknown>;
  const writing = db.write(async sql => {
    await sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('rollback','hash',1)");
    entered.resolve();
    await release.promise;
    nextStatement = sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('too-late','hash',1)");
    await nextStatement;
  });
  const timedOut = expect(writing).rejects.toMatchObject({ code: "DB_QUERY_TIMEOUT" });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 40));
  let closed = false;
  const closing = db.close().then(() => { closed = true; });
  try {
    await expect(db.read(async () => 1)).rejects.toMatchObject({ code: "DB_CLOSED" });
    expect(closed).toBe(false);
    expect(db.metrics().writer.active).toBe(1);
  } finally { release.resolve(); }
  await Promise.all([timedOut, closing]);
  await expect(nextStatement).rejects.toMatchObject({ code: "DB_QUERY_TIMEOUT" });
  expect(onFatal).not.toHaveBeenCalled();
  const reopened = await openDatabase(path);
  try {
    expect(await reopened.read(sql => sql.all("SELECT login FROM users"))).toEqual([]);
  } finally { await reopened.close(); }
});

test("finish drains a statement even when the callback forgets to await it", async () => {
  const { db } = await database();
  let executor!: SqlExecutor;
  await db.write(async sql => {
    executor = sql;
    void sql.run("INSERT INTO users(login,password_hash,created_at) VALUES('drained','hash',1)");
  });
  expect(await db.read(sql => sql.get("SELECT login FROM users"))).toEqual({ login: "drained" });
  await expect(executor.get("SELECT 1")).rejects.toMatchObject({ code: "DB_OPERATION_CLOSED" });
});

test("nested operations reject rather than deadlock", async () => {
  const { db } = await database();
  await expect(db.write(async () => db.read(async () => 1))).rejects.toMatchObject({ code: "DB_NESTED_OPERATION" });
  expect(await db.read(sql => sql.get("SELECT 1 AS value"))).toEqual({ value: 1 });
});

test("unconfirmed transaction cleanup fails closed", async () => {
  const onFatal = jest.fn();
  const { db } = await database({ onFatal });
  await expect(db.write(async sql => {
    await sql.run("COMMIT");
    throw new Error("force rollback after an unexpected commit");
  })).rejects.toMatchObject({ code: "DB_TRANSCATION_FAIL" });
  expect(onFatal).toHaveBeenCalledTimes(1);
  await expect(db.read(async () => 1)).rejects.toMatchObject({ code: "DB_TRANSCATION_FAIL" });
});
