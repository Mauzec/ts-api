import { SyncService } from "./services";
import type { Logger } from "./logger";

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private enabled = false;
  private retryNotBefore = 0;
  private generation = 0;
  constructor(
    private readonly sync: SyncService,
    private readonly logger: Logger,
    private readonly now = Date.now,
  ) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.sync.onSettled = () => {
      void this.arm();
    };
    void this.arm();
  }

  private async arm(): Promise<void> {
    const generation = ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled || this.sync.isRunning) return;
    let state;
    try {
      state = await this.sync.state();
    } catch {
      if (!this.enabled || generation !== this.generation) return;
      this.logger.log("error", "scheduler_state_unavailable");
      this.timer = setTimeout(() => {
        void this.arm();
      }, 60000);
      return;
    }
    if (!this.enabled || generation !== this.generation || this.sync.isRunning)
      return;
    if (state.status === "paused" && state.blockedUntil === null) return;
    const due = Math.max(
      state.scheduledAt,
      state.blockedUntil ?? 0,
      this.retryNotBefore,
    );
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.enabled || generation !== this.generation) return;
        if (due > this.now()) {
          void this.arm();
          return;
        }
        void this.sync.run().catch((error) => {
          this.logger.log("debug", "scheduler_attempt_finished", {
            code:
              error instanceof Error && "code" in error
                ? error.code
                : "INTERNAL_ERROR",
          });

          this.retryNotBefore = this.now() + 60000;
          void this.arm();
        });
      },
      Math.max(0, Math.min(due - this.now(), 2147483647)),
    );
  }

  stop(): void {
    this.enabled = false;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sync.onSettled = undefined;
  }
}
