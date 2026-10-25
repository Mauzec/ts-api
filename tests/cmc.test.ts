import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { createServer, RequestListener, Server } from "node:http";
import { AddressInfo } from "node:net";
import { CmcClient } from "../src/cmc";
import { AppError } from "../src/errors";
import { config } from "./helpers";
import type { Logger } from "../src/logger";

const context = { requestId: "test-request" };
const start = Date.parse("2026-10-19T12:00:00Z");
const item = (id = 1, price = 100, time = start) => ({
  id,
  name: `Coin ${id}`,
  symbol: `C${id}`,
  slug: `coin-${id}`,
  quotes: [
    { symbol: "USD", price, last_updated: new Date(time).toISOString() },
  ],
});
const response = (
  data: unknown,
  code: unknown = 0,
  status = 200,
): AxiosResponse<unknown> => ({
  data: { status: { error_code: code, credit_count: 1 }, data },
  status,
  statusText: "",
  headers: {},
  config: {} as AxiosResponse["config"],
});
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("CoinMarketCap transport", () => {
  let get: jest.Mock,
    logger: Logger,
    client: CmcClient,
    server: Server | undefined;
  const prices = (ids = [1]) =>
    client.withPrices(ids, context, async (result) => result);
  beforeEach(() => {
    get = jest.fn().mockResolvedValue(response([item()]));
    logger = { log: jest.fn() };
    client = new CmcClient(config({ cmcApiKey: "sensitive-cmc-key" }), logger, {
      now: () => start,
      transport: { get } as unknown as AxiosInstance,
    });
  });
  afterEach(async () => {
    client.stop();
    await client.idle();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });
  async function local(
    handler: RequestListener,
    timeout = 1000,
  ): Promise<void> {
    server = createServer(handler);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    client = new CmcClient(config({ cmcTimeoutMs: timeout }), logger, {
      now: () => start,
      transport: axios.create({
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    });
  }

  test("prices use real slug and compact USD parameters; diagnostic credits never impose a local budget", async () => {
    expect(await prices()).toEqual({
      quotes: [
        {
          cmcId: 1,
          name: "Coin 1",
          slug: "coin-1",
          price: 100,
          quotedAt: start,
          receivedAt: start,
        },
      ],
      errorIds: [],
    });
    const options = get.mock.calls[0]![1] as AxiosRequestConfig;
    expect(options).toMatchObject({
      params: {
        id: "1",
        convert: "USD",
        include_last_updated: true,
        skip_invalid: true,
      },
      timeout: 6000,
      maxRedirects: 0,
      proxy: false,
      maxContentLength: 2097152,
      responseType: "json",
      headers: { "X-CMC_PRO_API_KEY": "sensitive-cmc-key" },
    });
    expect(options.params).not.toHaveProperty("precision");
    get.mockResolvedValue({
      ...response([item()]),
      data: { status: { error_code: 0, credit_count: 100000 }, data: [item()] },
    });
    await prices();
    await prices();
    expect(get.mock.calls.map((call) => call[0])).toEqual(
      Array(3).fill("/v2/simple/price"),
    );
    expect(JSON.stringify((logger.log as jest.Mock).mock.calls)).not.toContain(
      "sensitive-cmc-key",
    );
  });

  test("slug resolution uses Simple Price, followed by an independent ID quote; it never calls Map or key info", async () => {
    get.mockResolvedValue(
      response([
        { ...item(), slug: "bitcoin", name: "Bitcoin", symbol: "BTC" },
      ]),
    );
    expect(await client.resolveSlug("bitcoin", context)).toEqual([
      { cmcId: 1, name: "Bitcoin", slug: "bitcoin" },
    ]);
    expect(get.mock.calls[0]![1].params).toEqual({
      slug: "bitcoin",
      convert: "USD",
      skip_invalid: true,
    });
    expect((await prices()).quotes[0]!.slug).toBe("bitcoin");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      "/v2/simple/price",
      "/v2/simple/price",
    ]);
  });
  test("slug candidates are exact and deduplicated; empty results remain empty", async () => {
    get
      .mockResolvedValueOnce(response([item(), item(), item(2)]))
      .mockResolvedValueOnce(response([]));
    expect(await client.resolveSlug("coin-1", context)).toEqual([
      { cmcId: 1, name: "Coin 1", slug: "coin-1" },
    ]);
    expect(await client.resolveSlug("missing", context)).toEqual([]);
  });
  test.each(["", "BTC", "coin,other", "coin name", "x".repeat(257)])(
    "rejects malformed slug %p before HTTP",
    async (slug) => {
      await expect(client.resolveSlug(slug, context)).rejects.toMatchObject({
        code: "INVALID_CMC_SLUG",
      });
      expect(get).not.toHaveBeenCalled();
    },
  );
  test.each([
    {},
    [{ id: 0, slug: "bitcoin", name: "Bitcoin" }],
    [{ id: 1, symbol: "BTC", name: "Bitcoin" }],
  ])("rejects invalid slug response %p", async (data) => {
    get.mockResolvedValue(response(data));
    await expect(client.resolveSlug("bitcoin", context)).rejects.toMatchObject({
      code: "CMC_INVALID_RESPONSE",
    });
  });
  test("only the exact invalid-slug provider error maps to unknown asset", async () => {
    get
      .mockResolvedValueOnce({
        ...response(null, "400", 400),
        data: {
          status: {
            error_code: "400",
            error_message: 'Invalid value for "slug": "missing"',
          },
        },
      })
      .mockResolvedValueOnce({
        ...response(null, 400, 400),
        data: {
          status: {
            error_code: 400,
            error_message: 'Invalid value for "slug": "different"',
          },
        },
      });
    await expect(client.resolveSlug("missing", context)).rejects.toMatchObject({
      status: 422,
      code: "UNKNOWN_ASSET",
    });
    await expect(client.resolveSlug("missing", context)).rejects.toMatchObject({
      status: 502,
      code: "CMC_UNAVAILABLE",
    });
  });

  test("empty ID list is offline; oversized, repeated, nonpositive and unsafe IDs are rejected", async () => {
    expect(await prices([])).toEqual({ quotes: [], errorIds: [] });
    for (const ids of [
      Array.from({ length: 251 }, (_, i) => i + 1),
      [1, 1],
      [0],
      [-1],
      [1.1],
      [Number.MAX_SAFE_INTEGER + 1],
    ]) {
      await expect(prices(ids)).rejects.toMatchObject({
        code: "INVALID_CMC_IDS",
      });
    }
    expect(get).not.toHaveBeenCalled();
  });
  test("250 prices including zero use one request and accept a string success code", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    get.mockResolvedValue(
      response(
        ids.map((id) => item(id, 0)),
        "0",
      ),
    );
    expect((await prices(ids)).quotes).toHaveLength(250);
    expect(get).toHaveBeenCalledTimes(1);
  });
  test("invalid observations are rejected independently, without inventing a slug from symbol", async () => {
    get.mockResolvedValue(
      response([
        item(1, 0),
        item(2),
        item(2),
        item(2),
        { ...item(3), quotes: [{ ...item(3).quotes[0], symbol: "EUR" }] },
        item(4, -1),
        item(5, Infinity),
        item(6, 1, start + 300001),
        {
          ...item(7),
          quotes: [
            { symbol: "USD", price: 1, last_updated: "2026-02-30T00:00:00Z" },
          ],
        },
        { ...item(8), quotes: [...item(8).quotes, ...item(8).quotes] },
        { ...item(9), name: "" },
        {
          ...item(10),
          quotes: [
            {
              symbol: "USD",
              price: "100",
              last_updated: new Date(start).toISOString(),
            },
          ],
        },
        { ...item(11), slug: undefined },
        item(999),
        null,
      ]),
    );
    const result = await prices(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(result.quotes.map((q) => [q.cmcId, q.price])).toEqual([[1, 0]]);
    expect(result.errorIds).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  test.each([{}, null, "not-array"])(
    "rejects malformed price body %p",
    async (data) => {
      get.mockResolvedValue(response(data));
      await expect(prices()).rejects.toMatchObject({
        code: "CMC_INVALID_RESPONSE",
      });
    },
  );
  test.each([
    {},
    { status: {} },
    { status: null },
    { status: { error_code: null }, data: [] },
  ])("rejects malformed envelope %p", async (body) => {
    get.mockResolvedValue({ ...response([]), data: body });
    await expect(prices()).rejects.toMatchObject({
      code: "CMC_INVALID_RESPONSE",
    });
  });

  test.each([1008, 1009, 1010, 1011])(
    "provider limit %i passes as 429 and does not pause later requests locally",
    async (code) => {
      get.mockResolvedValueOnce({
        ...response(null, code, 429),
        headers: { "retry-after": "2" },
      });
      await expect(prices()).rejects.toMatchObject({
        status: 429,
        code: "CMC_RATE_LIMITED",
        details: { cmcCode: code },
        retryAt: start + 2000,
        pause: false,
      });
      await expect(prices()).resolves.toMatchObject({ errorIds: [] });
      expect(get).toHaveBeenCalledTimes(2);
    },
  );
  test.each([
    ["120", start + 120000],
    ["0", start],
    [new Date(start + 90000).toUTCString(), start + 90000],
    ["bad", undefined],
    ["-5", undefined],
    ["1e9", undefined],
    ["9999999999999999999999", undefined],
  ])("Retry-After %p is parsed safely", async (value, expected) => {
    get.mockResolvedValue({
      ...response(null, "1008", 429),
      headers: { "retry-after": value },
    });
    await expect(prices()).rejects.toMatchObject({
      status: 429,
      retryAt: expected,
      details: { cmcCode: 1008 },
    });
  });
  test("429 without a provider envelope preserves the HTTP status and exposes no raw body", async () => {
    get.mockResolvedValue({
      ...response(null),
      status: 429,
      data: "sensitive-cmc-key",
    });
    await expect(prices()).rejects.toMatchObject({
      status: 429,
      code: "CMC_RATE_LIMITED",
      details: { cmcCode: null },
    });
    expect(JSON.stringify((logger.log as jest.Mock).mock.calls)).not.toContain(
      "sensitive-cmc-key",
    );
  });
  test.each([401, 402, 403])(
    "HTTP %i requests a scheduler pause but does not preemptively block client calls",
    async (status) => {
      get.mockResolvedValueOnce(response(null, 1001, status));
      await expect(prices()).rejects.toMatchObject({
        code: "CMC_AUTH_FAILED",
        pause: true,
      });
      await prices();
      expect(get).toHaveBeenCalledTimes(2);
    },
  );
  test("HTTP 200 with an error code is not success; 5xx remains a provider failure", async () => {
    get
      .mockResolvedValueOnce(response([item()], "1008"))
      .mockResolvedValueOnce(response(null, 500, 503));
    await expect(prices()).rejects.toMatchObject({
      status: 429,
      code: "CMC_RATE_LIMITED",
    });
    await expect(prices()).rejects.toMatchObject({
      status: 502,
      code: "CMC_UNAVAILABLE",
    });
  });
  test("transport exceptions do not leak credentials", async () => {
    get.mockRejectedValue(new Error("sensitive-cmc-key transport details"));
    await expect(prices()).rejects.toMatchObject({
      code: "CMC_UNAVAILABLE",
      message: "External provider is unavailable",
    });
    expect(JSON.stringify((logger.log as jest.Mock).mock.calls)).not.toContain(
      "sensitive-cmc-key",
    );
  });

  test("different coins start before either response and can complete in reverse order", async () => {
    const releases = new Map<number, (value: AxiosResponse<unknown>) => void>();
    get.mockImplementation(
      (_path, options: AxiosRequestConfig) =>
        new Promise((resolve) => {
          releases.set(Number(options.params.id), resolve);
        }),
    );
    const first = prices([1]),
      second = prices([2]);
    await until(() => releases.size === 2);
    releases.get(2)!(response([item(2)]));
    expect((await second).quotes[0]!.cmcId).toBe(2);
    releases.get(1)!(response([item(1)]));
    await first;
    expect(get).toHaveBeenCalledTimes(2);
  });
  test("identical batches share one HTTP request regardless of ID order, with one consume per caller", async () => {
    let release!: () => void;
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(response([item(1), item(2)]));
        }),
    );
    const saved: number[] = [];
    const first = client.withPrices([2, 1], context, async (result) => {
      saved.push(1);
      return result;
    });
    const second = client.withPrices([1, 2], context, async (result) => {
      saved.push(2);
      return result;
    });
    await until(() => !!release);
    release();
    expect((await Promise.all([first, second]))[0]).toEqual(await second);
    expect(get).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([1, 2]);
    get.mockResolvedValue(response([item(1), item(2)]));
    await prices([1, 2]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  test("identical slugs share a failure and later requests retry without a poisoned entry", async () => {
    let release!: () => void;
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(response(null, 1008, 429));
        }),
    );
    const one = expect(
      client.resolveSlug("coin-1", context),
    ).rejects.toMatchObject({ code: "CMC_RATE_LIMITED" });
    const two = expect(
      client.resolveSlug("coin-1", context),
    ).rejects.toMatchObject({ code: "CMC_RATE_LIMITED" });
    await until(() => !!release);
    release();
    await Promise.all([one, two]);
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(response([item()]));
    await client.resolveSlug("coin-1", context);
    expect(get).toHaveBeenCalledTimes(2);
  });
  test("at most 32 unfinished operations are admitted; completion frees capacity without a per-minute cap", async () => {
    const releases: Array<() => void> = [];
    get.mockImplementation(
      (_path, options: AxiosRequestConfig) =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve(response([item(Number(options.params.id))])),
          );
        }),
    );
    const active = Array.from({ length: 32 }, (_, index) =>
      prices([index + 1]),
    );
    await until(() => releases.length === 32);
    await expect(prices([33])).rejects.toMatchObject({
      status: 503,
      code: "CMC_QUEUE_FULL",
    });
    releases.forEach((release) => release());
    await Promise.all(active);
    get.mockResolvedValue(response([item()]));
    for (let i = 0; i < 40; i++) await prices();
    expect(get).toHaveBeenCalledTimes(72);
  });
  test("network proceeds during persistence; shutdown and idle drain both ready commits", async () => {
    let release!: () => void;
    const first = client.withPrices([1], context, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 123;
    });
    await until(() => !!release);
    get.mockResolvedValue(response([item(2)]));
    let secondSaved = false;
    const second = client.withPrices([2], context, async (result) => {
      secondSaved = true;
      return result;
    });
    await until(() => get.mock.calls.length === 2);
    let idle = false;
    const drained = client.idle().then(() => {
      idle = true;
    });
    client.stop();
    expect(secondSaved).toBe(false);
    expect(idle).toBe(false);
    release();
    expect(await first).toBe(123);
    await second;
    await drained;
    expect(secondSaved).toBe(true);
    expect(idle).toBe(true);
    await expect(prices()).rejects.toMatchObject({ code: "CMC_CANCELLED" });
  });
  test("persistence failures stay storage failures and do not block the next consume", async () => {
    const failure = new AppError(503, "DB_OVERLOADED", "Storage failed");
    const first = expect(
      client.withPrices([1], context, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const second = client.withPrices([2], context, async () => "saved");
    await first;
    expect(await second).toBe("saved");
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "cmc_request",
      expect.objectContaining({ result: "success" }),
    );
    await expect(
      client.withPrices([1], context, async () =>
        client.resolveSlug("coin-1", context),
      ),
    ).rejects.toMatchObject({ code: "CMC_REENTRANT_CALL" });
  });
  test("stopping before an admitted microtask sends no HTTP", async () => {
    const pending = prices();
    client.stop();
    await expect(pending).rejects.toMatchObject({ code: "CMC_CANCELLED" });
    await client.idle();
    expect(get).not.toHaveBeenCalled();
  });

  test("real axios rejects malformed JSON and does not follow redirects", async () => {
    let redirected = false;
    await local((request, result) => {
      if (request.url === "/target") redirected = true;
      if (request.url?.includes("id=1")) {
        result.setHeader("Content-Type", "application/json");
        result.end("{broken");
      } else {
        result.writeHead(302, { location: "/target" });
        result.end();
      }
    });
    await expect(prices()).rejects.toMatchObject({
      code: "CMC_INVALID_RESPONSE",
    });
    await expect(prices([2])).rejects.toMatchObject({
      code: "CMC_UNAVAILABLE",
    });
    expect(redirected).toBe(false);
  });
  test("real axios timeout aborts a slow loopback server", async () => {
    await local(() => {}, 30);
    await expect(prices()).rejects.toMatchObject({
      code: "CMC_TIMEOUT",
      status: 504,
    });
  });
  test("global shutdown cancels shared and independent native HTTP and idle drains them", async () => {
    let received = 0,
      closed = 0;
    await local((_request, result) => {
      received++;
      result.once("close", () => {
        closed++;
      });
    });
    const calls = [prices([1]), prices([1]), prices([2])].map((call) =>
      expect(call).rejects.toMatchObject({ code: "CMC_CANCELLED" }),
    );
    await until(() => received === 2);
    client.stop();
    await Promise.all(calls);
    await client.idle();
    await until(() => closed === 2);
  });
});
