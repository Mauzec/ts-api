import request, { type Test } from 'supertest';
import axios from 'axios';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { AuthService } from '../src/auth';
import { CmcClient } from '../src/cmc';
import { AppError } from '../src/errors';
import { Repository } from '../src/repo';
import { TrackingService } from '../src/services';
import { HttpOperations } from '../src/http-operations';
import { config, fixture, FakeProvider, logger, quote, seedUser, seedKey } from './helpers';

let f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>, repo: Repository;
let provider: FakeProvider, operations: HttpOperations, now: number, uid: number, other: number, rw: string, ro: string, foreign: string;
const base = '/api/v1/cryptocurrencies';
const bearer = (test: Test, token = rw): Test => test.set('Authorization', `Bearer ${token}`);
beforeEach(async () => {
  now = Date.UTC(2026, 9, 22, 12);
  f = await fixture(); repo = new Repository(f.db); provider = new FakeProvider(); operations = new HttpOperations();
  uid = await seedUser(f.db); other = await seedUser(f.db, 'second');
  rw = (await seedKey(f.db, uid)).apiKey; ro = (await seedKey(f.db, uid, 'r', 'reader')).apiKey;
  foreign = (await seedKey(f.db, other)).apiKey;
  provider.prices.mockImplementation(async ids => ({ quotes: ids.map(id => quote(id, now)), errorIds: [] }));
  app = createApp({ storage: f.db, config: config(), repository: repo, tracking: new TrackingService(repo, provider, () => now), logger, now: () => now, operations });
});
afterEach(async () => { await operations.idle(); await f.close(); jest.restoreAllMocks(); });

test('personal CRUD reuses a shared quote, preserves history, and rejoin gets a new ID', async () => {
  const a = (await bearer(request(app).post(base)).send({ cmcId: 1, displayName: 'Mine' }).expect(201)).body.data;
  const b = (await bearer(request(app).post(base), foreign).send({ cmcId: 1, displayName: 'Theirs' }).expect(201)).body.data;
  expect(a.id).not.toBe(b.id); expect(a).not.toHaveProperty('cryptoId');
  expect(provider.prices).toHaveBeenCalledTimes(1);
  expect((await bearer(request(app).get(base)).expect(200)).body.data).toEqual([a]);
  expect((await bearer(request(app).get(`${base}/${a.id}`)).expect(200)).body.data).toEqual(a);
  await bearer(request(app).post(base)).send({ cmcId: 1 }).expect(409);
  await bearer(request(app).patch(`${base}/${a.id}`)).send({ displayName: 'Edited' }).expect(200);
  expect((await bearer(request(app).get(`${base}/${b.id}`), foreign).expect(200)).body.data.displayName).toBe('Theirs');
  await bearer(request(app).delete(`${base}/${a.id}`)).expect(204);
  await bearer(request(app).delete(`${base}/${a.id}`)).expect(404);
  await bearer(request(app).get(`${base}/${a.id}/history`)).expect(404);
  await bearer(request(app).delete(`${base}/${b.id}`), foreign).expect(204);
  expect(await f.db.read(sql => sql.all('SELECT * FROM active_tracking'))).toEqual([]);
  now += 3600000;
  const joined = (await bearer(request(app).post(base)).send({ cmcId: 1 }).expect(201)).body.data;
  expect(joined.id).not.toBe(a.id);
  expect((await bearer(request(app).get(`${base}/${joined.id}/price`)).expect(200)).body.data).toMatchObject({ price: 100, stale: true, currency: 'USD' });
  expect((await bearer(request(app).get(`${base}/${joined.id}/history`)).expect(200)).body.data).toHaveLength(1);
  expect(provider.prices).toHaveBeenCalledTimes(1);
});

