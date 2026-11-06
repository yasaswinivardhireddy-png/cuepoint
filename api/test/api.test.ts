import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { addDays, today } from '../src/domain.ts';
import { seedDemo } from '../src/seed.ts';
import { MemoryStore } from '../src/store.ts';

const PASSWORD = 'demo-password';
const INTERNAL = 'internal-service-token';

let app: FastifyInstance;
let store: MemoryStore;
const tokens: Record<string, string> = {};

async function login(email: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
}

const as = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });

function newCampaign(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Winter Drive',
    category: 'auto',
    startDate: today(),
    endDate: addDays(today(), 30),
    dailyImpressionGoal: 1000,
    cpmCents: 2500,
    frequencyCapPerDay: 3,
    targeting: { genres: ['sports'], devices: ['ctv'], countries: ['IN'] },
    creatives: [{ name: 'Spot 30', durationSec: 30, mediaUrl: 'https://media.example.com/spot.mp4' }],
    ...overrides,
  };
}

async function create(who: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as(who), payload: newCampaign(overrides) });
  expect(res.statusCode, res.body).toBe(201);
  return res;
}

beforeAll(async () => {
  store = new MemoryStore();
  app = await buildApp({ jwtSecret: 'x'.repeat(32), internalToken: INTERNAL, demoPassword: PASSWORD, logLevel: false, loginRateLimit: 1000 }, { campaigns: store, delivery: store });
  const accounts: [string, string][] = [['admin', 'admin@cuepoint.dev'], ['acme', 'ads@acmemotors.example'], ['bluepeak', 'ads@bluepeak.example']];
  for (const [who, email] of accounts) {
    tokens[who] = (await login(email)).json().token;
  }
});

afterAll(() => app.close());

beforeEach(() => {
  store.campaigns.clear();
  store.delivery.clear();
});

