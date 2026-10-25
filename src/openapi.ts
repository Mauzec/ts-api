type Schema = Record<string, unknown>;
const integer = {
  type: "integer",
  format: "int64",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const count = { type: "integer", minimum: 0 };
const timestamp = { type: "string", format: "date-time" };
const nullableTime = { ...timestamp, nullable: true };
const reference = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): Schema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const array = (items: Schema): Schema => ({ type: "array", items });
const data = (schema: Schema): Schema => object({ data: schema });
const json = (description: string, schema: Schema) => ({
  description,
  content: { "application/json": { schema } },
});
const failure = { $ref: "#/components/responses/Error" };
const success = (schema: Schema, status = "200") => ({
  [status]: json("Success", schema),
  "400": failure,
  "401": failure,
  "403": failure,
  "429": failure,
  "503": failure,
  default: failure,
});
const parameter = (
  name: string,
  schema: Schema,
  description: string,
  required = false,
) => ({ name, in: "query", required, description, schema });
const idParameter = {
  name: "id",
  in: "path",
  required: true,
  description: "Personal subscription ID.",
  schema: integer,
};
const limitParameter = parameter(
  "limit",
  { type: "integer", minimum: 1, maximum: 500, default: 100 },
  "Maximum page size.",
);
const displayName = {
  type: "string",
  nullable: true,
  minLength: 1,
  maxLength: 120,
  description: "Trimmed local label.",
};
const price = { type: "number", format: "double", minimum: 0 };
const asset = object({
  id: integer,
  cmcId: integer,
  slug: { type: "string" },
  name: { type: "string" },
  displayName,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastCheckedAt: nullableTime,
});
const quote = object({ price, quotedAt: timestamp, receivedAt: timestamp });
const user = object({
  id: integer,
  login: { type: "string" },
  createdAt: timestamp,
});
const keyName = { type: "string", minLength: 1, maxLength: 64 };
const permission = { type: "string", enum: ["r", "rw"] };
const key = object({
  id: integer,
  name: keyName,
  permission,
  createdAt: timestamp,
});
const basic = [{ basicAuth: [] }];
const body = (schema: Schema, required = true) => ({
  required,
  content: { "application/json": { schema } },
});
const createBody = {
  oneOf: [
    object(
      {
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          example: "bitcoin",
          description: "CMC slug.",
        },
        displayName,
      },
      ["slug"],
    ),
  ],
};

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Crypto Tracker API",
    version: "2.0.0",
    description: "Personal USD cryptocurrency lists.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Cryptocurrencies" },
    { name: "Prices" },
    { name: "Users and keys" },
    { name: "Documentation" },
  ],
  paths: {
    "/api/v1/users": {
      post: {
        tags: ["Users and keys"],
        operationId: "registerUser",
        security: [],
        summary: "Register user.",
        requestBody: body(
          object({
            login: {
              type: "string",
              minLength: 3,
              maxLength: 64,
              pattern: "^[A-Za-z0-9_.-]+$",
              description: "Normalized.",
            },
            password: {
              type: "string",
              format: "password",
              minLength: 15,
              maxLength: 128,
              description: "No trimming or normalization.",
            },
          }),
        ),
        responses: {
          ...success(data(reference("User")), "201"),
          "409": failure,
        },
      },
    },
    "/api/v1/api-keys": {
      post: {
        tags: ["Users and keys"],
        operationId: "issueApiKey",
        security: basic,
        summary: "API keys.",
        requestBody: body(object({ name: keyName, permission })),
        responses: {
          ...success(data(reference("IssuedApiKey")), "201"),
          "409": failure,
        },
      },
      get: {
        tags: ["Users and keys"],
        operationId: "listApiKeys",
        security: basic,
        summary: "List your key metadata",
        responses: success(data(array(reference("ApiKey")))),
      },
    },
    "/api/v1/api-keys/{id}": {
      parameters: [{ ...idParameter, description: "Your API key ID." }],
      delete: {
        tags: ["Users and keys"],
        operationId: "revokeApiKey",
        security: basic,
        summary: "Delete your key.",
        responses: {
          "204": { description: "Key deleted" },
          "400": failure,
          "401": failure,
          "404": failure,
          "429": failure,
          "503": failure,
        },
      },
    },
    "/api/v1/cryptocurrencies": {
      get: {
        tags: ["Cryptocurrencies"],
        operationId: "listCryptocurrencies",
        summary: "List your cryptocurrency subscriptions",
        parameters: [
          parameter(
            "afterId",
            { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
            "Cursor.",
          ),
          limitParameter,
        ],
        responses: success(
          object({
            data: array(reference("Cryptocurrency")),
            pagination: object({ nextAfterId: { ...integer, nullable: true } }),
          }),
        ),
      },
      post: {
        tags: ["Cryptocurrencies"],
        operationId: "createCryptocurrency",
        summary: "Track a cryptocurrency and save its first USD quote",
        requestBody: body(createBody),
        responses: {
          ...success(data(reference("Cryptocurrency")), "201"),
          "409": failure,
          "422": failure,
          "429": failure,
          "502": failure,
          "503": failure,
          "504": failure,
        },
      },
    },
    "/api/v1/cryptocurrencies/{id}": {
      parameters: [idParameter],
      get: {
        tags: ["Cryptocurrencies"],
        operationId: "getCryptocurrency",
        summary: "Read your subscription.",
        responses: {
          ...success(data(reference("Cryptocurrency"))),
          "404": failure,
        },
      },
      patch: {
        tags: ["Cryptocurrencies"],
        operationId: "updateCryptocurrency",
        summary: "Change your display name (rw required)",
        description: "Only the personal changes",
        requestBody: body(object({ displayName })),
        responses: {
          ...success(data(reference("Cryptocurrency"))),
          "404": failure,
        },
      },
      delete: {
        tags: ["Cryptocurrencies"],
        operationId: "deleteSubscription",
        summary: "Delete your subscription (rw required)",
        description: "Shared market history remains.",
        responses: {
          "204": { description: "Subscription deleted." },
          "400": failure,
          "401": failure,
          "404": failure,
          "503": failure,
          default: failure,
        },
      },
    },
    "/api/v1/cryptocurrencies/{id}/price": {
      parameters: [idParameter],
      get: {
        tags: ["Prices"],
        operationId: "getLatestPrice",
        summary: "Read the latest saved USD price",
        responses: {
          ...success(data(reference("LatestPrice"))),
          "404": failure,
        },
      },
    },
    "/api/v1/cryptocurrencies/{id}/history": {
      parameters: [idParameter],
      get: {
        tags: ["Prices"],
        operationId: "getPriceHistory",
        summary: "Read saved observations.",
        parameters: [
          parameter("from", timestamp, "Start."),
          parameter("to", timestamp, "End."),
          parameter("after", timestamp, "Cursor"),
          limitParameter,
        ],
        responses: {
          ...success(
            object({
              data: array(reference("PricePoint")),
              currency: { type: "string", enum: ["USD"] },
              pagination: object({ nextAfter: nullableTime }),
            }),
          ),
          "404": failure,
        },
      },
    },
    "/api/v1/cryptocurrencies/{id}/ohlc": {
      parameters: [idParameter],
      get: {
        tags: ["Prices"],
        operationId: "getSampledOhlc",
        summary: "Candles",
        parameters: [
          parameter("from", timestamp, "Start.", true),
          parameter("to", timestamp, "End.", true),
          parameter(
            "interval",
            { type: "string", enum: ["1h", "1d"], default: "1h" },
            "UTC bucket size.",
          ),
        ],
        responses: {
          ...success(
            object({
              data: array(reference("Candle")),
              source: { type: "string", enum: ["sampled_quotes"] },
              currency: { type: "string", enum: ["USD"] },
              interval: { type: "string", enum: ["1h", "1d"] },
            }),
          ),
          "404": failure,
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Documentation"],
        operationId: "getOpenApi",
        security: [],
        summary: "Read this",
        responses: {
          "200": json("OpenAPI 3.0 document", { type: "object" }),
          "400": failure,
        },
      },
    },
    "/docs": {
      get: {
        tags: ["Documentation"],
        operationId: "getDocumentation",
        security: [],
        summary: "Swagger UI",
        responses: {
          "200": {
            description: "Swagger UI",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "400": failure,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "User API key.",
      },
      basicAuth: {
        type: "http",
        scheme: "basic",
        description: "Registered login and password",
      },
    },
    responses: {
      Error: {
        ...json("Request failure.", reference("Error")),
        headers: {
          "X-Request-ID": { schema: { type: "string", format: "uuid" } },
          "Retry-After": {
            description: "Seconds before retry.",
            schema: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    schemas: {
      Cryptocurrency: asset,
      PricePoint: quote,
      LatestPrice: object({
        cryptocurrencyId: integer,
        currency: { type: "string", enum: ["USD"] },
        price: { ...price, nullable: true },
        quotedAt: nullableTime,
        receivedAt: nullableTime,
        lastCheckedAt: nullableTime,
        stale: { type: "boolean" },
      }),
      Candle: object({
        bucket: timestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        count: integer,
      }),
      User: user,
      ApiKey: key,
      IssuedApiKey: object({
        id: integer,
        name: keyName,
        permission,
        createdAt: timestamp,
        apiKey: {
          type: "string",
        },
      }),
      Error: object({
        error: object(
          {
            code: {
              type: "string",
              example: "INVALID_INPUT",
            },
            message: { type: "string" },
            requestId: { type: "string", format: "uuid" },
          },
          ["code", "message", "requestId"],
        ),
      }),
    },
  },
};
