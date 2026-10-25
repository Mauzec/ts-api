import type { SqlExecutor, SqlValue, Storage } from "./db";
import { AppError } from "./errors";
import type {
  Asset,
  AssetPatch,
  Candle,
  HistoryQuery,
  ListQuery,
  PricePoint,
  Quote,
  SaveResult,
} from "./types";

const assetColumns = `uc.id, c.id AS cryptoId, c.cmc_id AS cmcId, c.slug, c.name,
  uc.display_name AS displayName, uc.created_at AS createdAt, uc.updated_at AS updatedAt,
  c.last_checked_at AS lastCheckedAt`;
const assetJoin =
  "user_currencies uc JOIN cryptocurrencies c ON c.id=uc.cryptocurrency_id";
const priceColumns =
  "p.price, p.quoted_at AS quotedAt, p.received_at AS receivedAt";
export interface TrackingSnapshot {
  id: number;
  cryptoId: number;
  cmcId: number;
}
export interface CatalogAsset {
  id: number;
  cmcId: number;
  name: string;
  slug: string;
  lastCheckedAt: number | null;
  hasPrice: boolean;
}
const notFound = (): AppError =>
  new AppError(404, "ASSET_NOT_FOUND", "Cryptocurrency not found");

async function getAsset(
  sql: SqlExecutor,
  userId: number,
  id: number,
): Promise<Asset> {
  const asset = await sql.get<Asset>(
    `SELECT ${assetColumns} FROM ${assetJoin} WHERE uc.user_id=? AND uc.id=?`,
    [userId, id],
  );
  if (!asset) throw notFound();
  return asset;
}

async function subscribe(
  sql: SqlExecutor,
  userId: number,
  cryptoId: number,
  displayName: string | null,
  now: number,
): Promise<Asset> {
  if (
    await sql.get(
      "SELECT id FROM user_currencies WHERE user_id=? AND cryptocurrency_id=?",
      [userId, cryptoId],
    )
  ) {
    throw new AppError(
      409,
      "ASSET_EXISTS",
      "Cryptocurrency is already in your list",
    );
  }
  if (
    !(await sql.get("SELECT id FROM cryptocurrencies WHERE id=?", [cryptoId]))
  )
    throw notFound();
  const { lastID } = await sql.run(
    `INSERT INTO user_currencies(user_id, cryptocurrency_id, display_name, created_at, updated_at)
    VALUES(?,?,?,?,?)`,
    [userId, cryptoId, displayName, now, now],
  );
  await sql.run(
    `INSERT INTO active_tracking(cryptocurrency_id, sub_count) VALUES(?,1)
    ON CONFLICT(cryptocurrency_id) DO UPDATE SET sub_count=sub_count+1`,
    [cryptoId],
  );
  return getAsset(sql, userId, lastID);
}

export class Repository {
  constructor(private readonly db: Storage) {}

  get(userId: number, id: number, signal?: AbortSignal): Promise<Asset> {
    return this.db.read((sql) => getAsset(sql, userId, id), signal);
  }

  findByCmcId(
    cmcId: number,
    signal?: AbortSignal,
  ): Promise<CatalogAsset | undefined> {
    return this.db.read(async (sql) => {
      const asset = await sql.get<
        Omit<CatalogAsset, "hasPrice"> & { hasPrice: number }
      >(
        `SELECT id, cmc_id AS cmcId,
        name, slug, last_checked_at AS lastCheckedAt,
        EXISTS(SELECT 1 FROM price_history WHERE cryptocurrency_id=c.id) AS hasPrice
        FROM cryptocurrencies c WHERE cmc_id=?`,
        [cmcId],
      );
      return asset && { ...asset, hasPrice: Boolean(asset.hasPrice) };
    }, signal);
  }

  subscribe(
    userId: number,
    cryptoId: number,
    displayName: string | null,
    now: number,
    signal?: AbortSignal,
    criticalSource?: Parameters<Storage["write"]>[2],
  ): Promise<Asset> {
    return this.db.write(
      (sql) => subscribe(sql, userId, cryptoId, displayName, now),
      signal,
      criticalSource,
    );
  }

  create(
    userId: number,
    quote: Quote,
    displayName: string | null,
    now: number,
    signal?: AbortSignal,
    criticalSource?: Parameters<Storage["write"]>[2],
  ): Promise<Asset> {
    return this.db.write(
      async (sql) => {
        const catalog = await sql.get<{ id: number }>(
          "SELECT id FROM cryptocurrencies WHERE cmc_id=?",
          [quote.cmcId],
        );
        const cryptoId =
          catalog?.id ??
          (
            await sql.run(
              `INSERT INTO cryptocurrencies
          (cmc_id,slug,name,created_at,last_checked_at) VALUES(?,?,?,?,?)`,
              [quote.cmcId, quote.slug, quote.name, now, now],
            )
          ).lastID;
        if (
          !catalog ||
          !(await sql.get(
            "SELECT id FROM price_history WHERE cryptocurrency_id=? LIMIT 1",
            [cryptoId],
          ))
        ) {
          await sql.run(
            `INSERT INTO price_history(cryptocurrency_id,price,quoted_at,received_at) VALUES(?,?,?,?)`,
            [cryptoId, quote.price, quote.quotedAt, quote.receivedAt],
          );
          if (catalog) {
            await sql.run(
              "UPDATE cryptocurrencies SET name=?,slug=?,last_checked_at=? WHERE id=?",
              [quote.name, quote.slug, now, cryptoId],
            );
          }
        }
        return subscribe(sql, userId, cryptoId, displayName, now);
      },
      signal,
      criticalSource,
    );
  }

