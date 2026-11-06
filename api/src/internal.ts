import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { safeEqual } from './auth.ts';
import { HttpError, today } from './domain.ts';
import type { CampaignStore, DeliveryStore } from './store.ts';

/**
 * The ad server polls this every few seconds. It is not routed through the public ingress, needs a
 * separate service token, and answers 304 when nothing changed, so idle polling is cheap.
 */
export async function internalRoutes(app: FastifyInstance, opts: { campaigns: CampaignStore; delivery: DeliveryStore; token: string }) {
  app.get('/internal/v1/campaigns/active', { schema: { hide: true } }, async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!safeEqual(token, opts.token)) throw new HttpError(401, 'unauthorized', 'Service token required');

    const day = today();
    const active = (await opts.campaigns.listAll()).filter((c) => c.status === 'active' && c.endDate >= day).sort((a, b) => a.id.localeCompare(b.id));
    const totals = await opts.delivery.dailyTotals(active.map((c) => c.id), day);
    const body = JSON.stringify({
      day,
      campaigns: active.map((c) => ({
        id: c.id,
        advertiserId: c.advertiserId,
        name: c.name,
        category: c.category,
        startDate: c.startDate,
        endDate: c.endDate,
        dailyImpressionGoal: c.dailyImpressionGoal,
        cpmCents: c.cpmCents,
        frequencyCapPerDay: c.frequencyCapPerDay,
        targeting: c.targeting,
        creatives: c.creatives,
        deliveredToday: totals.get(c.id) ?? 0,
      })),
    });
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json').send(body);
  });
}
