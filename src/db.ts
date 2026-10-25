import { createHistogram } from "perf_hooks";
import {
  Database,
  OPEN_CREATE,
  OPEN_FULLMUTEX,
  OPEN_READONLY,
  OPEN_READWRITE,
  Statement,
} from "sqlite3";
import { AppError } from "./errors";
import { AsyncLocalStorage } from "async_hooks";
import { clearTimeout } from "timers";
import { mkdir } from "fs/promises";
import { dirname, resolve } from "path";

class DurationMetrics {
  private readonly hist = createHistogram();
  private totalMs = 0;

  record(from: number): void {
    const time = performance.now() - from;
    this.totalMs += time;

    this.hist.record(Math.max(Math.round(1e6 * time), 1));
  }
  snapshot() {
    return {
      count: this.hist.count,
      totalMs: this.totalMs,

      p50Ms: this.hist.count ? this.hist.percentile(50) / 1e6 : 0,
      p90Ms: this.hist.count ? this.hist.percentile(90) / 1e6 : 0,
      p95Ms: this.hist.count ? this.hist.percentile(95) / 1e6 : 0,
      p99Ms: this.hist.count ? this.hist.percentile(99) / 1e6 : 0,
      maxMs: this.hist.count ? this.hist.max / 1e6 : 0,
    };
  }
}

export type SqlValue = string | number | null | Buffer;

export class SqlExecutor {
  private working = true;
  private pending = new Set<Promise<unknown>>();
  private error: unknown;

  constructor(
    private readonly db: Database,
    private readonly check: () => void = () => {},
    private readonly metrics = new DurationMetrics(),
  ) {}

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get<T = Record<string, unknown>>(
    q: string,
    values: SqlValue[] = [],
  ): Promise<T | undefined> {
    return this.query(
      q,
      values,
      (statement) =>
        new Promise<T | undefined>((resolve, reject) => {
          return statement.get<T>(values, (error, row) =>
            error ? reject(error) : resolve(row),
          );
        }),
    );
  }

  all<T = Record<string, unknown>>(
    q: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.query(
      q,
      values,
      (statement) =>
        new Promise<T[]>((resolve, reject) => {
          return statement.all<T>(values, (error, rows) =>
            error ? reject(error) : resolve(rows),
          );
        }),
    );
  }

  run(
    q: string,
    values: SqlValue[] = [],
  ): Promise<{ lastID: number; changes: number }> {
    return this.query(
      q,
      values,
      (statement) =>
        new Promise((resolve, reject) => {
          return statement.run(values, function (error) {
            if (error) reject(error);
            else resolve({ lastID: this.lastID, changes: this.changes });
          });
        }),
    );
  }

  async finish(): Promise<void> {
    this.working = false;
    await Promise.allSettled(this.pending);
    if (this.error !== undefined) throw this.error;
  }

