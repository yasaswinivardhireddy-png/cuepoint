import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ADVERTISERS } from './auth.ts';
import { addDays, dayFraction, HttpError, today, type Campaign, type Category, type Device, type Principal, type Status } from './domain.ts';
import { campaign, campaignCreate, campaignId, campaignPatch, delivery as deliverySchema, errorBody } from './schemas.ts';
import type { CampaignStore, DeliveryStore } from './store.ts';

interface CreativeInput {
  name: string;
  durationSec: number;
  mediaUrl: string;
  width?: number;
  height?: number;
}

interface TargetingInput {
  genres?: string[];
  devices?: Device[];
  countries?: string[];
}

interface CampaignInput {
  advertiserId?: string;
  name: string;
  category: Category;
  status?: Status;
  startDate: string;
  endDate: string;
  dailyImpressionGoal: number;
  cpmCents: number;
  frequencyCapPerDay?: number;
  targeting?: TargetingInput;
  creatives: CreativeInput[];
}

type CampaignPatch = Partial<Pick<Campaign, 'name' | 'status' | 'endDate' | 'dailyImpressionGoal' | 'cpmCents' | 'frequencyCapPerDay'>> & { targeting?: TargetingInput };

const notFound = () => new HttpError(404, 'not_found', 'Campaign not found');
export const etagOf = (c: Campaign) => `"v${c.version}"`;

const targetingOf = (t: TargetingInput = {}, base: TargetingInput = {}) => ({
  genres: [...(t.genres ?? base.genres ?? [])].sort(),
  devices: [...(t.devices ?? base.devices ?? [])].sort(),
  countries: [...(t.countries ?? base.countries ?? [])].sort(),
});

const auth = { security: [{ bearerAuth: [] }] };
const errors = { 400: errorBody, 401: errorBody, 404: errorBody };

