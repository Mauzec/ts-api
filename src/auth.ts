import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Storage } from "./db";
import { AppError } from "./errors";

export type Permission = "r" | "rw";
export interface User {
  id: number;
  login: string;
  createdAt: number;
}
export interface KeyMetadata {
  id: number;
  name: string;
  permission: Permission;
  createdAt: number;
}
export interface Principal {
  userId: number;
  keyId: number;
  permission: Permission;
}
interface PasswordUser extends User {
  passwordHash: string;
}

const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const passwordPrefix = "scrypt-v1";
const dummyPassword = `${passwordPrefix}$${Buffer.alloc(16).toString("hex")}$${Buffer.alloc(64).toString("hex")}`;
const unauthorized = (): AppError =>
  new AppError(401, "UNAUTHORIZED", "Invalid credentials");
const invalid = (message: string): never => {
  throw new AppError(400, "INVALID_INPUT", message);
};
const hashKey = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

export function normalizeLogin(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{3,64}$/.test(value))
    return invalid("Invalid password");
  return value.toLowerCase();
}

export function validatePassword(value: unknown): string {
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      length >= 15 &&
      length <= 128 &&
      Buffer.from(value).toString("utf8") === value
    )
      return value;
  }
  return invalid("Password must contain 15–128 characters");
}

export function validateKeyInput(
  name: unknown,
  permission: unknown,
): { name: string; permission: Permission } {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    [...name].length > 64 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    Buffer.from(name).toString("utf8") !== name
  )
    return invalid("Key name must contain 1–64 characters");
  if (permission !== "r" && permission !== "rw")
    return invalid("Permission must be r or rw");
  return { name, permission };
}

function basicCredentials(header: string | undefined): {
  login: string;
  password: string;
} {
  if (!header || header.length > 2048) throw unauthorized();
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) throw unauthorized();
  const encoded = match[1]!;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw unauthorized();
  let credentials: string;
  try {
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw unauthorized();
  }
  const colon = credentials.indexOf(":");
  if (colon < 0) throw unauthorized();
  try {
    return {
      login: normalizeLogin(credentials.slice(0, colon)),
      password: validatePassword(credentials.slice(colon + 1)),
    };
  } catch {
    throw unauthorized();
  }
}

export class AuthService {
  private hashing = 0;
  constructor(
    private readonly storage: Storage,
    private readonly now: () => number = Date.now,
  ) {}

  async register(
    loginInput: unknown,
    passwordInput: unknown,
    signal?: AbortSignal,
  ): Promise<User> {
    const login = normalizeLogin(loginInput);
    const password = validatePassword(passwordInput);
    const salt = randomBytes(16);
    const derived = await this.derive(password, salt, signal);
    const passwordHash = `${passwordPrefix}$${salt.toString("hex")}$${derived.toString("hex")}`;
    return this.storage.write(async (sql) => {
      if (await sql.get("SELECT id FROM users WHERE login = ?", [login]))
        throw new AppError(409, "LOGIN_EXISTS", "Login is already registered");
      const createdAt = this.now();
      const result = await sql.run(
        "INSERT INTO users (login, password_hash, created_at) VALUES (?, ?, ?)",
        [login, passwordHash, createdAt],
      );
      return { id: result.lastID, login, createdAt };
    }, signal);
  }

  async authenticateBasic(
    header: string | undefined,
    signal?: AbortSignal,
  ): Promise<User> {
    const { login, password } = basicCredentials(header);
    const user = await this.storage.read(
      (sql) =>
        sql.get<PasswordUser>(
          "SELECT id, login, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE login = ?",
          [login],
        ),
      signal,
    );
    const stored = user?.passwordHash ?? dummyPassword;
    const parts = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored);
    if (!parts)
      throw new AppError(
        503,
        "AUTH_UNAVAILABLE",
        "Password verification is unavailable",
      );
    const derived = await this.derive(
      password,
      Buffer.from(parts[1]!, "hex"),
      signal,
    );
    const matches = timingSafeEqual(derived, Buffer.from(parts[2]!, "hex"));
    if (!user || !matches) throw unauthorized();
    return { id: user.id, login: user.login, createdAt: user.createdAt };
  }

  async authenticateBearer(
    header: string | undefined,
    signal?: AbortSignal,
  ): Promise<Principal> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? "");
    if (!match) throw unauthorized();
    const principal = await this.storage.read(
      (sql) =>
        sql.get<Principal>(
          "SELECT user_id AS userId, id AS keyId, permission FROM api_keys WHERE key_hash = ?",
          [hashKey(match[1]!)],
        ),
      signal,
    );
    if (!principal) throw unauthorized();
    return principal;
  }

  async issue(
    userId: number,
    nameInput: unknown,
    permissionInput: unknown,
    signal?: AbortSignal,
  ): Promise<KeyMetadata & { apiKey: string }> {
    const { name, permission } = validateKeyInput(nameInput, permissionInput);
    return this.storage.write(async (sql) => {
      if (
        await sql.get(
          "SELECT id FROM api_keys WHERE user_id = ? AND name = ?",
          [userId, name],
        )
      )
        throw new AppError(
          409,
          "KEY_NAME_EXISTS",
          "Key name is already in use",
        );
      const count = await sql.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?",
        [userId],
      );
      if (count!.count >= 3)
        throw new AppError(
          409,
          "KEY_LIMIT_REACHED",
          "A user can have only three keys in a moment",
        );
      const apiKey = randomBytes(32).toString("base64url");
      const createdAt = this.now();
      const result = await sql.run(
        "INSERT INTO api_keys (user_id, name, key_hash, permission, created_at) VALUES (?, ?, ?, ?, ?)",
        [userId, name, hashKey(apiKey), permission, createdAt],
      );
      return { id: result.lastID, name, permission, createdAt, apiKey };
    }, signal);
  }

  list(userId: number, signal?: AbortSignal): Promise<KeyMetadata[]> {
    return this.storage.read(
      (sql) =>
        sql.all<KeyMetadata>(
          "SELECT id, name, permission, created_at AS createdAt FROM api_keys WHERE user_id = ? ORDER BY id",
          [userId],
        ),
      signal,
    );
  }

  async remove(
    userId: number,
    keyId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.write(async (sql) => {
      const result = await sql.run(
        "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
        [keyId, userId],
      );
      if (!result.changes)
        throw new AppError(404, "NOT_FOUND", "API key not found");
    }, signal);
  }

  private async derive(
    password: string,
    salt: Buffer,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const cancelled = (): void => {
      if (signal?.aborted)
        throw new AppError(
          503,
          "AUTH_CANCELLED",
          "Authentication is cancelled",
        );
    };
    cancelled();
    if (this.hashing >= 2)
      throw new AppError(503, "AUTH_BUSY", "Password verification is bus");
    this.hashing++;
    try {
      const derived = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, passwordOptions, (error, value) =>
          error
            ? reject(new AppError(503, "AUTH_UNAVAILABLE", "Can't verify auth"))
            : resolve(value),
        );
      });
      cancelled();
      return derived;
    } finally {
      this.hashing--;
    }
  }
}
