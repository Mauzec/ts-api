import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config";
import { openDatabase } from "../src/db";
import type { Logger } from "../src/logger";
import type {
  Candidate,
  PriceProvider,
  Quote,
  QuotesResult,
  RequestContext,
} from "../src/types";

export const logger: Logger = { log: jest.fn() };
export const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig({ CMC_API_KEY: "test-cmc-key" }),
  ...overrides,
});
export async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tracker-cryptocurr-434244"));
  const path = join(directory, "test.sqlite");
  const db = await openDatabase(path);
  return {
    db,
    path,
    async close() {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function quote(cmcId = 1, at = Date.now(), price = 100): Quote {
  return {
    cmcId,
    name: `Coin ${cmcId}`,
    slug: `coin-${cmcId}`,
    price,
    quotedAt: at,
    receivedAt: at,
  };
}
export class FakeProvider implements PriceProvider {
  prices = jest.fn(
    async (ids: number[], _context: RequestContext): Promise<QuotesResult> => ({
      quotes: ids.map((id) => quote(id)),
      errorIds: [],
    }),
  );
  resolveSlug = jest.fn(
    async (_slug: string, _context: RequestContext): Promise<Candidate[]> => [
      { cmcId: 1, name: "Bitcoin", slug: "bitcoin" },
    ],
  );
  private persistence: Promise<void> = Promise.resolve();
  async withPrices<T>(
    ids: number[],
    context: RequestContext,
    consume: (result: QuotesResult) => Promise<T>,
  ): Promise<T> {
    const quotes = await this.prices(ids, context);
    const result = this.persistence.then(() => consume(quotes));
    this.persistence = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  stop = jest.fn();
  idle = jest.fn(async (): Promise<void> => {});
}

export async function seedUser(
  db: import("../src/db").Storage,
  login = "fixture-user",
  passwordHash = "fixture-unusable",
): Promise<number> {
  return db.write(
    async (sql) =>
      (
        await sql.run(
          "INSERT INTO users(login,password_hash,created_at) VALUES(?,?,?)",
          [login, passwordHash, Date.now()],
        )
      ).lastID,
  );
}
export async function seedKey(
  db: import("../src/db").Storage,
  userId: number,
  permission: "r" | "rw" = "rw",
  name = "fixture",
) {
  const { randomBytes, createHash } = await import("node:crypto");
  const apiKey = randomBytes(32).toString("base64url");
  const id = await db.write(
    async (sql) =>
      (
        await sql.run(
          "INSERT INTO api_keys(user_id,name,key_hash,permission,created_at) VALUES(?,?,?,?,?)",
          [
            userId,
            name,
            createHash("sha256").update(apiKey).digest("hex"),
            permission,
            Date.now(),
          ],
        )
      ).lastID,
  );
  return { id, apiKey };
}
