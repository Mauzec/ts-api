import http from "node:http";
import https from "node:https";
import net from "node:net";

function guard(original: typeof http.request): typeof http.request {
  return function (this: unknown, ...args: unknown[]) {
    const target = args[0];
    let host: string | undefined;
    if (typeof target === "string" || target instanceof URL)
      host = new URL(target).hostname;
    else if (target && typeof target === "object") {
      const options = target as { hostname?: string; host?: string };
      host = options.hostname ?? options.host ?? "localhost";
    }
    if (!host || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host))
      throw new Error("External network is forbidden in tests");
    return Reflect.apply(original, this, args);
  } as typeof http.request;
}
const httpRequest = http.request;
const httpsRequest = https.request;
const fetchRequest = globalThis.fetch;
const socketConnect = net.Socket.prototype.connect;
beforeAll(() => {
  http.request = guard(httpRequest);
  https.request = guard(httpsRequest);
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
      throw new Error("External network is forbidden in tests");
    return fetchRequest(input, init);
  };
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const first = normalized[0];
    const host =
      first && typeof first === "object"
        ? (first as { host?: string }).host
        : typeof normalized[1] === "string"
          ? normalized[1]
          : undefined;
    if (!host || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host))
      throw new Error("External network is forbidden in tests");
    return Reflect.apply(socketConnect, this, args);
  } as typeof socketConnect;
});
afterAll(() => {
  http.request = httpRequest;
  https.request = httpsRequest;
  globalThis.fetch = fetchRequest;
  net.Socket.prototype.connect = socketConnect;
});
