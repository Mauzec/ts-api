import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import type { Storage } from "./db";
import { HttpOperations } from "./http-operations";
import type { AppConfig } from "./config";
import { AuthService } from "./auth";
import { rateLimit } from "express-rate-limit";
import { AppError } from "./errors";
import type { Logger } from "./logger";
import { openapi } from "./openapi";
import type { Repository } from "./repo";
import type { TrackingService } from "./services";
import type { Asset, PricePoint } from "./types";
import * as v from "./validation";

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();
const assetDto = ({ cryptoId: _internal, ...asset }: Asset) => ({
  ...asset,
  createdAt: iso(asset.createdAt),
  updatedAt: iso(asset.updatedAt),
  lastCheckedAt: iso(asset.lastCheckedAt),
});
const pointDto = (point: PricePoint) => ({
  ...point,
  quotedAt: iso(point.quotedAt),
  receivedAt: iso(point.receivedAt),
});
const dated = <T extends { createdAt: number }>(item: T) => ({
  ...item,
  createdAt: iso(item.createdAt),
});
const emptyQuery = (req: Request): void => {
  v.fields(req.query, [], "query");
};

export function createApp({
  storage,
  config,
  repository,
  tracking,
  logger,
  operations = new HttpOperations(),
  now = Date.now,
}: {
  storage: Storage;
  operations?: HttpOperations;
  config: AppConfig;
  repository: Repository;
  tracking: TrackingService;
  logger: Logger;
  now?: () => number;
}): express.Express {
  const app = express();
  const auth = new AuthService(storage, now);
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    const requestId = randomUUID(),
      started = now();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.once("finish", () =>
      logger.log("info", "http_request", {
        requestId,
        method: req.method,
        route: req.route?.path ?? "unmatched",
        status: res.statusCode,
        durationMs: now() - started,
      }),
    );
    next();
  });
  app.get("/openapi.json", (req, res) => {
    emptyQuery(req);
    res.json(openapi);
  });
  app.get(["/docs", "/docs/"], (req, res) => {
    emptyQuery(req);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    res
      .type("html")
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crypto Tracker API</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>',
      );
  });
  app.get("/docs/init.js", (_req, res) => {
    res
      .type("application/javascript")
      .send(
        'window.onload=function(){SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",persistAuthorization:false,validatorUrl:null});};',
      );
  });
  const swaggerPath = (
    require("swagger-ui-dist") as { getAbsoluteFSPath(): string }
  ).getAbsoluteFSPath();
  app.use(
    "/docs/assets",
    express.static(swaggerPath, { index: false, dotfiles: "deny" }),
  );

  const mediaType: RequestHandler = (req, _res, next) => {
    const hasBody =
      Number(req.headers["content-length"] ?? 0) > 0 ||
      req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !req.is("application/json"))
      throw new AppError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Request bodies must use application/json",
      );
    next();
  };
  app.use(
    "/api/v1",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      validate: { xForwardedForHeader: false },
      handler: (_req, _res, next) =>
        next(
          new AppError(429, "RATE_LIMITED", "Too many requests; retry later"),
        ),
    }),
    mediaType,
    express.json({ limit: "16kb", strict: true, inflate: false }),
  );

  const router = express.Router();
  type Handler = (
    req: Request,
    res: Response,
    signal: AbortSignal,
    userId: number,
  ) => Promise<void>;
  const business = (write: boolean, handler: Handler): RequestHandler =>
    operations.route(async (req, res, signal) => {
      res.setHeader("WWW-Authenticate", "Bearer");
      const principal = await auth.authenticateBearer(
        req.headers.authorization,
        signal,
      );
      res.removeHeader("WWW-Authenticate");
      if (write && principal.permission !== "rw")
        throw new AppError(403, "FORBIDDEN", "This API key is read-only");
      await handler(req, res, signal, principal.userId);
    });
  const basic = (handler: Handler): RequestHandler =>
    operations.route(async (req, res, signal) => {
      res.setHeader(
        "WWW-Authenticate",
        'Basic realm="API keys", charset="UTF-8"',
      );
      const user = await auth.authenticateBasic(
        req.headers.authorization,
        signal,
      );
      res.removeHeader("WWW-Authenticate");
      await handler(req, res, signal, user.id);
    });
  router.post(
    "/users",
    operations.route(async (req, res, signal) => {
      emptyQuery(req);
      const body = v.fields(req.body, ["login", "password"]);
      const user = await auth.register(body.login, body.password, signal);
      res.status(201).json({ data: dated(user) });
    }),
  );
  router.post(
    "/api-keys",
    basic(async (req, res, signal, userId) => {
      emptyQuery(req);
      const body = v.fields(req.body, ["name", "permission"]);
      const key = await auth.issue(userId, body.name, body.permission, signal);
      res.status(201).json({ data: dated(key) });
    }),
  );
  router.get(
    "/api-keys",
    basic(async (req, res, signal, userId) => {
      emptyQuery(req);
      v.emptyBody(req.body);
      res.json({ data: (await auth.list(userId, signal)).map(dated) });
    }),
  );
  router.delete(
    "/api-keys/:id",
    basic(async (req, res, signal, userId) => {
      emptyQuery(req);
      v.emptyBody(req.body);
      await auth.remove(userId, v.id(req.params.id), signal);
      res.status(204).end();
    }),
  );
  router.get(
    "/cryptocurrencies",
    business(false, async (req, res, signal, userId) => {
      v.emptyBody(req.body);
      const result = await repository.list(
        userId,
        v.listQuery(req.query),
        signal,
      );
      res.json({
        data: result.items.map(assetDto),
        pagination: { nextAfterId: result.nextAfterId },
      });
    }),
  );
  router.post(
    "/cryptocurrencies",
    business(true, async (req, res, signal, userId) => {
      emptyQuery(req);
      const asset = await tracking.create(userId, v.createInput(req.body), {
        requestId: res.locals.requestId as string,
      });
      res
        .location(`/api/v1/cryptocurrencies/${asset.id}`)
        .status(201)
        .json({ data: assetDto(asset) });
    }),
  );
  router.get(
    "/cryptocurrencies/:id",
    business(false, async (req, res, signal, userId) => {
      emptyQuery(req);
      v.emptyBody(req.body);
      res.json({
        data: assetDto(
          await repository.get(userId, v.id(req.params.id), signal),
        ),
      });
    }),
  );
  router.patch(
    "/cryptocurrencies/:id",
    business(true, async (req, res, signal, userId) => {
      emptyQuery(req);
      res.json({
        data: assetDto(
          await repository.update(
            userId,
            v.id(req.params.id),
            v.patchInput(req.body),
            now(),
            signal,
          ),
        ),
      });
    }),
  );
  router.delete(
    "/cryptocurrencies/:id",
    business(true, async (req, res, signal, userId) => {
      emptyQuery(req);
      v.emptyBody(req.body);
      await repository.remove(userId, v.id(req.params.id), signal);
      res.status(204).end();
    }),
  );
  router.get(
    "/cryptocurrencies/:id/price",
    business(false, async (req, res, signal, userId) => {
      emptyQuery(req);
      v.emptyBody(req.body);
      const assetId = v.id(req.params.id),
        { asset, price: point } = await repository.priceSnapshot(
          userId,
          assetId,
          signal,
        );
      res.json({
        data: {
          cryptocurrencyId: assetId,
          currency: "USD",
          price: point?.price ?? null,
          quotedAt: point ? iso(point.quotedAt) : null,
          receivedAt: point ? iso(point.receivedAt) : null,
          lastCheckedAt: iso(asset.lastCheckedAt),
          stale:
            point === null ||
            now() - point.quotedAt > config.cmcPriceSyncIntervalMs * 2,
        },
      });
    }),
  );
  router.get(
    "/cryptocurrencies/:id/history",
    business(false, async (req, res, signal, userId) => {
      v.emptyBody(req.body);
      const result = await repository.history(
        userId,
        v.id(req.params.id),
        v.historyQuery(req.query),
        signal,
      );
      res.json({
        data: result.items.map(pointDto),
        currency: "USD",
        pagination: { nextAfter: iso(result.nextAfter) },
      });
    }),
  );
  router.get(
    "/cryptocurrencies/:id/ohlc",
    business(false, async (req, res, signal, userId) => {
      v.emptyBody(req.body);
      const query = v.ohlcQuery(req.query);
      const candles = await repository.ohlc(
        userId,
        v.id(req.params.id),
        query.from,
        query.to,
        query.bucketMs,
        signal,
      );
      res.json({
        data: candles.map((candle) => ({
          ...candle,
          bucket: iso(candle.bucket),
        })),
        source: "sampled_quotes",
        currency: "USD",
        interval: query.interval,
      });
    }),
  );
  app.use("/api/v1", router);
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Route not found")),
  );
  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const parser = error as { type?: string; status?: number } | null;
    const known =
      error instanceof AppError
        ? error
        : parser?.type === "entity.too.large"
          ? new AppError(413, "PAYLOAD_TOO_LARGE", "JSON body exceeds 16 KiB")
          : parser?.type === "entity.parse.failed"
            ? new AppError(400, "INVALID_JSON", "Malformed JSON body")
            : parser?.status === 415
              ? new AppError(
                  415,
                  "UNSUPPORTED_MEDIA_TYPE",
                  "Unsupported body encoding",
                )
              : error instanceof URIError
                ? new AppError(400, "INVALID_INPUT", "Invalid URL encoding")
                : new AppError(500, "INTERNAL_ERROR", "Internal server error");
    logger.log(known.status >= 500 ? "error" : "warn", "http_error", {
      requestId: res.locals.requestId,
      code: known.code,
      status: known.status,
    });
    if (known.retryAt !== undefined)
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((known.retryAt - now()) / 1000))),
      );
    res.status(known.status).json({
      error: {
        code: known.code,
        message: known.message,
        ...(known.details === undefined ? {} : { details: known.details }),
        requestId: res.locals.requestId,
      },
    });
  };
  app.use(errorHandler);
  return app;
}