test.each(['', '/price', '/history', '/ohlc?from=2026-10-22T00:00:00Z&to=2026-10-23T00:00:00Z'])('foreign and missing IDs are indistinguishable on GET %s', async suffix => {
  const a = await repo.create(uid, quote(1, now), null, now);
  const hidden = await bearer(request(app).get(`${base}/${a.id}${suffix}`), foreign).expect(404);
  const missing = await bearer(request(app).get(`${base}/999${suffix}`), foreign).expect(404);
  expect(hidden.body.error.code).toBe(missing.body.error.code);
  expect(hidden.body.error.message).toBe(missing.body.error.message);
});
test.each(['patch', 'delete'] as const)('foreign %s returns 404 and does not change the owner', async method => {
  const a = await repo.create(uid, quote(1, now), null, now);
  const req = bearer(request(app)[method](`${base}/${a.id}`), foreign);
  if (method === 'patch') req.send({ displayName: 'Unauthorized' });
  await req.expect(404);
  expect((await repo.get(uid, a.id)).displayName).toBeNull();
});
test.each(['post', 'patch', 'delete'] as const)('read-only key cannot %s', async method => {
  const a = await repo.create(uid, quote(1, now), null, now);
  const req = bearer(request(app)[method](method === 'post' ? base : `${base}/${a.id}`), ro);
  if (method !== 'delete') req.send(method === 'post' ? { cmcId: 2 } : { displayName: 'No' });
  expect((await req.expect(403)).body.error.code).toBe('FORBIDDEN');
  await bearer(request(app).get(base), ro).expect(200);
  expect(provider.prices).not.toHaveBeenCalled();
});
test.each([undefined, 'Bearer wrong', 'Basic dGVzdDp0ZXN0', 'Bearer', 'Token abc'])('rejects invalid Bearer auth %j', async header => {
  const req = request(app).get(base); if (header) req.set('Authorization', header);
  const res = await req.expect(401); expect(res.headers['www-authenticate']).toBe('Bearer');
});

test('one IP shares the 120-request window across routes and keys; spoofed proxy headers do not bypass it', async () => {
  for (let i = 0; i < 119; i++) {
    await request(app).get('/api/v1/missing')
      .set('X-Forwarded-For', `10.0.0.${i}`)
      .expect(404);
  }
  await bearer(request(app).get(base), ro).expect(200);
  const limited = await bearer(request(app).get(base), foreign).expect(429);
  expect(limited.body.error.code).toBe('RATE_LIMITED');
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
  expect(limited.headers['ratelimit-limit']).toBe('120');
  expect(limited.headers['x-ratelimit-limit']).toBeUndefined();
  await request(app).get('/docs').expect(200);
  await request(app).get('/openapi.json').expect(200);
  expect(provider.prices).not.toHaveBeenCalled();
});

test('limiter rejects before JSON parsing, authentication or SQLite and belongs to each app instance', async () => {
  const read = jest.spyOn(f.db, 'read');
  const write = jest.spyOn(f.db, 'write');
  for (let i = 0; i < 120; i++) await request(app).get('/api/v1/missing').expect(404);
  const response = await request(app).post('/api/v1/users').type('json').send('{invalid').expect(429);
  expect(response.body.error.code).toBe('RATE_LIMITED');
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const fresh = createApp({ storage: f.db, config: config(), repository: repo,
    tracking: new TrackingService(repo, provider, () => now), logger, operations });
  await request(fresh).get('/api/v1/missing').expect(404);
  read.mockRestore(); write.mockRestore();
});

test('history and OHLC use shared saved observations and paginate without repeats', async () => {
  const a = await repo.create(uid, quote(1, now, 100), null, now);
  await f.db.write(async sql => {
    for (const [offset, price] of [[30,105],[10,110],[20,90]]) await sql.run('INSERT INTO price_history(cryptocurrency_id,price,quoted_at,received_at) VALUES(?,?,?,?)', [a.cryptoId,price!,now+offset!*1000,now]);
  });
  const first = (await bearer(request(app).get(`${base}/${a.id}/history?limit=2`)).expect(200)).body;
  const second = (await bearer(request(app).get(`${base}/${a.id}/history`).query({ after: first.pagination.nextAfter })).expect(200)).body;
  expect([...first.data,...second.data].map((p: {price:number}) => p.price)).toEqual([100,110,90,105]);
  const candle = await bearer(request(app).get(`${base}/${a.id}/ohlc`).query({ from:new Date(now).toISOString(),to:new Date(now+3600000).toISOString() })).expect(200);
  expect(candle.body.data).toEqual([{bucket:new Date(now).toISOString(),open:100,high:110,low:90,close:105,count:4}]);
  expect(candle.body.source).toBe('sampled_quotes');
  expect(provider.prices).not.toHaveBeenCalled();
});

