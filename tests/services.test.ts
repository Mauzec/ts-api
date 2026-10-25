import { Repository } from '../src/repo';
import { TrackingService, SyncService } from '../src/services';
import { SyncStateRepository } from '../src/sync-state';
import { AppError } from '../src/errors';
import { config, FakeProvider, fixture, logger, quote, seedUser } from './helpers';
import type { Asset, QuotesResult } from '../src/types';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const context = { requestId: 'service-test' };
describe('personal subscriptions and shared synchronization', () => {
  let f: Awaited<ReturnType<typeof fixture>>, repository: Repository, provider: FakeProvider, sync: SyncService;
  let now: number, user: number, other: number, tracking: TrackingService;
  beforeEach(async () => {
    f = await fixture(); repository = new Repository(f.db); provider = new FakeProvider(); now = Date.now();
    user = await seedUser(f.db, 'alice'); other = await seedUser(f.db, 'bob');
    provider.prices.mockImplementation(async ids => ({ quotes: ids.map(id => quote(id, now)), errorIds: [] }));
    tracking = new TrackingService(repository, provider, () => now);
    sync = new SyncService(new SyncStateRepository(f.db), repository, provider, config({ cmcPriceSyncIntervalMs: 900000 }), logger, () => now);
    await sync.initialize();
  });
  afterEach(async () => { await sync.stop(); await f.close(); });
  const create = (id = 1, owner = user) => repository.create(owner, quote(id, now - 60000), null, now);

  test('creation resolves a slug and stores its first quote with the membership', async () => {
    const asset = await tracking.create(user, { slug: 'bitcoin', displayName: 'Mine' }, context);
    expect(asset).toMatchObject({ cmcId: 1, displayName: 'Mine' });
    expect(provider.resolveSlug).toHaveBeenCalledWith('bitcoin', context);
    expect(provider.prices).toHaveBeenCalledWith([1], expect.objectContaining({ requestId: context.requestId }));
    expect((await repository.priceSnapshot(user, asset.id)).price?.price).toBe(100);
    expect(await f.db.read(sql => sql.get('SELECT sub_count FROM active_tracking'))).toEqual({ sub_count: 1 });
  });
  test('unknown and ambiguous slugs never buy a quote', async () => {
    provider.resolveSlug.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { cmcId: 1, slug: 'bitcoin', name: 'First' }, { cmcId: 2, slug: 'bitcoin', name: 'Second' },
    ]);
    await expect(tracking.create(user, { slug: 'unknown' }, context)).rejects.toMatchObject({ status: 422, code: 'UNKNOWN_ASSET' });
    await expect(tracking.create(user, { slug: 'bitcoin' }, context)).rejects.toMatchObject({ status: 409, code: 'AMBIGUOUS_SLUG', details: { total: 2 } });
    expect(provider.prices).not.toHaveBeenCalled();
  });
  test('known coin joins reuse even an old price and duplicates make no provider call', async () => {
    const original = await repository.create(user, quote(1, now - 86400000), 'Alice', now);
    const joined = await tracking.create(other, { cmcId: 1, displayName: 'Bob' }, context);
    expect(joined.id).not.toBe(original.id);
    expect((await repository.priceSnapshot(other, joined.id)).price?.quotedAt).toBe(now - 86400000);
    await expect(tracking.create(other, { cmcId: 1 }, context)).rejects.toMatchObject({ status: 409 });
    expect(provider.prices).not.toHaveBeenCalled();
    expect(await f.db.read(sql => sql.get('SELECT sub_count FROM active_tracking'))).toEqual({ sub_count: 2 });
  });
  test('simultaneous different owners buy one first quote and each receives a personal membership', async () => {
    const [first, second] = await Promise.all([tracking.create(user, { cmcId: 1 }, context), tracking.create(other, { cmcId: 1 }, context)]);
    expect(first.id).not.toBe(second.id); expect(provider.prices).toHaveBeenCalledTimes(1);
    expect(await f.db.read(sql => sql.get('SELECT sub_count FROM active_tracking'))).toEqual({ sub_count: 2 });
    expect(await f.db.read(sql => sql.get('SELECT COUNT(*) AS count FROM price_history'))).toEqual({ count: 1 });
  });
  test('simultaneous duplicate membership buys one quote and rejects exactly one creation', async () => {
    const results = await Promise.allSettled([tracking.create(user, { cmcId: 1 }, context), tracking.create(user, { cmcId: 1 }, context)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(provider.prices).toHaveBeenCalledTimes(1);
  });
  test('shared creation starts before lookup and remains held until commit acknowledgement', async () => {
    const originalFind = repository.findByCmcId.bind(repository), originalCreate = repository.create.bind(repository);
    let releaseFind!: () => void, releaseCommit!: () => void;
    const find = jest.spyOn(repository, 'findByCmcId').mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { releaseFind = resolve; }); return originalFind(...args);
    });
    jest.spyOn(repository, 'create').mockImplementationOnce(async (...args) => {
      const asset = await originalCreate(...args); await new Promise<void>(resolve => { releaseCommit = resolve; }); return asset;
    });
    const first = tracking.create(user, { cmcId: 1 }, context), second = tracking.create(other, { cmcId: 1 }, context);
    await until(() => !!releaseFind); expect(find).toHaveBeenCalledTimes(1); expect(provider.prices).not.toHaveBeenCalled();
    releaseFind(); await until(() => !!releaseCommit); expect(find).toHaveBeenCalledTimes(1);
    releaseCommit(); await Promise.all([first, second]); expect(find).toHaveBeenCalledTimes(1); expect(provider.prices).toHaveBeenCalledTimes(1);
  });
  test('current creators share a failure; only a new request retries it', async () => {
    provider.prices.mockRejectedValueOnce(new AppError(502, 'CMC_UNAVAILABLE', 'Unavailable'));
    const results = await Promise.allSettled([tracking.create(user, { cmcId: 1 }, context), tracking.create(other, { cmcId: 1 }, context)]);
    expect(results).toEqual(Array(2).fill({ status: 'rejected', reason: expect.objectContaining({ code: 'CMC_UNAVAILABLE' }) }));
    expect(provider.prices).toHaveBeenCalledTimes(1);
    await expect(tracking.create(other, { cmcId: 1 }, context)).resolves.toMatchObject({ cmcId: 1 });
    expect(provider.prices).toHaveBeenCalledTimes(2);
  });
  test('a duplicate subscriber does not poison another owner joining an existing coin', async () => {
    await create();
    const results = await Promise.allSettled([tracking.create(user, { cmcId: 1 }, context), tracking.create(other, { cmcId: 1 }, context)]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'ASSET_EXISTS' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { cmcId: 1 } });
    expect(provider.prices).not.toHaveBeenCalled();
    expect(await f.db.read(sql => sql.get('SELECT sub_count FROM active_tracking'))).toEqual({ sub_count: 2 });
  });
  test('missing quote and upstream failure leave no partial catalog or membership', async () => {
    provider.prices.mockResolvedValueOnce({ quotes: [], errorIds: [1] }).mockRejectedValueOnce(new AppError(504, 'CMC_TIMEOUT', 'Timeout'));
    await expect(tracking.create(user, { cmcId: 1 }, context)).rejects.toMatchObject({ status: 422 });
    await expect(tracking.create(user, { cmcId: 1 }, context)).rejects.toMatchObject({ status: 504 });
    expect(await repository.findByCmcId(1)).toBeUndefined();
    expect(await repository.activePage(0, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });
  test.each([0, 1, 250, 251])('union of %i coins uses only the required batches', async count => {
    for (let id = 1; id <= count; id++) await create(id);
    if (count) await tracking.create(other, { cmcId: 1 }, context);
    const result = await sync.run();
    expect(result).toMatchObject({ requested: count, batches: Math.ceil(count / 250), inserted: count });
    expect(provider.prices).toHaveBeenCalledTimes(Math.ceil(count / 250));
    expect((await sync.state()).scheduledAt).toBe(now + 900000);
  });
  test('next run is persisted before CMC and overlap rejected until finalization', async () => {
    await create(); let release!: (value: QuotesResult) => void;
    provider.prices.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = sync.run(); await until(() => !!release);
    expect(await sync.state()).toMatchObject({ status: 'running', scheduledAt: now + 900000 });
    await expect(sync.run()).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' });
    release({ quotes: [quote(1, now)], errorIds: [] }); await running;
  });
  test('last removal and reactivation discard a late quote without affecting the new membership', async () => {
    const original = await create(); let joined!: Asset;
    provider.prices.mockImplementationOnce(async () => {
      await repository.remove(user, original.id);
      joined = await tracking.create(other, { cmcId: 1 }, context);
      return { quotes: [quote(1, now)], errorIds: [] };
    });
    expect(await sync.run()).toMatchObject({ discarded: 1, inserted: 0, status: 'parted' });
    expect((await repository.history(other, joined.id, { limit: 100 })).items).toHaveLength(1);
    await expect(repository.get(user, original.id)).rejects.toMatchObject({ status: 404 });
    expect(provider.prices).toHaveBeenCalledTimes(1);
  });
  test('removing one of two subscribers keeps the activation valid and saves one shared quote', async () => {
    const first = await create(), second = await tracking.create(other, { cmcId: 1 }, context);
    provider.prices.mockImplementationOnce(async () => {
      await repository.remove(user, first.id); return { quotes: [quote(1, now)], errorIds: [] };
    });
    expect(await sync.run()).toMatchObject({ inserted: 1, discarded: 0 });
    expect((await repository.history(other, second.id, { limit: 100 })).items).toHaveLength(2);
    expect(await f.db.read(sql => sql.get('SELECT sub_count FROM active_tracking'))).toEqual({ sub_count: 1 });
  });
  test('a personal display name change during CMC does not invalidate a shared quote', async () => {
    const asset = await create();
    provider.prices.mockImplementationOnce(async () => {
      await repository.update(user, asset.id, { displayName: 'Local name' }, now); return { quotes: [quote(1, now)], errorIds: [] };
    });
    expect(await sync.run()).toMatchObject({ inserted: 1, discarded: 0 });
    expect(await repository.get(user, asset.id)).toMatchObject({ displayName: 'Local name' });
  });
  test('partial upstream data preserves valid results and leaves missing coins unchanged', async () => {
    const first = await create(), second = await create(2);
    provider.prices.mockResolvedValueOnce({ quotes: [quote(1, now)], errorIds: [2] });
    expect(await sync.run()).toMatchObject({ status: 'parted', invalid: 1, inserted: 1 });
    expect((await repository.priceSnapshot(user, first.id)).price?.quotedAt).toBe(now);
    expect((await repository.priceSnapshot(user, second.id)).price?.quotedAt).toBe(now - 60000);
  });
  test('backoff is 15/30/60 minutes, and actual Retry-After can defer a later scheduled attempt', async () => {
    await create(); provider.prices.mockRejectedValue(new AppError(502, 'CMC_UNAVAILABLE', 'Unavailable'));
    for (const delay of [900000, 1800000, 3600000, 3600000]) {
      await expect(sync.run()).rejects.toMatchObject({ status: 502 });
      expect((await sync.state()).scheduledAt).toBe(now + delay); now += delay;
    }
    provider.prices.mockRejectedValueOnce(new AppError(429, 'CMC_RATE_LIMITED', 'Limit', { retryAt: now + 7200000 }));
    await expect(sync.run()).rejects.toMatchObject({ status: 429 });
    expect(await sync.state()).toMatchObject({ scheduledAt: now + 7200000, lastErrorCode: 'CMC_RATE_LIMITED' });
  });
  test('restart preserves reserved scheduling and marks the interrupted run without CMC', async () => {
    await f.db.write(sql => sql.run("UPDATE sync_state SET status='running',scheduled_at=?", [now + 123456]));
    await sync.initialize();
    expect(await sync.state()).toMatchObject({ status: 'interrupted', scheduledAt: now + 123456 }); expect(provider.prices).not.toHaveBeenCalled();
  });
  test('a failed success write and failed failure write do not permanently block later synchronization', async () => {
    await create();
    await f.db.write(sql => sql.run("CREATE TRIGGER fail_final_state BEFORE UPDATE OF last_finished_at ON sync_state BEGIN SELECT RAISE(ABORT,'transient storage failure'); END;"));
    await expect(sync.run()).rejects.toMatchObject({ code: 'DB_ERROR' });
    expect(sync.isRunning).toBe(false);
    expect(await sync.state()).toMatchObject({ status: 'running', scheduledAt: now + 900000 });
    expect(provider.prices).toHaveBeenCalledTimes(1);
    await f.db.write(sql => sql.run('DROP TRIGGER fail_final_state'));
    now += 900000;
    await expect(sync.run()).resolves.toMatchObject({ status: 'success', inserted: 1 });
    expect(await sync.state()).toMatchObject({ status: 'success', scheduledAt: now + 900000, consecutiveFailures: 0 });
    expect(provider.prices).toHaveBeenCalledTimes(2);
  });
  test('a long cycle skips missed slots instead of catching up', async () => {
    await create(); const started = now;
    provider.prices.mockImplementationOnce(async () => { now += 2000000; return { quotes: [quote(1, now)], errorIds: [] }; });
    await sync.run(); expect((await sync.state()).scheduledAt).toBe(started + 2700000);
  });
  test('a fixed activation ceiling defers new and reactivated coins until the next run', async () => {
    const assets: Asset[] = []; for (let id = 1; id <= 251; id++) assets.push(await create(id));
    provider.prices.mockImplementationOnce(async ids => {
      await repository.remove(user, assets[0]!.id); await tracking.create(other, { cmcId: 1 }, context);
      await repository.remove(user, assets[250]!.id); await tracking.create(other, { cmcId: 251 }, context);
      await create(252);
      return { quotes: ids.map(id => quote(id, now)), errorIds: [] };
    });
    expect(await sync.run()).toMatchObject({ requested: 250, batches: 1, inserted: 249, discarded: 1 });
    expect(provider.prices).toHaveBeenCalledTimes(1);
    provider.prices.mockClear(); now += 900000;
    expect(await sync.run()).toMatchObject({ requested: 252, batches: 2, inserted: 252 });
  });
  test('begin claims singleflight before its asynchronous writer acquisition', async () => {
    await create(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocker = f.db.write(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready; const running = sync.run();
    await expect(sync.run()).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' }); expect(provider.prices).not.toHaveBeenCalled();
    release(); await blocker; await running;
  });
  test('a failed batch UPDATE rolls back its INSERT and records a sync storage failure', async () => {
    const asset = await create();
    await f.db.write(sql => sql.run("CREATE TRIGGER fail_update BEFORE UPDATE ON cryptocurrencies BEGIN SELECT RAISE(ABORT,'injected'); END;"));
    await expect(sync.run()).rejects.toMatchObject({ code: 'DB_ERROR' });
    expect((await repository.history(user, asset.id, { limit: 100 })).items).toHaveLength(1);
    expect((await sync.state()).status).toBe('failed'); expect(provider.prices).toHaveBeenCalledTimes(1);
  });
  test('stop waits for an active consumed response, then refuses new runs', async () => {
    await create(); let release!: (value: QuotesResult) => void;
    provider.prices.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const run = sync.run(); await until(() => !!release); let stopped = false;
    const stop = sync.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    release({ quotes: [quote(1, now)], errorIds: [] });
    await expect(run).rejects.toMatchObject({ code: 'SHUTTING_DOWN' }); await stop;
    await expect(sync.run()).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });
});
