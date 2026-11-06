import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

/** Call on the root instance before registering routes: hooks only reach routes in their own context. */
export async function metricsRoutes(app: FastifyInstance) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'api_' });
  const duration = new client.Histogram({
    name: 'api_http_request_duration_seconds',
    help: 'Request latency by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  app.addHook('onResponse', async (req, reply) => {
    duration.labels(req.method, req.routeOptions.url ?? 'unmatched', String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
