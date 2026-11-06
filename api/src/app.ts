import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { UserDirectory } from './auth.ts';
import { campaignRoutes } from './campaigns.ts';
import { HttpError, type Principal } from './domain.ts';
import { internalRoutes } from './internal.ts';
import { metricsRoutes } from './metrics.ts';
import { errorBody } from './schemas.ts';
import { ConflictError, type CampaignStore, type DeliveryStore } from './store.ts';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Principal;
    user: Principal;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AppConfig {
  jwtSecret: string;
  internalToken: string;
  demoPassword: string;
  logLevel?: string | false;
  loginRateLimit?: number;
  /**
   * Reverse proxies in front of the API: 1 for the nginx edge, 2 behind a cloud load balancer too.
   * The client IP is read from that many X-Forwarded-For entries from the right, so a client cannot
   * spoof the header to dodge the login rate limit.
   */
  trustProxyHops?: number;
}

export interface Deps {
  campaigns: CampaignStore;
  delivery: DeliveryStore;
  ready?: () => Promise<void>;
}

export async function buildApp(cfg: AppConfig, deps: Deps): Promise<FastifyInstance> {
  const proxyHops = cfg.trustProxyHops ?? 1;
  const app = Fastify({
    logger: cfg.logLevel === false ? false : { level: cfg.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // Hop 0 is the socket peer (the proxy); each trusted hop lets Fastify read one more address back.
    trustProxy: (_address: string, hop: number) => hop < proxyHops,
    bodyLimit: 64 * 1024,
    // Reject unknown fields instead of silently dropping them, so clients learn about typos and
    // nobody can set server-owned fields such as id, version or advertiserId through mass assignment.
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Cuepoint campaign API', version: '1.0.0', description: 'Campaigns, creatives, targeting and delivery reporting for streaming video ads.' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      tags: [{ name: 'auth' }, { name: 'campaigns' }, { name: 'advertisers' }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(rateLimit, { global: false });
  await app.register(fastifyJwt, {
    secret: cfg.jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '8h', iss: 'cuepoint' },
    verify: { algorithms: ['HS256'], allowedIss: 'cuepoint' },
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new HttpError(401, 'unauthorized', 'Sign in again: the token is missing, invalid or expired');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ConflictError) return reply.code(409).send({ error: { code: 'conflict', message: 'Already exists' } });
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}` } }));

  const users = await UserDirectory.create(cfg.demoPassword);
  await metricsRoutes(app);

  app.post<{ Body: { email: string; password: string } }>('/v1/auth/login', {
    config: { rateLimit: { max: cfg.loginRateLimit ?? 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'password'],
        properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 200 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, advertiserId: { type: 'string' } } },
          },
        },
        401: errorBody,
      },
    },
  }, async (req) => {
    const principal = await users.verify(req.body.email, req.body.password);
    if (!principal) {
      req.log.warn({ email: req.body.email }, 'failed login');
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    const token = await app.jwt.sign(principal);
    return { token, user: { email: principal.sub, name: principal.name, role: principal.role, advertiserId: principal.adv } };
  });

  app.get('/v1/me', { onRequest: [app.authenticate], schema: { tags: ['auth'], security: [{ bearerAuth: [] }] } }, async (req) => ({
    email: req.user.sub,
    name: req.user.name,
    role: req.user.role,
    advertiserId: req.user.adv,
  }));

  await app.register(campaignRoutes, { campaigns: deps.campaigns, delivery: deps.delivery });
  await app.register(internalRoutes, { campaigns: deps.campaigns, delivery: deps.delivery, token: cfg.internalToken });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await (deps.ready ?? deps.campaigns.ping.bind(deps.campaigns))();
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'not ready');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
