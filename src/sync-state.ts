import type { SqlExecutor, Storage } from "./db";
import { AppError } from "./errors";
import type { SyncResult, SyncState } from "./types";

export class SyncStateRepository {
  constructor(private readonly db: Storage) {}

  initialize(): Promise<void> {
    return this.db.write(async (sql) => {
      await sql.run(
        "UPDATE sync_state SET status='interrupted', last_error_code='SYNC_INTERRUPTED' WHERE status='running'",
      );
      await sql.run(
        "UPDATE sync_state SET blocked_until=NULL, status='idle', last_error_code=NULL WHERE last_error_code='CMC_AUTH_FAILED'",
      );
    });
  }

  state(): Promise<SyncState> {
    return this.db.read((sql) => this.stateFrom(sql));
  }

  async stateFrom(sql: SqlExecutor): Promise<SyncState> {
    const row = (await sql.get("SELECT * FROM sync_state WHERE id=1"))!;
    return {
      scheduledAt: Number(row.scheduled_at),
      lastStartedAt:
        row.last_started_at === null ? null : Number(row.last_started_at),
      lastFinishedAt:
        row.last_finished_at === null ? null : Number(row.last_finished_at),
      lastSuccessAt:
        row.last_success_at === null ? null : Number(row.last_success_at),
      status: String(row.status),
      consecutiveFailures: Number(row.consecutive_failures),
      lastErrorCode:
        row.last_error_code === null ? null : String(row.last_error_code),
      blockedUntil:
        row.blocked_until === null ? null : Number(row.blocked_until),
    };
  }

  start(
    now: number,
    intervalMs: number,
  ): Promise<{ previous: SyncState; upperId: number }> {
    return this.db.write(async (sql) => {
      const prev = await this.stateFrom(sql);
      await sql.run(
        "UPDATE sync_state SET scheduled_at=?,  last_started_at=?, status='running', blocked_until=NULL WHERE id=1",
        [now + intervalMs, now],
      );
      return {
        previous: prev,
        upperId: (await sql.get<{ upperId: number }>(
          "SELECT COALESCE(MAX(id),0) AS upperId FROM active_tracking",
        ))!.upperId,
      };
    });
  }

  success(
    startedAt: number,
    finishedAt: number,
    intervalMs: number,
    result: SyncResult,
  ): Promise<void> {
    const nextRunAt =
      startedAt +
      (Math.floor((finishedAt - startedAt) / intervalMs) + 1) * intervalMs;
    return this.db.write(
      async (sql) => {
        await sql.run(
          `UPDATE sync_state SET scheduled_at=?, last_finished_at=?, last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
           status=?, consecutive_failures=0, last_error_code=?, blocked_until=NULL WHERE id=1`,
          [
            nextRunAt,
            finishedAt,
            result.status === "success" ||
            result.inserted + result.duplicates > 0
              ? 1
              : 0,
            finishedAt,
            result.status,
            result.status === "parted" ? "CMC_PARTIAL_RESPONSE" : null,
          ],
        );
      },
      undefined,
      "sync",
    );
  }

  failure(
    finishedAt: number,
    intervalMs: number,
    previous: SyncState,
    failure: AppError,
  ): Promise<void> {
    const failures = previous.consecutiveFailures + 1;
    const delay = Math.max(
      intervalMs,
      Math.min(3600000, intervalMs * 2 ** Math.min(failures - 1, 10)),
    );
    return this.db.write(
      async (sql) => {
        await sql.run(
          `UPDATE sync_state SET scheduled_at=?, last_finished_at=?, status=?, consecutive_failures=?,
           last_error_code=?, blocked_until=? WHERE id=1`,
          [
            Math.max(finishedAt + delay, failure.retryAt ?? 0),
            finishedAt,
            failure.pause ? "paused" : "failed",
            failures,
            failure.code,
            failure.retryAt ?? null,
          ],
        );
      },
      undefined,
      "sync",
    );
  }
}