export async function campaignRoutes(app: FastifyInstance, opts: { campaigns: CampaignStore; delivery: DeliveryStore }) {
  const { campaigns: store, delivery } = opts;

  /** Advertisers only ever see their own campaigns; other IDs look like they do not exist. */
  async function loadOwned(user: Principal, id: string): Promise<Campaign> {
    const c = await store.get(id);
    if (!c || (user.role !== 'admin' && c.advertiserId !== user.adv)) throw notFound();
    return c;
  }

  async function withDelivery(list: Campaign[]) {
    const totals = await delivery.dailyTotals(list.map((c) => c.id), today());
    return list.map((c) => ({ ...c, deliveredToday: totals.get(c.id) ?? 0 }));
  }

  app.get('/v1/advertisers', {
    onRequest: [app.authenticate],
    schema: { tags: ['advertisers'], ...auth, response: { 200: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } } } },
  }, async (req) => ({ items: req.user.role === 'admin' ? ADVERTISERS : ADVERTISERS.filter((a) => a.id === req.user.adv) }));

  app.get<{ Querystring: { status?: Status } }>('/v1/campaigns', {
    onRequest: [app.authenticate],
    schema: {
      tags: ['campaigns'],
      ...auth,
      querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['active', 'paused'] } } },
      response: { 200: { type: 'object', properties: { items: { type: 'array', items: campaign } } }, ...errors },
    },
  }, async (req) => {
    const user = req.user;
    let list = user.role === 'admin' ? await store.listAll() : await store.listByAdvertiser(user.adv!);
    if (req.query.status) list = list.filter((c) => c.status === req.query.status);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: await withDelivery(list) };
  });

  app.post<{ Body: CampaignInput }>('/v1/campaigns', {
    onRequest: [app.authenticate],
    schema: { tags: ['campaigns'], ...auth, body: campaignCreate, response: { 201: campaign, ...errors, 403: errorBody } },
  }, async (req, reply) => {
    const user = req.user;
    const body = req.body;
    let advertiserId: string;
    if (user.role === 'admin') {
      if (!body.advertiserId || !ADVERTISERS.some((a) => a.id === body.advertiserId)) {
        throw new HttpError(400, 'invalid_request', 'Admins must set advertiserId to a known advertiser');
      }
      advertiserId = body.advertiserId;
    } else {
      if (body.advertiserId && body.advertiserId !== user.adv) throw new HttpError(403, 'forbidden', 'Advertisers can only create their own campaigns');
      advertiserId = user.adv!;
    }
    if (body.endDate < body.startDate) throw new HttpError(400, 'invalid_request', 'endDate must not be before startDate');
    if (body.endDate < today()) throw new HttpError(400, 'invalid_request', 'endDate is in the past');

    const now = new Date().toISOString();
    const created: Campaign = {
      id: `cmp-${randomUUID()}`,
      advertiserId,
      name: body.name.trim(),
      category: body.category,
      status: body.status ?? 'active',
      startDate: body.startDate,
      endDate: body.endDate,
      dailyImpressionGoal: body.dailyImpressionGoal,
      cpmCents: body.cpmCents,
      frequencyCapPerDay: body.frequencyCapPerDay ?? 0,
      targeting: targetingOf(body.targeting),
      creatives: body.creatives.map((cr) => ({
        id: `crv-${randomUUID().slice(0, 8)}`,
        name: cr.name.trim(),
        durationSec: cr.durationSec,
        mediaUrl: cr.mediaUrl,
        mimeType: 'video/mp4',
        width: cr.width ?? 1920,
        height: cr.height ?? 1080,
      })),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.create(created);
    req.log.info({ campaignId: created.id, advertiserId, by: user.sub }, 'campaign created');
    reply.code(201).header('location', `/v1/campaigns/${created.id}`).header('etag', etagOf(created));
    return { ...created, deliveredToday: 0 };
  });

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id', {
    onRequest: [app.authenticate],
    schema: { tags: ['campaigns'], ...auth, params: campaignId, response: { 200: campaign, ...errors } },
  }, async (req, reply) => {
    const c = await loadOwned(req.user, req.params.id);
    reply.header('etag', etagOf(c));
    return (await withDelivery([c]))[0];
  });

  app.patch<{ Params: { id: string }; Body: CampaignPatch }>('/v1/campaigns/:id', {
    onRequest: [app.authenticate],
    schema: {
      tags: ['campaigns'],
      ...auth,
      description: 'Edits a campaign. Send the ETag you last read in If-Match; a stale one gets 412, so concurrent edits never overwrite each other.',
      params: campaignId,
      headers: { type: 'object', properties: { 'if-match': { type: 'string' } } },
      body: campaignPatch,
      response: { 200: campaign, ...errors, 412: errorBody, 428: errorBody },
    },
  }, async (req, reply) => {
    const current = await loadOwned(req.user, req.params.id);
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) throw new HttpError(428, 'precondition_required', 'Send If-Match with the ETag you last read');
    if (ifMatch !== etagOf(current)) throw new HttpError(412, 'version_conflict', 'The campaign changed since you read it; reload and retry');

    const { targeting, ...fields } = req.body;
    const next: Campaign = {
      ...current,
      ...fields,
      ...(fields.name ? { name: fields.name.trim() } : {}),
      targeting: targeting ? targetingOf(targeting, current.targeting) : current.targeting,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (next.endDate < next.startDate) throw new HttpError(400, 'invalid_request', 'endDate must not be before startDate');
    if (!(await store.update(next, current.version))) {
      throw new HttpError(412, 'version_conflict', 'The campaign changed since you read it; reload and retry');
    }
    req.log.info({ campaignId: next.id, by: req.user.sub, fields: Object.keys(req.body) }, 'campaign updated');
    reply.header('etag', etagOf(next));
    return (await withDelivery([next]))[0];
  });

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/delivery', {
    onRequest: [app.authenticate],
    schema: { tags: ['campaigns'], ...auth, description: "Today's hourly impressions, the last 7 days, and pacing against the daily goal.", params: campaignId, response: { 200: deliverySchema, ...errors } },
  }, async (req) => {
    const c = await loadOwned(req.user, req.params.id);
    const day = today();
    const points = await delivery.periods(c.id, addDays(day, -6), `${day}T99`);
    const byPeriod = new Map(points.map((p) => [p.period, p.impressions]));
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const hour = String(h).padStart(2, '0');
      return { hour, impressions: byPeriod.get(`${day}T${hour}`) ?? 0 };
    });
    const daily = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(day, i - 6);
      return { day: d, impressions: byPeriod.get(d) ?? 0 };
    });
    const deliveredToday = byPeriod.get(day) ?? hourly.reduce((n, h) => n + h.impressions, 0);
    const expectedByNow = Math.round(c.dailyImpressionGoal * dayFraction());
    return {
      campaignId: c.id,
      day,
      dailyImpressionGoal: c.dailyImpressionGoal,
      deliveredToday,
      expectedByNow,
      pacing: expectedByNow > 0 ? Math.round((deliveredToday / expectedByNow) * 1000) / 1000 : 0,
      hourly,
      daily,
    };
  });
}
