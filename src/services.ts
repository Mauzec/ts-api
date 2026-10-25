import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import type { Logger } from "./logger";
import { Repository } from "./repo";
import { SyncStateRepository } from "./sync-state";
import type {
  Asset,
  PriceProvider,
  RequestContext,
  SyncResult,
  SyncState,
} from "./types";

export interface CreateInput {
  cmcId?: number;
  slug?: string;
  displayName?: string | null;
}

interface CreationResult {
  cryptoId: number;
  initial?: Asset;
}

export class TrackingService {
  private readonly creating = new Map<number, Promise<CreationResult>>();

  constructor(
    private readonly repository: Repository,
    private readonly provider: PriceProvider,
    private readonly now = Date.now,
  ) {}

  async create(
    userId: number,
    input: CreateInput,
    context: RequestContext,
  ): Promise<Asset> {
    let cmcId = input.cmcId;
    if (cmcId === undefined) {
      const candidates = await this.provider.resolveSlug(input.slug!, context);
      if (!candidates.length)
        throw new AppError(
          422,
          "UNKNOWN_ASSET",
          "No cryptocurrency matches this slug",
        );
      if (candidates.length > 1)
        throw new AppError(
          409,
          "AMBIGUOUS_SLUG",
          "Use a CMC ID to select the cryptocurrency",
          {
            details: {
              candidates: candidates.slice(0, 20),
              total: candidates.length,
            },
          },
        );
      cmcId = candidates[0]!.cmcId;
    }
    const id = cmcId;
    const existingWork = this.creating.get(id);
    if (existingWork) {
      const result = await existingWork;
      return this.repository.subscribe(
        userId,
        result.cryptoId,
        input.displayName ?? null,
        this.now(),
      );
    }

    const work = Promise.resolve().then(async (): Promise<CreationResult> => {
      const catalog = await this.repository.findByCmcId(id);
      if (catalog?.hasPrice) return { cryptoId: catalog.id };
      return this.provider.withPrices([id], context, async (response) => {
        const quote = response.quotes.find((item) => item.cmcId === id);
        if (!quote)
          throw new AppError(
            422,
            "PRICE_UNAVAILABLE",
            "No valid USD price is available for this cryptocurrency",
          );
        const asset = await this.repository.create(
          userId,
          quote,
          input.displayName ?? null,
          this.now(),
          undefined,
          "cmc",
        );
        return { cryptoId: asset.cryptoId, initial: asset };
      });
    });
    this.creating.set(id, work);
    try {
      const result = await work;
      return (
        result.initial ??
        (await this.repository.subscribe(
          userId,
          result.cryptoId,
          input.displayName ?? null,
          this.now(),
        ))
      );
    } finally {
      if (this.creating.get(id) === work) this.creating.delete(id);
    }
  }
}

export class SyncService {
  private running: Promise<SyncResult> | null = null;
  private stopped = false;
  onSettled: (() => void) | undefined;

  constructor(
    private readonly states: SyncStateRepository,
    private readonly repository: Repository,
    private readonly provider: PriceProvider,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly now = Date.now,
  ) {}

  initialize(): Promise<void> {
    return this.states.initialize();
  }
  get isRunning(): boolean {
    return this.running !== null;
  }
  state(): Promise<SyncState> {
    return this.states.state();
  }

  async run(): Promise<SyncResult> {
    if (this.stopped)
      throw new AppError(503, "SHUTTING_DOWN", "Service is shutting down");
    if (this.running)
      throw new AppError(
        409,
        "SYNC_IN_PROGRESS",
        "A synchronization is already running",
      );

    const work = Promise.resolve().then(() => this.execute());
    this.running = work;
    void work
      .finally(() => {
        this.running = null;
        this.onSettled?.();
      })
      .catch(() => {});
    return work;
  }

  private async execute(): Promise<SyncResult> {
    if (this.stopped)
      throw new AppError(
        503,
        "SHUTTING_DOWN",
        "Synchronization was interrupted",
      );
    const startedAt = this.now();
    const runId = randomUUID();
    const { previous, upperId } = await this.states.start(
      startedAt,
      this.config.cmcPriceSyncIntervalMs,
    );
    const result: SyncResult = {
      runId,
      requested: 0,
      invalid: 0,
      batches: 0,
      inserted: 0,
      duplicates: 0,
      outdated: 0,
      conflicts: 0,
      discarded: 0,
      status: "empty",
    };
    try {
      let cursor = 0;
      for (;;) {
        if (this.stopped)
          throw new AppError(
            503,
            "SHUTTING_DOWN",
            "Synchronization was interrupted",
          );
        const batch = await this.repository.activePage(cursor, upperId);
        if (batch.length === 0) break;
        result.requested += batch.length;
        cursor = batch[batch.length - 1]!.id;
        await this.provider.withPrices(
          batch.map((asset) => asset.cmcId),
          { requestId: runId },
          async (response) => {
            result.batches++;
            result.invalid += response.errorIds.length;
            const saved = await this.repository.saveQuotes(
              batch,
              response.quotes,
              this.now(),
              undefined,
              "cmc",
            );
            for (const key of [
              "inserted",
              "duplicates",
              "outdated",
              "conflicts",
              "discarded",
            ] as const)
              result[key] += saved[key];
          },
        );
      }
      if (result.requested)
        result.status =
          result.invalid +
            result.conflicts +
            result.outdated +
            result.discarded >
          0
            ? "parted"
            : "success";
      const finishedAt = this.now();
      await this.states.success(
        startedAt,
        finishedAt,
        this.config.cmcPriceSyncIntervalMs,
        result,
      );
      this.logger.log(
        result.status === "parted" ? "warn" : "info",
        "sync_finished",
        { ...result, durationMs: finishedAt - startedAt },
      );
      return result;
    } catch (error) {
      const failure =
        error instanceof AppError
          ? error
          : new AppError(500, "SYNC_FAILED", "Synchronization failed");
      await this.states.failure(
        this.now(),
        this.config.cmcPriceSyncIntervalMs,
        previous,
        failure,
      );
      this.logger.log("warn", "sync_failed", {
        runId,
        code: failure.code,
        batches: result.batches,
        inserted: result.inserted,
      });
      throw failure;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
  }
}
