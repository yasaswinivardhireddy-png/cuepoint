import { buildApp } from './app.ts';
import { DynamoStore } from './dynamo.ts';
import { seedDemo } from './seed.ts';
import { MemoryStore } from './store.ts';

const env = process.env;

function required(name: string, minLength: number): string {
  const value = env[name] ?? '';
  if (value.length < minLength) {
    console.error(`${name} must be set to at least ${minLength} characters`);
    process.exit(2);
  }
  return value;
}

function count(name: string, fallback: number, min: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min) {
    console.error(`${name} must be a whole number of at least ${min}`);
    process.exit(2);
  }
  return value;
}

const store =
  env.STORE === 'memory'
    ? new MemoryStore()
    : new DynamoStore({
        campaignsTable: env.CAMPAIGNS_TABLE ?? 'cuepoint-local-campaigns',
        deliveryTable: env.DELIVERY_TABLE ?? 'cuepoint-local-delivery',
        region: env.AWS_REGION ?? 'ap-south-1',
        endpoint: env.AWS_ENDPOINT_URL,
      });

const app = await buildApp(
  {
    jwtSecret: required('JWT_SECRET', 32),
    internalToken: required('INTERNAL_API_TOKEN', 16),
    demoPassword: required('DEMO_PASSWORD', 8),
    logLevel: env.LOG_LEVEL ?? 'info',
    loginRateLimit: count('LOGIN_RATE_LIMIT', 10, 1),
    trustProxyHops: count('TRUST_PROXY_HOPS', 1, 0),
  },
  { campaigns: store, delivery: store },
);

if (env.SEED_DEMO === 'true') {
  const created = await seedDemo(store);
  app.log.info({ created }, created ? 'seeded demo campaigns' : 'campaigns exist; skipped demo seed');
}

await app.listen({ host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 3000) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // close() stops accepting connections and waits for in-flight requests.
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
