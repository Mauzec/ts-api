import { createServer, type Server } from "node:http";
import { loadConfig, type AppConfig } from "./config";
import { openDatabase } from "./db";
import { Repository } from "./repo";
import { SyncStateRepository } from "./sync-state";
import { HttpOperations } from "./http-operations";
import { CmcClient } from "./cmc";
import { TrackingService, SyncService } from "./services";
import { Scheduler } from "./scheduler";
import { createApp } from "./app";
import { createLogger, type Logger } from "./logger";
import type { PriceProvider } from "./types";

export interface APIServer {
  server: Server;
  logger: Logger;
  close(message: string): Promise<void>;
}

export async function start(
  config: AppConfig,
  options: { provider?: PriceProvider; logger?: Logger } = {},
): Promise<APIServer> {
  const logger =
    options.logger ?? createLogger(config.logLevel, [config.cmcApiKey]);
  let fatalShutdown: (() => void) | undefined;
  const db = await openDatabase(config.dbPath, {
    onFatal: () => {
      process.exitCode = 1;
      logger.log("error", "database_transaction_unknown");
      fatalShutdown?.();
    },
  });
  let startupProvider: PriceProvider | undefined = options.provider;
  let startupSync: SyncService | undefined;
  let startupScheduler: Scheduler | undefined;
  let startupServer: Server | undefined;
  try {
    const repository = new Repository(db);
    const provider = (startupProvider =
      options.provider ?? new CmcClient(config, logger));
    const tracking = new TrackingService(repository, provider);
    const sync = (startupSync = new SyncService(
      new SyncStateRepository(db),
      repository,
      provider,
      config,
      logger,
    ));
    const scheduler = (startupScheduler = new Scheduler(sync, logger));
    const operations = new HttpOperations();
    const app = createApp({
      storage: db,
      config,
      repository,
      tracking,
      logger,
      operations,
    });
    let closing: Promise<void> | undefined;
    const server = (startupServer = createServer((request, response) => {
      response.once("finish", () => {
        if (closing) server.closeIdleConnections();
      });
      app(request, response);
    }));
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    await sync.initialize();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (config.cmcPriceSyncEnabled) scheduler.start();
    logger.log("info", "server_started", {
      host: config.host,
      port: (server.address() as { port: number }).port,
      scheduler: config.cmcPriceSyncEnabled,
    });

    const running: APIServer = {
      server,
      logger,
      close(reason) {
        if (closing) return closing;
        operations.stop();
        scheduler.stop();
        provider.stop();
        const syncStopped = sync.stop();
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        closing = (async () => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              (async () => {
                await Promise.all([
                  closed,
                  syncStopped,
                  provider.idle(),
                  operations.idle(),
                ]);
                db.stopAccept();
                await db.close();
              })(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  server.closeAllConnections();
                  reject(new Error("Shutdown deadline exceeded"));
                }, config.shutDownMs);
              }),
            ]);
            logger.log("info", "server_stopped", { reason });
          } finally {
            if (timer) clearTimeout(timer);
          }
        })();
        return closing;
      },
    };
    fatalShutdown = () => {
      void running.close("database_fatal").catch(() => process.exit(1));
    };
    return running;
  } catch (error) {
    startupScheduler?.stop();
    const listenerClosed = new Promise<void>((resolve) => {
      if (!startupServer?.listening) {
        resolve();
        return;
      }
      startupServer.closeAllConnections();
      startupServer.close(() => resolve());
    });
    await Promise.allSettled([
      (async () => {
        startupProvider?.stop();
        await startupProvider?.idle();
      })(),
      startupSync?.stop(),
      listenerClosed,
    ]);
    await db.close();
    throw error;
  }
}

export function installShutdownHandlers(running: APIServer): () => void {
  let stopping = false;
  let exitCode = 0;
  const finish = (reason: string, code: number): void => {
    exitCode = Math.max(exitCode, code);
    if (stopping) return;
    stopping = true;
    if (code) running.logger.log("error", "fatal_error", { reason });
    void running
      .close(reason)
      .then(() => {
        remove();
        process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
      })
      .catch(() => {
        running.logger.log("error", "shutdown_failed");
        process.exit(1);
      });
  };
  const interrupt = (): void => finish("SIGINT", 0);
  const terminate = (): void => finish("SIGTERM", 0);
  const uncaught = (): void => finish("uncaughtException", 1);
  const rejected = (): void => finish("unhandledRejection", 1);
  const remove = (): void => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("uncaughtException", uncaught);
    process.off("unhandledRejection", rejected);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", rejected);
  return remove;
}

if (require.main === module) {
  void (async () => {
    const config = loadConfig();
    installShutdownHandlers(await start(config));
  })().catch((error) => {
    const message =
      error instanceof Error &&
      /^(Invalid|Unsupported database schema|DB_PATH)/.test(error.message)
        ? error.message
        : "Could not start the service";
    process.stderr.write(
      JSON.stringify({
        level: "error",
        message: "startup_failed",
        reason: message,
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