  list(
    userId: number,
    query: ListQuery,
    signal?: AbortSignal,
  ): Promise<{ items: Asset[]; nextAfterId: number | null }> {
    return this.db.read(async (sql) => {
      const rows = await sql.all<Asset>(
        `SELECT ${assetColumns} FROM ${assetJoin}
        WHERE uc.user_id=? AND uc.id>? ORDER BY uc.id LIMIT ?`,
        [userId, query.afterId, query.limit + 1],
      );
      const items = rows.slice(0, query.limit);
      return {
        items,
        nextAfterId: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    }, signal);
  }

  update(
    userId: number,
    id: number,
    patch: AssetPatch,
    now: number,
    signal?: AbortSignal,
    criticalSource?: Parameters<Storage["write"]>[2],
  ): Promise<Asset> {
    return this.db.write(
      async (sql) => {
        await sql.run(
          "UPDATE user_currencies SET display_name=?,updated_at=? WHERE user_id=? AND id=?",
          [patch.displayName, now, userId, id],
        );
        return getAsset(sql, userId, id);
      },
      signal,
      criticalSource,
    );
  }

  remove(
    userId: number,
    id: number,
    signal?: AbortSignal,
    criticalSource?: Parameters<Storage["write"]>[2],
  ): Promise<void> {
    return this.db.write(
      async (sql) => {
        const asset = await getAsset(sql, userId, id);
        await sql.run("DELETE FROM user_currencies WHERE user_id=? AND id=?", [
          userId,
          id,
        ]);
        const removed = await sql.run(
          "DELETE FROM active_tracking WHERE cryptocurrency_id=? AND sub_count=1",
          [asset.cryptoId],
        );
        if (!removed.changes) {
          const changed = await sql.run(
            "UPDATE active_tracking SET sub_count=sub_count-1 WHERE cryptocurrency_id=?",
            [asset.cryptoId],
          );
          if (!changed.changes)
            throw new AppError(
              503,
              "DB_ERROR",
              "Database tracking state is inconsistent",
            );
        }
      },
      signal,
      criticalSource,
    );
  }

  activePage(
    afterId: number,
    upperId: number,
    signal?: AbortSignal,
  ): Promise<TrackingSnapshot[]> {
    return this.db.read(
      (sql) =>
        sql.all<TrackingSnapshot>(
          `SELECT a.id, a.cryptocurrency_id AS cryptoId, c.cmc_id AS cmcId
      FROM active_tracking a JOIN cryptocurrencies c ON c.id=a.cryptocurrency_id
      WHERE a.id>? AND a.id<=? ORDER BY a.id LIMIT 250`,
          [afterId, upperId],
        ),
      signal,
    );
  }

  priceSnapshot(
    userId: number,
    id: number,
    signal?: AbortSignal,
  ): Promise<{ asset: Asset; price: PricePoint | null }> {
    return this.db.read(async (sql) => {
      const asset = await getAsset(sql, userId, id);
      return {
        asset,
        price:
          (await sql.get<PricePoint>(
            `SELECT ${priceColumns} FROM price_history p
        WHERE p.cryptocurrency_id=? ORDER BY p.quoted_at DESC LIMIT 1`,
            [asset.cryptoId],
          )) ?? null,
      };
    }, signal);
  }

  history(
    userId: number,
    id: number,
    query: HistoryQuery,
    signal?: AbortSignal,
  ): Promise<{ items: PricePoint[]; nextAfter: number | null }> {
    return this.db.read(async (sql) => {
      const asset = await getAsset(sql, userId, id);
      const conditions = ["p.cryptocurrency_id=?"];
      const values: SqlValue[] = [asset.cryptoId];
      for (const [value, condition] of [
        [query.from, "p.quoted_at >= ?"],
        [query.to, "p.quoted_at < ?"],
        [query.after, "p.quoted_at > ?"],
      ] as const) {
        if (value !== undefined) {
          conditions.push(condition);
          values.push(value);
        }
      }
      const rows = await sql.all<PricePoint>(
        `SELECT ${priceColumns} FROM price_history p
        WHERE ${conditions.join(" AND ")} ORDER BY p.quoted_at LIMIT ?`,
        [...values, query.limit + 1],
      );
      const items = rows.slice(0, query.limit);
      return {
        items,
        nextAfter: rows.length > query.limit ? items.at(-1)!.quotedAt : null,
      };
    }, signal);
  }

  ohlc(
    userId: number,
    id: number,
    from: number,
    to: number,
    bucketMs: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    return this.db.read(async (sql) => {
      const asset = await getAsset(sql, userId, id);
      return sql.all<Candle>(
        `WITH buckets AS (
          SELECT (p.quoted_at / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
            MIN(p.quoted_at) AS first_at, MAX(p.quoted_at) AS last_at,
            MAX(p.price) AS high, MIN(p.price) AS low, COUNT(*) AS count FROM price_history p
          WHERE p.cryptocurrency_id=? AND p.quoted_at>=? AND p.quoted_at<? GROUP BY bucket
        ) SELECT b.bucket, opening.price AS open, b.high, b.low, closing.price AS close, b.count
        FROM buckets b
        JOIN price_history opening ON opening.cryptocurrency_id=? AND opening.quoted_at=b.first_at
        JOIN price_history closing ON closing.cryptocurrency_id=? AND closing.quoted_at=b.last_at
        ORDER BY b.bucket`,
        [
          bucketMs,
          bucketMs,
          asset.cryptoId,
          from,
          to,
          asset.cryptoId,
          asset.cryptoId,
        ],
      );
    }, signal);
  }

  async saveQuotes(
    snapshots: TrackingSnapshot[],
    quotes: Quote[],
    now: number,
    signal?: AbortSignal,
    criticalSource?: Parameters<Storage["write"]>[2],
  ): Promise<SaveResult> {
    if (snapshots.length > 250 || quotes.length > 250) {
      throw new AppError(
        400,
        "INVALID_QUOTE_BATCH",
        "A quote batch must contain at most 250 entries",
      );
    }
    const result: SaveResult = {
      inserted: 0,
      duplicates: 0,
      outdated: 0,
      conflicts: 0,
      discarded: 0,
    };
    if (!quotes.length) return result;
    if (!snapshots.length) return { ...result, discarded: quotes.length };
    const expected = new Map(snapshots.map((asset) => [asset.cmcId, asset]));
    return this.db.write(
      async (sql) => {
        const current = new Map(
          (
            await sql.all<{
              id: number;
              cryptoId: number;
              cmcId: number;
              price: number | null;
              quotedAt: number | null;
            }>(
              `SELECT a.id, c.id AS cryptoId, c.cmc_id AS cmcId, p.price, p.quoted_at AS quotedAt
        FROM active_tracking a JOIN cryptocurrencies c ON c.id=a.cryptocurrency_id
        LEFT JOIN price_history p ON p.cryptocurrency_id=c.id AND p.quoted_at=(
          SELECT quoted_at FROM price_history WHERE cryptocurrency_id=c.id ORDER BY quoted_at DESC LIMIT 1)
        WHERE a.id IN (${snapshots.map(() => "?").join(",")})`,
              snapshots.map((asset) => asset.id),
            )
          ).map((asset) => [asset.id, asset]),
        );
        const inserted: SqlValue[][] = [];
        const updated = new Map<number, SqlValue[]>();
        for (const quote of quotes) {
          const snapshot = expected.get(quote.cmcId);
          const asset = snapshot && current.get(snapshot.id);
          if (
            !snapshot ||
            !asset ||
            asset.cmcId !== quote.cmcId ||
            asset.cryptoId !== snapshot.cryptoId
          ) {
            result.discarded++;
            continue;
          }
          if (asset.quotedAt !== null && quote.quotedAt < asset.quotedAt) {
            result.outdated++;
            continue;
          }
          if (asset.quotedAt === quote.quotedAt) {
            if (asset.price !== quote.price) {
              result.conflicts++;
              continue;
            }
            result.duplicates++;
          } else {
            inserted.push([
              asset.cryptoId,
              quote.price,
              quote.quotedAt,
              quote.receivedAt,
            ]);

            asset.price = quote.price;
            asset.quotedAt = quote.quotedAt;
            result.inserted++;
          }
          updated.set(asset.cryptoId, [asset.cryptoId, quote.name, quote.slug]);
        }
        if (inserted.length)
          await sql.run(
            `INSERT INTO price_history(cryptocurrency_id,price,quoted_at,received_at)
        VALUES ${inserted.map(() => "(?,?,?,?)").join(",")}`,
            inserted.flat(),
          );
        if (updated.size)
          await sql.run(
            `WITH incoming(id,name,slug) AS (VALUES ${[...updated].map(() => "(?,?,?)").join(",")})
        UPDATE cryptocurrencies SET name=incoming.name, slug=incoming.slug, last_checked_at=?
        FROM incoming WHERE cryptocurrencies.id=incoming.id`,
            [...[...updated.values()].flat(), now],
          );
        return result;
      },
      signal,
      criticalSource,
    );
  }
}