describe('authentication', () => {
  it('signs in demo users and rejects bad credentials the same way', async () => {
    const ok = await login('ADS@acmemotors.example');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toEqual({ email: 'ads@acmemotors.example', name: 'Acme Motors', role: 'advertiser', advertiserId: 'adv-acme-motors' });

    const wrong = await login('ads@acmemotors.example', 'nope');
    const unknown = await login('nobody@example.com', 'nope');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('requires a valid token', async () => {
    expect((await app.inject({ url: '/v1/campaigns' })).statusCode).toBe(401);
    const tampered = `${tokens.acme!.slice(0, -4)}abcd`;
    const res = await app.inject({ url: '/v1/campaigns', headers: { authorization: `Bearer ${tampered}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rate-limits login attempts', async () => {
    const limited = await buildApp({ jwtSecret: 'y'.repeat(32), internalToken: INTERNAL, demoPassword: PASSWORD, logLevel: false, loginRateLimit: 3 }, { campaigns: store, delivery: store });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await limited.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@b.c', password: 'x' } })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    await limited.close();
  });

  it('keys the login rate limit on the address the proxy saw, not a spoofed X-Forwarded-For', async () => {
    const limited = await buildApp({ jwtSecret: 'y'.repeat(32), internalToken: INTERNAL, demoPassword: PASSWORD, logLevel: false, loginRateLimit: 3 }, { campaigns: store, delivery: store });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      // The client invents a new address each time; the edge proxy appends the real one.
      const headers = { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` };
      codes.push((await limited.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { email: 'a@b.c', password: 'x' } })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 429]);
    await limited.close();
  });
});

describe('campaigns', () => {
  it('creates a campaign for the signed-in advertiser', async () => {
    const res = await create('acme');
    const body = res.json();
    expect(body).toMatchObject({ advertiserId: 'adv-acme-motors', status: 'active', version: 1, deliveredToday: 0, frequencyCapPerDay: 3 });
    expect(body.id).toMatch(/^cmp-[0-9a-f-]{36}$/);
    expect(body.creatives[0]).toMatchObject({ durationSec: 30, mimeType: 'video/mp4', width: 1920, height: 1080 });
    expect(res.headers.location).toBe(`/v1/campaigns/${body.id}`);
    expect(res.headers.etag).toBe('"v1"');
  });

  it('rejects invalid input and server-owned fields', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ endDate: addDays(today(), -10), startDate: addDays(today(), -20) }, 'endDate is in the past'],
      [{ endDate: today(), startDate: addDays(today(), 1) }, 'endDate must not be before startDate'],
      [{ creatives: [{ name: 'x', durationSec: 30, mediaUrl: 'http://insecure.example.com/a.mp4' }] }, 'must match pattern'],
      [{ creatives: [{ name: 'x', durationSec: 25, mediaUrl: 'https://a.example.com/a.mp4' }] }, 'must be equal to one of the allowed values'],
      [{ targeting: { countries: ['india'] } }, 'must match pattern'],
      [{ version: 99 }, 'must NOT have additional properties'],
      [{ id: 'cmp-chosen-by-client' }, 'must NOT have additional properties'],
    ];
    for (const [overrides, message] of cases) {
      const res = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('acme'), payload: newCampaign(overrides) });
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(res.json().error.message).toContain(message);
    }
  });

  it('keeps advertisers inside their own account', async () => {
    const forged = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('acme'), payload: newCampaign({ advertiserId: 'adv-bluepeak' }) });
    expect(forged.statusCode).toBe(403);

    const acmeCampaign = (await create('acme')).json();
    await create('bluepeak', { name: 'Summer Fizz', category: 'beverage' });

    const acmeList = (await app.inject({ url: '/v1/campaigns', headers: as('acme') })).json().items;
    expect(acmeList.map((c: { name: string }) => c.name)).toEqual(['Winter Drive']);
    expect((await app.inject({ url: '/v1/campaigns', headers: as('admin') })).json().items).toHaveLength(2);

    // Another advertiser's campaign is indistinguishable from one that does not exist.
    for (const [method, url] of [['GET', `/v1/campaigns/${acmeCampaign.id}`], ['GET', `/v1/campaigns/${acmeCampaign.id}/delivery`], ['PATCH', `/v1/campaigns/${acmeCampaign.id}`]] as const) {
      const res = await app.inject({ method, url, headers: { ...as('bluepeak'), 'if-match': '"v1"' }, payload: method === 'PATCH' ? { status: 'paused' } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject({ url: `/v1/campaigns/cmp-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, headers: as('acme') })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/advertisers`, headers: as('bluepeak') })).json().items).toEqual([{ id: 'adv-bluepeak', name: 'Bluepeak Beverages' }]);
  });

  it('lets admins create for a named advertiser only', async () => {
    const missing = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('admin'), payload: newCampaign() });
    expect(missing.statusCode).toBe(400);
    expect((await create('admin', { advertiserId: 'adv-summit', category: 'insurance' })).json().advertiserId).toBe('adv-summit');
  });

  it('uses ETags so concurrent edits cannot overwrite each other', async () => {
    const created = (await create('acme')).json();
    const url = `/v1/campaigns/${created.id}`;

    const noPrecondition = await app.inject({ method: 'PATCH', url, headers: as('acme'), payload: { status: 'paused' } });
    expect(noPrecondition.statusCode).toBe(428);

    const first = await app.inject({ method: 'PATCH', url, headers: { ...as('acme'), 'if-match': '"v1"' }, payload: { status: 'paused', cpmCents: 3000 } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'paused', cpmCents: 3000, version: 2 });
    expect(first.json().targeting).toEqual(created.targeting); // untouched by an unrelated edit
    expect(first.headers.etag).toBe('"v2"');

    // A second editor still holding v1 is told to reload instead of silently winning.
    const stale = await app.inject({ method: 'PATCH', url, headers: { ...as('acme'), 'if-match': '"v1"' }, payload: { cpmCents: 100 } });
    expect(stale.statusCode).toBe(412);
    expect((await app.inject({ url, headers: as('acme') })).json().cpmCents).toBe(3000);

    // Partial targeting edits replace only the lists they name.
    const narrowed = await app.inject({ method: 'PATCH', url, headers: { ...as('acme'), 'if-match': '"v2"' }, payload: { targeting: { genres: ['news', 'sports'] } } });
    expect(narrowed.json().targeting).toEqual({ genres: ['news', 'sports'], devices: ['ctv'], countries: ['IN'] });

    const empty = await app.inject({ method: 'PATCH', url, headers: { ...as('acme'), 'if-match': '"v3"' }, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('reports delivery and pacing', async () => {
    const created = (await create('acme', { dailyImpressionGoal: 2400 })).json();
    const day = today();
    store.record(created.id, `${day}T00`, 30);
    store.record(created.id, `${day}T01`, 70);
    store.record(created.id, day, 100);
    store.record(created.id, addDays(day, -1), 2300);

    const res = await app.inject({ url: `/v1/campaigns/${created.id}/delivery`, headers: as('acme') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deliveredToday).toBe(100);
    expect(body.hourly).toHaveLength(24);
    expect(body.hourly.slice(0, 3)).toEqual([{ hour: '00', impressions: 30 }, { hour: '01', impressions: 70 }, { hour: '02', impressions: 0 }]);
    expect(body.daily.at(-2)).toEqual({ day: addDays(day, -1), impressions: 2300 });
    expect(body.expectedByNow).toBeGreaterThanOrEqual(0);
    expect((await app.inject({ url: '/v1/campaigns', headers: as('acme') })).json().items[0].deliveredToday).toBe(100);
  });
});

describe('ad server snapshot', () => {
  const url = '/internal/v1/campaigns/active';

  it('needs the service token, lists only servable campaigns and supports If-None-Match', async () => {
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: `Bearer ${tokens.admin}` } })).statusCode).toBe(401);

    const active = (await create('acme')).json();
    await create('bluepeak', { name: 'Paused', category: 'beverage', status: 'paused' });
    store.record(active.id, today(), 42);

    const headers = { authorization: `Bearer ${INTERNAL}` };
    const first = await app.inject({ url, headers });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0]).toMatchObject({ id: active.id, deliveredToday: 42, frequencyCapPerDay: 3, targeting: { genres: ['sports'] } });

    const etag = first.headers.etag as string;
    expect((await app.inject({ url, headers: { ...headers, 'if-none-match': etag } })).statusCode).toBe(304);

    store.record(active.id, today(), 1);
    const changed = await app.inject({ url, headers: { ...headers, 'if-none-match': etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });
});

describe('operations', () => {
  it('publishes OpenAPI docs without the internal route', async () => {
    const spec = (await app.inject({ url: '/docs/json' })).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/v1/auth/login', '/v1/campaigns', '/v1/campaigns/{id}', '/v1/campaigns/{id}/delivery']));
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/internal'))).toBe(false);
  });

  it('exposes health, readiness and metrics', async () => {
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
    await app.inject({ url: '/v1/campaigns', headers: as('acme') });
    const metrics = (await app.inject({ url: '/metrics' })).body;
    expect(metrics).toContain('api_http_request_duration_seconds_bucket{le="0.001",method="GET",route="/v1/campaigns",status="200"}');
  });

  it('seeds the demo data once, even from replicas starting together', async () => {
    const [first, second] = await Promise.all([seedDemo(store), seedDemo(store)]);
    expect(first + second).toBe(9);
    expect(await seedDemo(store)).toBe(0);
    const all = await store.listAll();
    expect(all).toHaveLength(9);
    expect(new Set(all.map((c) => c.advertiserId)).size).toBe(5);
    expect(all.filter((c) => c.status === 'paused')).toHaveLength(1);
  });
});
