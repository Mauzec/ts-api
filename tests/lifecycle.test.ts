import { createServer, type Server } from 'node:http';
import axios from 'axios';
import { start, type APIServer } from '../src/main';
import { openDatabase } from '../src/db';
import { CmcClient } from '../src/cmc';
import { config, FakeProvider, fixture, logger, seedKey, seedUser } from './helpers';

let f: Awaited<ReturnType<typeof fixture>>;
let running: APIServer | undefined;
let mock: Server | undefined;
let token: string;
const base = () => `http://127.0.0.1:${(running!.server.address() as { port: number }).port}`;
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const settings = () => config({ dbPath: f.path, port: 0, cmcPriceSyncEnabled: false, shutDownMs: 3000 });

beforeEach(async () => {
  f = await fixture();
  token = (await seedKey(f.db, await seedUser(f.db))).apiKey;
  await f.db.close();
});
afterEach(async () => {
  const current = running;
  running = undefined;
  try {
    if (current) await current.close('test_cleanup');
  } finally {
    if (mock) {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock!.close(() => resolve()));
      mock = undefined;
    }
    await f.close();
  }
});

test('real HTTP listener, idempotent shutdown and restart preserve keys and observations', async () => {
  const provider = new FakeProvider();
  running = await start(settings(), { provider, logger });
  const created = await fetch(`${base()}/api/v1/cryptocurrencies`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ cmcId: 1 }),
  });
  expect(created.status).toBe(201);
  const asset = (await created.json() as { data: { id: number } }).data;
  const closing = running.close('restart');
  expect(running.close('again')).toBe(closing);
  await closing;
  expect(provider.stop).toHaveBeenCalledTimes(1);
  expect(running.server.listening).toBe(false);
  const secondProvider = new FakeProvider();
  running = await start(settings(), { provider: secondProvider, logger });
  const price = await fetch(`${base()}/api/v1/cryptocurrencies/${asset.id}/price`, { headers: headers() });
  expect(price.status).toBe(200);
  expect((await price.json() as { data: unknown }).data).toMatchObject({ price: 100, currency: 'USD' });
  expect(secondProvider.prices).not.toHaveBeenCalled();
});

test('shutdown aborts real axios network and drains the HTTP handler without a partial subscription', async () => {
  let entered!: () => void;
  const upstream = new Promise<void>(resolve => { entered = resolve; });
  mock = createServer(() => { entered(); });
  await new Promise<void>(resolve => mock!.listen(0, '127.0.0.1', resolve));
  const cfg = settings();
  const provider = new CmcClient(cfg, logger, {
    transport: axios.create({ baseURL: `http://127.0.0.1:${(mock.address() as { port: number }).port}` }),
  });
  running = await start(cfg, { provider, logger });
  const request = fetch(`${base()}/api/v1/cryptocurrencies`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ cmcId: 1 }),
  });
  await upstream;
  const closing = running.close('pending_network');
  const response = await request;
  expect(response.status).toBe(503);
  expect((await response.json() as { error: unknown }).error).toMatchObject({ code: 'CMC_CANCELLED' });
  await closing;
  const db = await openDatabase(f.path);
  try {
    expect(await db.read(sql => sql.get('SELECT COUNT(*) AS n FROM user_currencies'))).toEqual({ n: 0 });
    expect(await db.read(sql => sql.get('PRAGMA quick_check'))).toEqual({ quick_check: 'ok' });
  } finally { await db.close(); }
});

test('startup listener failure closes its provider and database connections', async () => {
  mock = createServer();
  await new Promise<void>(resolve => mock!.listen(0, '127.0.0.1', resolve));
  const provider = new FakeProvider();
  await expect(start({ ...settings(), port: (mock.address() as { port: number }).port }, { provider, logger }))
    .rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(provider.stop).toHaveBeenCalledTimes(1);
  expect(provider.idle).toHaveBeenCalledTimes(1);
  const db = await openDatabase(f.path);
  try { await expect(db.write(sql => sql.run("UPDATE sync_state SET status='recovered'"))).resolves.toMatchObject({ changes: 1 }); }
  finally { await db.close(); }
});