test.each([
  ['/cryptocurrencies?limit=2&limit=3', undefined], ['/cryptocurrencies?state=active', undefined],
  ['/cryptocurrencies?limit=501', undefined], ['/cryptocurrencies/0', undefined], ['/cryptocurrencies/1.5', undefined],
  ['/cryptocurrencies/1/history?from=not-a-date', undefined], ['/cryptocurrencies/1/ohlc', undefined],
  ['/cryptocurrencies/1/ohlc?from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z', undefined],
  ['/cryptocurrencies/1/history?from=2026-10-23T00:00:00Z&to=2026-10-22T00:00:00Z', undefined],
])('rejects invalid query %s', async path => { await bearer(request(app).get(`/api/v1${path}`)).expect(400); });
test.each([{}, {cmcId:1,slug:'bitcoin'}, {cmcId:0}, {cmcId:'1'}, {slug:''}, {symbol:'BTC'}, {slug:'bitcoin/usd'}, {slug:'a'.repeat(201)}, {cmcId:1,unknown:1}, {cmcId:1,displayName:'\u0000'}])('rejects invalid create %j', async body => { await bearer(request(app).post(base)).send(body).expect(400); });
test.each([{}, {state:'archived'}, {displayName:''}, {displayName:'a'.repeat(121)}])('rejects invalid patch %j', async body => { await bearer(request(app).patch(`${base}/1`)).send(body).expect(400); });