  private query<T>(
    q: string,
    values: SqlValue[],
    operation: (statement: Statement) => Promise<T>,
  ): Promise<T> {
    return this.track(async () => {
      let statement!: Statement;

      await new Promise<void>((resolve, reject) => {
        statement = this.db.prepare(q, (error) => {
          return error ? reject(error) : resolve();
        });
      });

      try {
        this.check();
        return await operation(statement);
      } finally {
        await new Promise<void>((resolve, reject) => {
          return statement.finalize((error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
    });
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.working)
      return Promise.reject(
        failure("DB_OPERATION_CLOSED", "DB operation has ended"),
      );
    if (this.busy)
      return Promise.reject(
        failure(
          "DB_CONCURRENT_STATEMENT",
          "Statementss in one operation must be waited",
        ),
      );

    const t1 = performance.now();

    const pending = (async () => {
      this.check();
      const res = await operation();
      this.check();
      return res;
    })().catch((re) => {
      const sre = toError(re);
      this.error ??= sre;
      throw sre;
    });
    this.pending.add(pending);

    void pending.then(
      () => {
        this.pending.delete(pending);
        this.metrics.record(t1);
      },
      () => {
        this.pending.delete(pending);
        this.metrics.record(t1);
      },
    );

    return pending;
  }
}

// use only two types for now
type CriticalWriteSource = "cmc" | "sync";

interface Job {
  operation: (sqlexec: SqlExecutor) => Promise<unknown>;

  resolve: (v: unknown) => void;
  reject: (error: unknown) => void;

  signal: AbortSignal | undefined;
  criticalWriteSource: CriticalWriteSource | undefined;

  queuedAt: number;

  cleanup: () => void;
}

interface ConnectionPool {
  generalQueue: Job[];
  criticalQueue: Job[];
  connections: Database[];

  limit: number;
  active: number;
}

interface StorageOptions {
  queueWaitMs?: number;

  readTimeoutMs?: number;
  readQueueLimit?: number;

  writeTimeoutMs?: number;
  writeQueueLimit?: number;

  onFatal?: (error: Error) => void;
}

export class Storage {
  private readonly storageContext = new AsyncLocalStorage<{
    active: boolean;
  }>();

  private readonly readers: ConnectionPool;
  private readonly writer: ConnectionPool;

  private readonly criticalWriteSources = new Set<CriticalWriteSource>();

  private readonly waiting = new DurationMetrics();
  private readonly sql = new DurationMetrics();
  private readonly reads = new DurationMetrics();
  private readonly writes = new DurationMetrics();

  private accepting = true;
  private closing: Promise<void> | undefined;
  private fatal: Error | undefined;
  private idleWaiters: (() => void)[] = [];

  // first connection is always for writing
  constructor(
    private readonly connections: Database[],
    private readonly options: StorageOptions = {},
  ) {
    this.writer = {
      connections: [connections[0]!],
      generalQueue: [],
      criticalQueue: [],

      limit: options.writeQueueLimit ?? 128,
      active: 0,
    };

    this.readers = {
      connections: connections.slice(1),
      generalQueue: [],
      criticalQueue: [],
      limit: options.readQueueLimit ?? 256,
      active: 0,
    };
  }

  read<T>(
    operation: (sqleec: SqlExecutor) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(this.readers, operation, signal);
  }

  write<T>(
    operation: (sqleec: SqlExecutor) => Promise<T>,
    signal?: AbortSignal,
    criticalSource?: CriticalWriteSource,
  ): Promise<T> {
    return this.enqueue(this.writer, operation, signal, criticalSource);
  }

  stopAccept(): void {
    this.accepting = false;
    for (const pool of [this.writer, this.readers]) {
      for (const job of pool.generalQueue.splice(0)) {
        job.cleanup();
        job.reject(failure("DB_CLOSED", "Database is stopping"));
      }
    }
    this.notifyIdle();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;

    this.stopAccept();
    this.closing = (async () => {
      await this.idle();

      const res = await Promise.allSettled(this.connections.map(dbClose));
      if (res.some((r) => r.status === "rejected"))
        throw failure("DB_CLOSE_FAILED", "Database cannot close");
    })();
    return this.closing;
  }

  metrics() {
    const pool = (cp: ConnectionPool) => ({
      active: cp.active,
      generalQueued: cp.generalQueue.length,
      criticalQueued: cp.criticalQueue.length,
      limit: cp.limit,
    });
    return {
      readers: pool(this.readers),
      writer: pool(this.writer),
      queueWaiting: this.waiting.snapshot(),
      sql: this.sql.snapshot(),
      reads: this.reads.snapshot(),
      writes: this.writes.snapshot(),
    };
  }

  private enqueue<T>(
    pool: ConnectionPool,
    operation: (sqlexec: SqlExecutor) => Promise<T>,
    signal?: AbortSignal,
    criticalSource?: CriticalWriteSource,
  ): Promise<T> {
    if (this.storageContext.getStore()?.active)
      return Promise.reject(
        failure("DB_NESTED_OPERATION", "Detected nested work"),
      );

    if (this.fatal) return Promise.reject(this.fatal);
    if (this.closing || (!this.accepting && !criticalSource))
      return Promise.reject(
        failure("DB_CLOSED", "Database is closing or closed"),
      );
    if (!criticalSource && signal?.aborted)
      return Promise.reject(
        failure("DB_CANCELLED", "Database operation is cancelled"),
      );
    if (criticalSource && this.criticalWriteSources.has(criticalSource))
      return Promise.reject(
        failure(
          "DB_CRITICAL_SOURCE_CONFLICT",
          "Critical operations must run sequentially",
        ),
      );

    if (
      !criticalSource &&
      !pool.connections.length &&
      pool.generalQueue.length >= pool.limit
    )
      return Promise.reject(failure("DB_FULL", "Database queue is full"));

    return new Promise<T>((resolve, reject) => {
      if (criticalSource) this.criticalWriteSources.add(criticalSource);
      const job: Job = {
        operation: operation,
        resolve: (v) => resolve(v as T),
        reject: reject,
        signal: criticalSource ? undefined : signal,
        criticalWriteSource: criticalSource,
        queuedAt: performance.now(),
        cleanup: () => {},
      };

      if (pool.connections.length) {
        this.start(pool, pool.connections.pop()!, job);
        return;
      }

      const queue = criticalSource ? pool.criticalQueue : pool.generalQueue;
      queue.push(job);
      if (criticalSource) return;

      const remove = (error: Error): void => {
        const idx = queue.indexOf(job);
        if (idx == -1) return;

        queue.splice(idx, 1);
        job.cleanup();
        reject(error);
        this.notifyIdle();
      };

      const timer = setTimeout(
        () => remove(failure("DB_QUEUE_TIMEOUT", "Database queue timeout")),
        this.options.queueWaitMs ?? 2500,
      );

      const cancel = (): void =>
        remove(failure("DB_CANCELLED", "Database operation is cancelled"));
      job.cleanup = () => {
        clearTimeout(timer);
        job.signal?.removeEventListener("abort", cancel);
      };
      job.signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private start(pool: ConnectionPool, db: Database, job: Job): void {
    job.cleanup();
    pool.active++;
    this.waiting.record(job.queuedAt);

    const release = (): void => {
      pool.active--;
      if (job.criticalWriteSource)
        this.criticalWriteSources.delete(job.criticalWriteSource);
      const next = pool.criticalQueue.shift() ?? pool.generalQueue.shift();

      if (next) this.start(pool, db, next);
      else pool.connections.push(db);

      this.notifyIdle();
    };
    void this.execute(pool, db, job).then(
      (result) => {
        release();
        job.resolve(result);
      },
      (error) => {
        release();
        job.reject(error);
      },
    );
  }

  private async execute(
    pool: ConnectionPool,
    db: Database,
    job: Job,
  ): Promise<unknown> {
    const t1 = performance.now();

    let reason: AppError | undefined;
    let timer: NodeJS.Timeout | undefined;
    const storageContextOptions = { active: true };

    const checkError = (): void => {
      if (reason) throw reason;
    };

    const sqlexec = new SqlExecutor(db, checkError, this.sql);

    const stop = (error: AppError): void => {
      reason ??= error;
      if (pool !== this.writer && sqlexec.busy) db.interrupt();
    };
    const stopByCancelled = (): void => {
      return stop(failure("DB_CANCELLED", "Database operation is cancelled"));
    };

    if (pool !== this.writer) {
      if (job.signal?.aborted) stopByCancelled();

      job.signal?.addEventListener("abort", stopByCancelled, { once: true });
      // 6 sec timeout
      timer = setTimeout(
        () => stop(failure("DB_QUERY_TIMEOUT", "Database timeout")),
        this.options.readTimeoutMs ?? 6000,
      );
    } else {
      timer = setTimeout(
        () => stop(failure("DB_QUERY_TIMEOUT", "Database timeout")),
        this.options.writeTimeoutMs ?? 10000,
      );
    }

    let began = false;
    const cleanupCancel = (): void => {
      if (timer) clearTimeout(timer);
      job.signal?.removeEventListener("abort", stopByCancelled);
    };
    try {
      checkError();

      await dbExec(db, pool !== this.writer ? "BEGIN" : "BEGIN IMMEDIATE");

      began = true;
      const res = await this.storageContext.run(storageContextOptions, () =>
        job.operation(sqlexec),
      );
      await sqlexec.finish();

      checkError();
      cleanupCancel();
      await dbExec(db, "COMMIT");

      began = false;
      return res;
    } catch (e) {
      cleanupCancel();
      await sqlexec.finish().catch(() => {});

      if (began) {
        try {
          await dbExec(db, "ROLLBACK");
        } catch {
          this.processFail(
            failure("DB_TRANSCATION_FAIL", "Database transaction failure"),
          );
          throw this.fatal;
        }
      }
      throw reason ?? toError(e);
    } finally {
      storageContextOptions.active = false;
      (pool !== this.writer ? this.reads : this.writes).record(t1);
    }
  }

  private processFail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    this.accepting = false;

    for (const pool of [this.writer, this.readers]) {
      for (const job of [
        ...pool.generalQueue.splice(0),
        ...pool.criticalQueue.splice(0),
      ]) {
        job.cleanup();
        if (job.criticalWriteSource)
          this.criticalWriteSources.delete(job.criticalWriteSource);
        job.reject(error);
      }
    }
    this.options.onFatal?.(error);
  }

  private notifyIdle(): void {
    if (
      [this.readers, this.writer].every(
        (pool) =>
          !pool.active &&
          !pool.generalQueue.length &&
          !pool.criticalQueue.length,
      )
    ) {
      for (const resolve of this.idleWaiters.splice(0)) {
        resolve();
      }
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.notifyIdle();
    });
  }
}

export async function openDatabase(
  filename: string,
  options: StorageOptions = {},
): Promise<Storage> {
  if (filename === ":memory:") throw new Error("Memory mode is disabled");
  await mkdir(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const connections: Database[] = [];
  try {
    const writer = await dbOpen(
      filename,
      OPEN_READWRITE | OPEN_CREATE | OPEN_FULLMUTEX,
    );
    connections.push(writer);

    await dbExec(
      writer,
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=6000;",
    );

    await dbExec(writer, "BEGIN IMMEDIATE");
    try {
      const sql = new SqlExecutor(writer);
      try {
        const version = (await sql.get<{ user_version: number }>(
          "PRAGMA user_version",
        ))!.user_version;
        if (version === 0) {
          const existing = await sql.get(
            "SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
          );
          if (existing)
            throw failure(
              "DB_SCHEMA_UNSUPPORTED",
              "Unsupported database schema: unversioned database is not empty",
            );
          await dbExec(writer, schema);
          await dbExec(writer, "PRAGMA user_version=1");
        } else if (version !== 1) {
          throw failure(
            "DB_SCHEMA_UNSUPPORTED",
            "Unsupported database schema version",
          );
        }
      } finally {
        await sql.finish();
      }
      await dbExec(writer, "COMMIT");
    } catch (error) {
      await dbExec(writer, "ROLLBACK");
      throw error;
    }

    for (let i = 0; i < 2; i++) {
      const reader = await dbOpen(filename, OPEN_READONLY);
      connections.push(reader);
      await dbExec(
        reader,
        "PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA busy_timeout=6000;",
      );
    }
    return new Storage(connections, options);
  } catch (e) {
    await Promise.allSettled(connections.map(dbClose));
    throw e;
  }
}

const failure = (code: string, message: string): AppError =>
  new AppError(503, code, message);

function toError(error: unknown): Error {
  if (error instanceof AppError) return error;

  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    ? failure("DB_BUSY", "Database is busy")
    : failure("DB_ERROR", "Database operation failed");
}

function dbExec(db: Database, q: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(q, (error) => (error ? reject(error) : resolve()));
  });
}
function dbClose(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function dbOpen(filename: string, mode: number): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new Database(filename, mode, (error) =>
      error ? reject(toError(error)) : resolve(db),
    );
  });
}

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    permission TEXT NOT NULL CHECK(permission IN ('r', 'rw')),
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name)
  ) STRICT;
  
  CREATE TABLE cryptocurrencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cmc_id INTEGER NOT NULL UNIQUE CHECK(cmc_id > 0),
    slug TEXT NOT NULL, 
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS user_currencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    cryptocurrency_id INTEGER NOT NULL REFERENCES cryptocurrencies(id) ON DELETE RESTRICT,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, cryptocurrency_id)
  ) STRICT;
   CREATE INDEX user_currencies_user_id ON user_currencies(user_id, id);

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cryptocurrency_id INTEGER NOT NULL REFERENCES cryptocurrencies(id) ON DELETE RESTRICT,
    price REAL NOT NULL CHECK(price >= 0),
    quoted_at INTEGER NOT NULL CHECK(quoted_at >= 0),
    received_at INTEGER NOT NULL,
    UNIQUE(cryptocurrency_id, quoted_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    scheduled_at INTEGER NOT NULL DEFAULT(0),
    last_started_at INTEGER,
    last_finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'idle',
    last_success_at INTEGER,
    last_error_code TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,

    blocked_until INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS active_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cryptocurrency_id INTEGER NOT NULL UNIQUE REFERENCES cryptocurrencies(id) ON DELETE RESTRICT,
    sub_count INTEGER NOT NULL CHECK(sub_count > 0)
  ) STRICT;

  INSERT INTO sync_state(id) VALUES(1);
`;
