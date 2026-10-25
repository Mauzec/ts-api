import { AsyncLocalStorage } from "node:async_hooks";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { AppConfig } from "./config";
import { AppError } from "./errors";
import { Logger } from "./logger";
import {
  Candidate,
  PriceProvider,
  Quote,
  QuotesResult,
  RequestContext,
} from "./types";

const PRICES = "/v2/simple/price";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const label = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const slugValue = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-z-]{1,256}$/.test(value);
const invalidResponse = (): AppError =>
  new AppError(
    502,
    "CMC_INVALID_RESPONSE",
    "External provider returned invalid data",
  );

function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    throw invalidResponse();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw invalidResponse();
  return parsed;
}

export class CmcClient implements PriceProvider {
  private readonly consumerContext = new AsyncLocalStorage<boolean>();
  private readonly transport: AxiosInstance;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly slugs = new Map<string, Promise<Candidate[]>>();
  private readonly prices = new Map<string, Promise<QuotesResult>>();
  private persistence: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    options: { now?: () => number; transport?: AxiosInstance } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.transport =
      options.transport ??
      axios.create({ baseURL: "https://pro-api.coinmarketcap.com" });
  }

  stop(): void {
    this.controller.abort();
  }

  async idle(): Promise<void> {
    while (this.operations.size) await Promise.allSettled(this.operations);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.consumerContext.getStore())
      throw new AppError(
        500,
        "CMC_REENTRANT_CALL",
        "External requests can't be nested",
      );
    this.checkAvailable();
    if (this.operations.size >= 32)
      throw new AppError(
        503,
        "CMC_QUEUE_FULL",
        "Too many operations are in progress",
      );
    const result = Promise.resolve()
      .then(() => {
        this.checkAvailable();
        return operation();
      })
      .finally(() => {
        this.operations.delete(result);
      });
    this.operations.add(result);
    return result;
  }

  private consume<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistence.then(() =>
      this.consumerContext.run(true, operation),
    );
    this.persistence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private shared<T>(
    requests: Map<string, Promise<T>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = requests.get(key);
    if (existing) return existing;
    const result = operation().finally(() => {
      requests.delete(key);
    });
    requests.set(key, result);
    return result;
  }

  private checkAvailable(): void {
    if (this.controller.signal.aborted)
      throw new AppError(503, "CMC_CANCELLED", "External request is cancelled");
  }

  resolveSlug(slug: string, context: RequestContext): Promise<Candidate[]> {
    return this.run(() => {
      if (!slugValue(slug))
        throw new AppError(
          400,
          "INVALID_CMC_SLUG",
          "Invalid cryptocurrency slug",
        );

      return this.shared(this.slugs, slug, () =>
        this.request(
          { slug, convert: "USD", skip_invalid: true },
          context,
          (data) => {
            if (!Array.isArray(data)) throw invalidResponse();
            const candidates = new Map<number, Candidate>();
            for (const entry of data) {
              if (
                !object(entry) ||
                !count(entry.id) ||
                entry.id === 0 ||
                !label(entry.name) ||
                !slugValue(entry.slug)
              )
                throw invalidResponse();
              if (entry.slug === slug)
                candidates.set(entry.id, {
                  cmcId: entry.id,
                  name: entry.name,
                  slug: entry.slug,
                });
            }
            return [...candidates.values()];
          },
        ),
      );
    });
  }

  withPrices<T>(
    ids: number[],
    context: RequestContext,
    after: (result: QuotesResult) => Promise<T>,
  ): Promise<T> {
    return this.run(async () => {
      if (ids.length === 0)
        return this.consume(() => after({ quotes: [], errorIds: [] }));
      if (
        ids.length > 250 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !count(id) || id === 0)
      ) {
        throw new AppError(
          400,
          "INVALID_CMC_IDS",
          "A price batch requires up to 250 ids",
        );
      }
      const key = [...ids].sort((a, b) => a - b).join(",");
      const result = await this.shared(this.prices, key, () =>
        this.request(
          {
            id: key,
            convert: "USD",
            include_last_updated: true,
            skip_invalid: true,
          },
          context,
          (data) => {
            if (!Array.isArray(data)) throw invalidResponse();
            const receivedAt = this.now();
            const wanted = new Set(ids);
            const seen = new Set<number>();
            const quotes = new Map<number, Quote>();
            for (const entry of data) {
              if (!object(entry) || !count(entry.id) || !wanted.has(entry.id))
                continue;
              if (seen.has(entry.id)) {
                quotes.delete(entry.id);
                continue;
              }
              seen.add(entry.id);
              if (
                !label(entry.name) ||
                !slugValue(entry.slug) ||
                !Array.isArray(entry.quotes) ||
                entry.quotes.length !== 1
              )
                continue;
              const quote: unknown = entry.quotes[0];
              if (
                !object(quote) ||
                quote.symbol !== "USD" ||
                typeof quote.price !== "number" ||
                !Number.isFinite(quote.price) ||
                quote.price < 0
              )
                continue;
              let quotedAt: number;
              try {
                quotedAt = timestamp(quote.last_updated);
              } catch {
                continue;
              }
              if (quotedAt > receivedAt + 300000) continue;
              quotes.set(entry.id, {
                cmcId: entry.id,
                name: entry.name,
                slug: entry.slug,
                price: quote.price,
                quotedAt,
                receivedAt,
              });
            }
            const errorIds = ids.filter((id) => !quotes.has(id));
            this.logger.log(errorIds.length ? "warn" : "info", "cmc_quotes", {
              requestId: context.requestId,
              requested: ids.length,
              valid: quotes.size,
              invalid: errorIds.length,
            });
            return { quotes: [...quotes.values()], errorIds };
          },
        ),
      );
      return this.consume(() => after(result));
    });
  }

  private providerError(
    httpStatus: number,
    code: unknown,
    retryAfter: unknown,
  ): AppError {
    const parsedCode =
      typeof code === "number" ||
      (typeof code === "string" && /^\d+$/.test(code))
        ? Number(code)
        : NaN;
    const cmcCode =
      Number.isSafeInteger(parsedCode) && parsedCode >= 0 ? parsedCode : null;
    if (
      httpStatus === 429 ||
      (cmcCode !== null && cmcCode >= 1008 && cmcCode <= 1011)
    ) {
      let retryAt: number | undefined;
      if (typeof retryAfter === "string") {
        const value = retryAfter.trim();
        const parsed = /^\d+$/.test(value)
          ? this.now() + Number(value) * 1000
          : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
                value,
              )
            ? Date.parse(value)
            : NaN;
        if (Number.isSafeInteger(parsed) && parsed >= this.now())
          retryAt = parsed;
      }
      // TODO: hide this error, if user should not see this
      return new AppError(
        429,
        "CMC_RATE_LIMITED",
        "External provider call limit reached",
        {
          details: { cmcCode },
          ...(retryAt === undefined ? {} : { retryAt }),
        },
      );
    }
    if (
      httpStatus === 401 ||
      httpStatus === 402 ||
      httpStatus === 403 ||
      (cmcCode !== null && cmcCode >= 1001 && cmcCode <= 1007)
    ) {
      return new AppError(
        503,
        "CMC_AUTH_FAILED",
        "External provider rejected credentials",
        { details: { cmcCode }, pause: true },
      );
    }
    return new AppError(
      502,
      "CMC_UNAVAILABLE",
      "External provider rejected the request",
      { details: { cmcCode } },
    );
  }

  private async request<T>(
    params: Record<string, string | boolean>,
    context: RequestContext,
    parse: (data: unknown) => T,
  ): Promise<T> {
    this.checkAvailable();
    const startedAt = this.now();
    let actualCredits: number | null = null;
    let httpStatus: number | undefined;
    let cmcCode: unknown;
    let failure: AppError | undefined;
    const deadline = new AbortController();
    const timeoutError = new AppError(
      504,
      "CMC_TIMEOUT",
      "External provider timed out",
    );
    const signal = AbortSignal.any([this.controller.signal, deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(
        () => deadline.abort(timeoutError),
        this.config.cmcTimeoutMs,
      );
      let response: AxiosResponse<unknown>;
      try {
        response = await this.transport.get<unknown>(PRICES, {
          params,
          headers: {
            "X-CMC_PRO_API_KEY": this.config.cmcApiKey,
            Accept: "application/json",
          },
          timeout: this.config.cmcTimeoutMs,
          maxRedirects: 0,
          proxy: false,
          maxContentLength: 2 * 1024 * 1024,
          responseType: "json",
          transitional: {
            silentJSONParsing: false,
            forcedJSONParsing: true,
            clarifyTimeoutError: true,
          },
          validateStatus: () => true,
          signal,
        });
      } catch (error) {
        if (axios.isAxiosError(error) && error.response)
          response = error.response;
        else throw error;
      }
      httpStatus = response.status;
      const body = response.data;
      const status =
        object(body) && object(body.status) ? body.status : undefined;
      if (status && count(status.credit_count))
        actualCredits = status.credit_count;
      cmcCode = status?.error_code;
      if (
        httpStatus === 400 &&
        (cmcCode === 400 || cmcCode === "400") &&
        typeof params.slug === "string" &&
        status?.error_message === `Invalid value for "slug": "${params.slug}"`
      ) {
        throw new AppError(
          422,
          "UNKNOWN_ASSET",
          "No cryptocurrency matches this slug",
        );
      }
      if (httpStatus < 200 || httpStatus >= 300)
        throw this.providerError(
          httpStatus,
          cmcCode,
          response.headers["retry-after"],
        );
      if (!status || (cmcCode !== 0 && cmcCode !== "0")) {
        if (
          status &&
          (typeof cmcCode === "number" || typeof cmcCode === "string")
        )
          throw this.providerError(
            httpStatus,
            cmcCode,
            response.headers["retry-after"],
          );
        throw invalidResponse();
      }
      return parse((body as Record<string, unknown>).data);
    } catch (error) {
      if (error instanceof AppError) failure = error;
      else if (signal.aborted && signal.reason === timeoutError)
        failure = timeoutError;
      else if (axios.isCancel(error) || this.controller.signal.aborted)
        failure = new AppError(
          503,
          "CMC_CANCELLED",
          "External request was cancelled",
        );
      else if (
        axios.isAxiosError(error) &&
        (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED")
      )
        failure = timeoutError;
      else if (axios.isAxiosError(error) && error.code === "ERR_BAD_RESPONSE")
        failure = invalidResponse();
      else
        failure = new AppError(
          502,
          "CMC_UNAVAILABLE",
          "External provider is unavailable",
        );
      throw failure;
    } finally {
      clearTimeout(timer);
      this.logger.log(failure ? "warn" : "info", "cmc_request", {
        requestId: context.requestId,
        endpoint: PRICES,
        durationMs: this.now() - startedAt,
        httpStatus,
        cmcCode:
          typeof cmcCode === "number" ||
          (typeof cmcCode === "string" && /^\d+$/.test(cmcCode))
            ? cmcCode
            : null,
        credits: actualCredits,
        result: failure?.code ?? "success",
      });
    }
  }
}
