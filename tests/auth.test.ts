import crypto, { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService, normalizeLogin, validateKeyInput, validatePassword } from '../src/auth';
import { openDatabase, type Storage } from '../src/db';

const password = '  correct horse battery staple  ';
const basic = (login: string, value = password): string => `Basic ${Buffer.from(`${login}:${value}`).toString('base64')}`;
let directory: string;
let storage: Storage;
let auth: AuthService;
let userId: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracker-auth-'));
  storage = await openDatabase(join(directory, 'db.sqlite'));
  auth = new AuthService(storage, () => 1000);
  userId = await storage.write(async sql => (await sql.run('INSERT INTO users(login,password_hash,created_at) VALUES(?,?,?)', ['seeded', 'unused', 1])).lastID);
});
afterEach(async () => { jest.restoreAllMocks(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

test('registration normalizes login, preserves password whitespace and stores independently salted versioned hashes', async () => {
  const first = await auth.register('Alice.Example', password);
  const second = await auth.register('bob', password);
  expect(first).toEqual({ id: first.id, login: 'alice.example', createdAt: 1000 });
  const rows = await storage.read(sql => sql.all<{ password_hash: string }>('SELECT password_hash FROM users WHERE id IN (?,?)', [first.id, second.id]));
  for (const row of rows) {
    expect(row.password_hash).toMatch(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(row.password_hash).not.toContain(password);
  }
  expect(rows[0]!.password_hash).not.toEqual(rows[1]!.password_hash);
  await expect(auth.authenticateBasic(basic('ALICE.EXAMPLE'))).resolves.toEqual(first);
  await expect(auth.authenticateBasic(basic('alice.example', password.trim()))).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  await expect(auth.register('ALICE.EXAMPLE', password)).rejects.toMatchObject({ status: 409, code: 'LOGIN_EXISTS' });
});

test('unknown login and wrong password return the same error with the same password work', async () => {
  await auth.register('alice', password);
  const hashing = jest.spyOn(crypto, 'scrypt');
  const known = await auth.authenticateBasic(basic('alice', 'wrong password of enough length')).catch(error => error);
  const missing = await auth.authenticateBasic(basic('missing', 'wrong password of enough length')).catch(error => error);
  expect({ code: missing.code, status: missing.status, message: missing.message }).toEqual({ code: known.code, status: known.status, message: known.message });
  expect(missing).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  expect(hashing).toHaveBeenCalledTimes(2);
});

test('at most two password computations run and SQLite remains available while they run', async () => {
  const first = auth.register('alice', password);
  const second = auth.register('bob', password);
  const rejected = auth.register('charlie', password);
  await expect(rejected).rejects.toMatchObject({ status: 503, code: 'AUTH_BUSY' });
  const winner = await Promise.race([storage.read(sql => sql.get('SELECT 1')).then(() => 'sql'), first.then(() => 'hash')]);
  expect(winner).toBe('sql');
  await Promise.all([first, second]);
  await expect(auth.register('charlie', password)).resolves.toMatchObject({ login: 'charlie' });
});

test('password cancellation releases capacity and does not create a user', async () => {
  const controller = new AbortController();
  const registration = auth.register('alice', password, controller.signal);
  controller.abort();
  await expect(registration).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
  expect(await storage.read(sql => sql.get('SELECT id FROM users WHERE login = ?', ['alice']))).toBeUndefined();
  await expect(auth.register('bob', password, controller.signal)).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
  await expect(auth.register('bob', password)).resolves.toMatchObject({ login: 'bob' });
});

test('API keys contain 256 random bits, only hashes persist, metadata never reveals secrets', async () => {
  const key = await auth.issue(userId, 'laptop', 'rw');
  expect(key.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(key.apiKey, 'base64url')).toHaveLength(32);
  const stored = await storage.read(sql => sql.get<{ key_hash: string }>('SELECT key_hash FROM api_keys WHERE id = ?', [key.id]));
  expect(stored!.key_hash).toBe(createHash('sha256').update(key.apiKey).digest('hex'));
  expect(JSON.stringify(stored)).not.toContain(key.apiKey);
  await expect(auth.authenticateBearer(`Bearer ${key.apiKey}`)).resolves.toEqual({ userId, keyId: key.id, permission: 'rw' });
  await expect(auth.list(userId)).resolves.toEqual([{ id: key.id, name: 'laptop', permission: 'rw', createdAt: 1000 }]);
});

test.each(['label\ud800end', 'label\ud801end', 'label\udc00end', 'label\udc01end'])('rejects an unpaired surrogate in key name without inserting a key: %j', async name => {
  await expect(auth.issue(userId, name, 'r')).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  expect(await auth.list(userId)).toEqual([]);
});

test('key names preserve valid astral Unicode through storage', async () => {
  const name = 'Laptop 🦉🔑';
  const issued = await auth.issue(userId, name, 'r');
  expect(issued.name).toBe(name);
  expect(await auth.list(userId)).toEqual([{ id: issued.id, name, permission: 'r', createdAt: 1000 }]);
});

test('parallel issuance at the limit inserts exactly one key and rollback leaves valid keys intact', async () => {
  await auth.issue(userId, 'one', 'r');
  await auth.issue(userId, 'two', 'rw');
  const results = await Promise.allSettled([auth.issue(userId, 'three', 'r'), auth.issue(userId, 'four', 'rw')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ status: 409, code: 'KEY_LIMIT_REACHED' });
  expect(await auth.list(userId)).toHaveLength(3);
});

test('names are unique per user, revocation is owner scoped, and a deleted key never authenticates again', async () => {
  const otherId = await storage.write(async sql => (await sql.run('INSERT INTO users(login,password_hash,created_at) VALUES(?,?,?)', ['other', 'unused', 1])).lastID);
  const first = await auth.issue(userId, 'laptop', 'r');
  const other = await auth.issue(otherId, 'laptop', 'rw');
  await expect(auth.issue(userId, 'laptop', 'rw')).rejects.toMatchObject({ code: 'KEY_NAME_EXISTS' });
  await expect(auth.remove(userId, other.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  expect(await auth.list(userId)).toHaveLength(1);
  await auth.remove(userId, first.id);
  await expect(auth.authenticateBearer(`Bearer ${first.apiKey}`)).rejects.toMatchObject({ status: 401 });
  await expect(auth.remove(userId, first.id)).rejects.toMatchObject({ status: 404 });
  const replacement = await auth.issue(userId, 'laptop', 'rw');
  expect(replacement.id).not.toBe(first.id);
  expect(replacement.apiKey).not.toBe(first.apiKey);
  await expect(auth.authenticateBearer(`Bearer ${other.apiKey}`)).resolves.toMatchObject({ userId: otherId });
});

test.each([undefined, '', 'Basic invalid%', 'Bearer abc', 'Basic YWJjOmRlZg==', 'Basic YWJj', 'Basic /w==', 'Basic YWJjOmRlZg==='])('malformed Basic credentials fail safely: %s', async header => {
  await expect(auth.authenticateBasic(header)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
});

test.each([undefined, '', 'Basic abc', 'Bearer abc', `Bearer ${'a'.repeat(44)}`, `Bearer ${'a'.repeat(43)}`])('invalid Bearer key fails safely: %s', async header => {
  await expect(auth.authenticateBearer(header)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
});

test('validation has explicit bounds and never trims or normalizes passwords', () => {
  expect(normalizeLogin('ABC_123.-')).toBe('abc_123.-');
  for (const login of ['ab', 'a'.repeat(65), ' spaced ', 'логин', 123]) expect(() => normalizeLogin(login)).toThrow();
  for (const length of [15, 128]) expect(validatePassword('🦉'.repeat(length))).toBe('🦉'.repeat(length));
  expect(validatePassword(' '.repeat(15))).toBe(' '.repeat(15));
  for (const value of ['a'.repeat(14), 'a'.repeat(129), '🦉'.repeat(14), '🦉'.repeat(129), '\ud800'.repeat(15), null]) expect(() => validatePassword(value)).toThrow();
  expect(validateKeyInput('Laptop', 'r')).toEqual({ name: 'Laptop', permission: 'r' });
  for (const name of ['', '  ', 'a'.repeat(65), 'newline\n', 1]) expect(() => validateKeyInput(name, 'r')).toThrow();
  expect(() => validateKeyInput('name', 'admin')).toThrow();
});
