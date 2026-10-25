export interface Asset {
  id: number;
  cmcId: number;

  slug: string;
  name: string;
  displayName: string | null; // name that user set

  createdAt: number;
  updatedAt: number;

  cryptoId: number;
  lastCheckedAt: number | null;
}

export interface AssetPatch {
  displayName: string | null;
  // may be will be more than one param
}

export interface HistoryQuery {
  from?: number;
  to?: number;
  after?: number;
  limit: number;
}

export interface ListQuery {
  afterId: number;
  limit: number;
}

export interface Quote {
  cmcId: number;
  slug: string;
  name: string;
  price: number;

  quotedAt: number;
  receivedAt: number;
}

export interface PricePoint {
  price: number;
  quotedAt: number;
  receivedAt: number;
}

export interface Candle {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
}

export interface Candidate {
  cmcId: number;
  slug: string;
  name: string;
}

export interface RequestContext {
  requestId: string;
}

export interface QuotesResult {
  quotes: Quote[];
  errorIds: number[];
}

export interface PriceProvider {
  resolveSlug(slug: string, context: RequestContext): Promise<Candidate[]>;
  withPrices<T>(
    ids: number[],
    context: RequestContext,
    after: (result: QuotesResult) => Promise<T>,
  ): Promise<T>;

  stop(): void;
  idle(): Promise<void>;
}

export interface SaveResult {
  inserted: number;
  duplicates: number;
  outdated: number;
  conflicts: number;
  discarded: number;
}

export interface SyncResult extends SaveResult {
  runId: string;
  requested: number;
  invalid: number;
  batches: number;
  status: "success" | "parted" | "empty";
}

export interface SyncState {
  scheduledAt: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  status: string;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  blockedUntil: number | null;
}