describe.each(['label\ud800end', 'label\ud801end', 'label\udc00end', 'label\udc01end'])('unpaired surrogate displayName %j', displayName => {
  test('creation fails before a provider request or partial subscription', async () => {
    const response = await bearer(request(app).post(base)).send({ cmcId: 1, displayName }).expect(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(provider.prices).not.toHaveBeenCalled();
    expect((await repo.list(uid, { afterId: 0, limit: 100 })).items).toEqual([]);
    expect(await repo.findByCmcId(1)).toBeUndefined();
  });
  test('patch leaves the stored personal name unchanged', async () => {
    const asset = await repo.create(uid, quote(1, now), 'Original', now);
    const response = await bearer(request(app).patch(`${base}/${asset.id}`)).send({ displayName }).expect(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect((await repo.get(uid, asset.id)).displayName).toBe('Original');
  });
});

test('personal display names preserve valid astral Unicode on create and patch', async () => {
  const created = await bearer(request(app).post(base)).send({ cmcId: 1, displayName: 'Mine 🦉' }).expect(201);
  expect(created.body.data.displayName).toBe('Mine 🦉');
  const updated = await bearer(request(app).patch(`${base}/${created.body.data.id}`)).send({ displayName: 'Savings 🪙' }).expect(200);
  expect(updated.body.data.displayName).toBe('Savings 🪙');
  expect((await repo.get(uid, created.body.data.id)).displayName).toBe('Savings 🪙');
});
test('JSON and media boundaries reject without leaking parser input', async () => {
  await bearer(request(app).post(base)).type('text').send('secret').expect(415);
  const invalid = await bearer(request(app).post(base)).type('json').send('{secret').expect(400);
  expect(JSON.stringify(invalid.body)).not.toContain('{secret');
  await bearer(request(app).post(base)).send({slug:'a'.repeat(17000)}).expect(413);
  await bearer(request(app).get(base)).send({unexpected:true}).expect(400);
});
test('slug ambiguity, unknown asset, and invalid quote have no partial membership', async () => {
  provider.resolveSlug.mockResolvedValueOnce([{cmcId:1,name:'One',slug:'coin-x'},{cmcId:2,name:'Two',slug:'coin-x'}]);
  expect((await bearer(request(app).post(base)).send({slug:' coin-x '}).expect(409)).body.error.code).toBe('AMBIGUOUS_SLUG');
  provider.resolveSlug.mockResolvedValueOnce([]);
  await bearer(request(app).post(base)).send({slug:'missing'}).expect(422);
  provider.prices.mockResolvedValueOnce({quotes:[],errorIds:[1]});
  await bearer(request(app).post(base)).send({cmcId:1}).expect(422);
  expect((await repo.list(uid,{afterId:0,limit:100})).items).toEqual([]);
});

test('creation resolves the normalized CMC slug and returns no internal catalog ID', async () => {
  const created = await bearer(request(app).post(base))
    .send({ slug: '  BitCoin  ' }).expect(201);
  expect(provider.resolveSlug).toHaveBeenCalledWith('bitcoin', expect.objectContaining({ requestId: expect.any(String) }));
  expect(provider.prices).toHaveBeenCalledWith([1], expect.objectContaining({ requestId: expect.any(String) }));
  expect(created.body.data).toHaveProperty('slug', 'coin-1');
  expect(created.body.data).not.toHaveProperty('cryptoId');
  expect(created.body.data).not.toHaveProperty('symbol');
});

test('ethereum creation uses the v2 slug and ID requests and persists its first price', async () => {
  const expectedQueries = [
    'convert=USD&skip_invalid=true&slug=ethereum',
    'convert=USD&id=1027&include_last_updated=true&skip_invalid=true',
  ];
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    url.searchParams.sort();
    const valid = req.method === 'GET' && url.pathname === '/v2/simple/price' &&
      url.searchParams.toString() === expectedQueries[calls.length];
    calls.push(url.pathname + url.search);
    res.setHeader('Content-Type', 'application/json');
    if (!valid) {
      res.writeHead(400);
      res.end(JSON.stringify({ status: { error_code: 400, error_message: 'Invalid endpoint or parameters' } }));
      return;
    }
    res.end(JSON.stringify({
      status: { error_code: 0, credit_count: 1 },
      data: [{ id: 1027, name: 'Ethereum', slug: 'ethereum', quotes: [
        { symbol: 'USD', price: 3210.25, last_updated: new Date(now).toISOString() },
      ] }],
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const settings = config({ cmcTimeoutMs: 1000 });
  const cmc = new CmcClient(settings, logger, {
    now: () => now,
    transport: axios.create({ baseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }),
  });
  try {
    app = createApp({ storage: f.db, config: settings, repository: repo,
      tracking: new TrackingService(repo, cmc, () => now), logger, now: () => now, operations });
    const created = await bearer(request(app).post(base))
      .send({ displayName: 'ethereum', slug: 'ethereum' }).expect(201);
    const asset = created.body.data;
    expect(asset).toMatchObject({ id: expect.any(Number), cmcId: 1027, name: 'Ethereum', slug: 'ethereum', displayName: 'ethereum' });
    expect((await bearer(request(app).get(base)).expect(200)).body.data).toEqual([asset]);
    const price = await bearer(request(app).get(`${base}/${asset.id}/price`)).expect(200);
    expect(price.body.data).toMatchObject({ cryptocurrencyId: asset.id, currency: 'USD', price: 3210.25,
      quotedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), stale: false });
    expect(calls).toEqual(expectedQueries.map(query => `/v2/simple/price?${query}`));
  } finally {
    cmc.stop();
    await cmc.idle();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('CMC rate errors keep their own code and retry header without creating a subscription', async () => {
  provider.prices.mockRejectedValueOnce(new AppError(429, 'CMC_RATE_LIMITED', 'Provider rate limit exceeded', {
    retryAt: now + 7_000, details: { cmcCode: 1008 },
  }));
  const response = await bearer(request(app).post(base)).send({ cmcId: 1 }).expect(429);
  expect(response.body.error).toMatchObject({ code: 'CMC_RATE_LIMITED', details: { cmcCode: 1008 } });
  expect(response.headers['retry-after']).toBe('7');
  expect((await repo.list(uid, { afterId: 0, limit: 100 })).items).toEqual([]);
});

test('registration, Basic issue/list/revoke and key limit form a complete public flow', async () => {
  const password = ' a permanent password with spaces ';
  const registered = await request(app).post('/api/v1/users').send({login:'New.User',password}).expect(201);
  expect(registered.body.data.login).toBe('new.user'); expect(registered.body.data).not.toHaveProperty('password');
  const credentials = `Basic ${Buffer.from(`new.user:${password}`).toString('base64')}`;
  const issue = async (name:string) => request(app).post('/api/v1/api-keys').set('Authorization',credentials).send({name,permission:'rw'});
  const one = await issue('Laptop'); expect(one.status).toBe(201);
  expect((await issue('Laptop')).status).toBe(409);
  expect((await issue('CLI')).status).toBe(201); expect((await issue('Backup')).status).toBe(201);
  expect((await issue('Fourth')).status).toBe(409);
  const listed = await request(app).get('/api/v1/api-keys').set('Authorization',credentials).expect(200);
  expect(listed.body.data).toHaveLength(3); expect(JSON.stringify(listed.body)).not.toContain(one.body.data.apiKey);
  await bearer(request(app).get(base),one.body.data.apiKey).expect(200);
  await request(app).delete(`/api/v1/api-keys/${one.body.data.id}`).set('Authorization',credentials).expect(204);
  await bearer(request(app).get(base),one.body.data.apiKey).expect(401);
  expect((await issue('Replacement')).status).toBe(201);
  expect(JSON.stringify((logger.log as jest.Mock).mock.calls)).not.toContain(password);
  expect(JSON.stringify((logger.log as jest.Mock).mock.calls)).not.toContain(one.body.data.apiKey);
});
test.each(['get','post','delete'] as const)('key management %s needs Basic; Bearer cannot mint privileges', async method => {
  const req = bearer(request(app)[method](`/api/v1/api-keys${method === 'delete' ? '/1' : ''}`));
  if(method==='post')req.send({name:'bad',permission:'rw'});
  await req.expect(401);
});
test('wrong and unknown Basic credentials return the same safe failure', async () => {
  const auth = new AuthService(f.db, () => now);
  await auth.register('known', 'correct-password-123');
  const login = (name: string) => request(app).get('/api/v1/api-keys').auth(name, 'wrong-password-123');
  const wrong = await login('known').expect(401), missing = await login('missing').expect(401);
  expect(wrong.body.error.message).toBe(missing.body.error.message);
  expect(wrong.headers['www-authenticate']).toContain('Basic');
});
test.each([{login:'a',password:'a'.repeat(15)},{login:'ok-user',password:'short'},{login:'ok-user',password:'a'.repeat(15),extra:true}])('invalid registration %j', async body => {
  await request(app).post('/api/v1/users').send(body).expect(400);
});
test('static docs are public, all real paths documented, removed operations are absent', async () => {
  await request(app).get('/docs').expect(200); await request(app).get('/docs?extra=1').expect(400);
  await request(app).get('/docs/init.js').expect(200); await request(app).get('/docs/assets/swagger-ui-bundle.js').expect(200);
  const spec = (await request(app).get('/openapi.json').expect(200)).body;
  await request(app).get('/openapi.json?extra=1').expect(400);
  expect(spec.components.securitySchemes.basicAuth.scheme).toBe('basic');
  expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  expect(spec.paths).toHaveProperty('/api/v1/users'); expect(spec.paths).toHaveProperty('/api/v1/api-keys/{id}');
  expect(spec.paths).not.toHaveProperty('/api/v1/sync'); expect(spec.paths).not.toHaveProperty('/status');
  await request(app).get('/status').expect(404); await request(app).post('/api/v1/sync').expect(404);
  expect(provider.prices).not.toHaveBeenCalled();
});

test('mixed-case API routes use the same service IP limiter', async () => {
  for (let i = 0; i < 120; i++) await request(app).post('/api/v1/UsErS').send({login:'!', password:'bad'}).expect(400);
  const limited = await request(app).get('/API/V1/Api-Keys').expect(429);
  expect(limited.body.error.code).toBe('RATE_LIMITED');
});
