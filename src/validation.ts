import { AppError } from "./errors";
import type { AssetPatch, HistoryQuery, ListQuery } from "./types";

export function invalid(message: string): never {
  throw new AppError(400, "INVALID_INPUT", message);
}

export function fields(
  value: unknown,
  allowed: readonly string[],
  label = "body",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!allowed.includes(key)) invalid(`Unknown ${label} field: ${key}`);
  return result;
}

export function emptyBody(value: unknown): void {
  if (value !== undefined) fields(value, []);
}

function scalar(value: unknown, label: string): string {
  if (typeof value !== "string")
    invalid(`${label} must occur once and be a string`);
  return value;
}

export function id(value: unknown, label = "id"): number {
  const raw = scalar(value, label);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    invalid(`${label} must be a positive safe integer`);
  return Number(raw);
}

function queryInteger(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const raw = scalar(value, label);
  const parsed = Number(raw);
  if (
    !/^(0|[1-9]\d*)$/.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  )
    invalid(`Invalid ${label}`);
  return parsed;
}

export function date(value: unknown, label: string): number {
  const raw = scalar(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      raw,
    );
  if (!match) invalid(`${label} must be an ISO 8601 timestamp with timezone`);
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[8]!;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    invalid(`Invalid ${label}`);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) invalid(`Invalid ${label}`);
  return parsed;
}

function displayName(value: unknown): string | null {
  if (value === null) return null;
  const raw = scalar(value, "displayName");
  const trimmed = raw.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 120 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(raw) ||
    Buffer.from(raw).toString("utf8") !== raw
  )
    invalid("displayName must contain 1–120 characters without controls");
  return trimmed;
}

export function createInput(value: unknown): {
  cmcId?: number;
  slug?: string;
  displayName?: string | null;
} {
  const body = fields(value, ["cmcId", "slug", "displayName"]);
  if (Object.hasOwn(body, "cmcId") === Object.hasOwn(body, "slug"))
    invalid("Provide exactly one of cmcId or slug");
  const result: { cmcId?: number; slug?: string; displayName?: string | null } =
    {};
  if (Object.hasOwn(body, "cmcId")) {
    if (
      typeof body.cmcId !== "number" ||
      !Number.isSafeInteger(body.cmcId) ||
      body.cmcId <= 0
    )
      invalid("cmcId must be a positive safe integer");
    result.cmcId = body.cmcId;
  } else {
    const slug = scalar(body.slug, "slug").trim().toLowerCase();
    if (slug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      invalid("Invalid slug");
    result.slug = slug;
  }
  if (Object.hasOwn(body, "displayName"))
    result.displayName = displayName(body.displayName);
  return result;
}

export function patchInput(value: unknown): AssetPatch {
  const body = fields(value, ["displayName"]);
  if (!Object.hasOwn(body, "displayName")) invalid("Provide displayName");
  return { displayName: displayName(body.displayName) };
}

export function listQuery(value: unknown): ListQuery {
  const query = fields(value, ["afterId", "limit"], "query");
  return {
    afterId: queryInteger(
      query.afterId,
      "afterId",
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: queryInteger(query.limit, "limit", 100, 1, 500),
  };
}

export function historyQuery(value: unknown): HistoryQuery {
  const query = fields(value, ["from", "to", "after", "limit"], "query");
  const result: HistoryQuery = {
    limit: queryInteger(query.limit, "limit", 100, 1, 500),
  };
  if (query.from !== undefined) result.from = date(query.from, "from");
  if (query.to !== undefined) result.to = date(query.to, "to");
  if (query.after !== undefined) result.after = date(query.after, "after");
  if (
    result.from !== undefined &&
    result.to !== undefined &&
    result.from >= result.to
  )
    invalid("from must precede to");
  return result;
}

export function ohlcQuery(value: unknown): {
  from: number;
  to: number;
  interval: "1h" | "1d";
  bucketMs: number;
} {
  const query = fields(value, ["from", "to", "interval"], "query");
  const from = date(query.from, "from"),
    to = date(query.to, "to");
  const interval = query.interval ?? "1h";
  if (interval !== "1h" && interval !== "1d")
    invalid("interval must be 1h or 1d");
  if (from >= to || to - from > 31 * 86400000)
    invalid("OHLC range must be positive and no longer than 31 days");
  return {
    from,
    to,
    interval,
    bucketMs: interval === "1h" ? 3600000 : 86400000,
  };
}
