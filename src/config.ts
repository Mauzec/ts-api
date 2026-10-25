import { isLogLevel, LogLevel } from "./logger";

export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  shutDownMs: number;

  // cmc settings
  cmcApiKey: string;
  cmcPriceSyncIntervalMs: number;
  cmcPriceSyncEnabled: boolean;
  cmcTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cmcPriceSyncEnabled = env.CMC_PRICE_SYNC_ENABLED ?? "true";
  if (cmcPriceSyncEnabled !== "true" && cmcPriceSyncEnabled !== "false") {
    throw new Error(`Invalid PRICE_SYNC_ENABLED`);
  }

  const logLevel = env.LOG_LEVE ?? "debug";
  if (!isLogLevel(logLevel)) throw new Error("Invalid LOG_LEVEL");

  const dbPath = env.DB_PTH ?? "./data/db.sqlite";
  if (!dbPath.trim() || dbPath === ":memory:")
    throw new Error("Invalid DB_PATH");

  const cmcApiKey = validateSecret(env, "CMC_API_KEY", 8);
  const host = env.HOST ?? "127.0.0.1";

  return {
    dbPath: dbPath,
    host: host,
    port: validateInteger(env, "PORT", 5000, 15000, 8599),
    shutDownMs: validateInteger(env, "SHUTDOWN_MS", 10000, 1000000, 100000),
    logLevel: logLevel,
    cmcApiKey: cmcApiKey,
    cmcPriceSyncEnabled: cmcPriceSyncEnabled === "true",
    cmcPriceSyncIntervalMs: validateInteger(
      env,
      "CMC_PRICE_SYNC_INTERVAL_MS",
      60000,
      800000000,
      1000000,
    ),
    cmcTimeoutMs: validateInteger(env, "CMC_SHUTDOWN_MS", 5000, 100000, 6000),
  };
}

function validateSecret(
  env: NodeJS.ProcessEnv,
  key: string,
  min: number,
): string {
  const v = env[key];

  // dont want spaces in secrets
  if (!v || v.length < min || v.length > 512 || /\s/.test(v))
    throw new Error(`Invalid ${key}`);
  return v;
}

function validateInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  min: number,
  max: number,
  fb: number,
): number {
  const rv = env[key] ?? String(fb);
  const v = Number(rv);

  if (!/^\d+$/.test(rv) || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new Error(`Invalid ${key}`);
  }
  return v;
}
