import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "./errors";

export class HttpOperations {
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  route(
    handler: (
      req: Request,
      res: Response,
      signal: AbortSignal,
      next: NextFunction,
    ) => Promise<void>,
  ): RequestHandler {
    return (req, res, next) => {
      if (this.stopping) {
        next(new AppError(503, "SHUTTING_DOWN", "Service is shutting down"));
        return;
      }
      const controller = new AbortController();
      const disconnected = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnected);
      const work = Promise.resolve().then(() =>
        handler(req, res, controller.signal, next),
      );
      this.active.add(work);
      void work
        .then(() => {}, next)
        .finally(() => {
          res.off("close", disconnected);
          this.active.delete(work);
        });
    };
  }
  stop(): void {
    this.stopping = true;
  }
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled(this.active);
  }
}
