import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.ts';
import { MemoryStore } from '../src/store.ts';

// Writes the OpenAPI document generated from the route schemas, for readers who will not run the API.
const store = new MemoryStore();
const app = await buildApp({ jwtSecret: 'x'.repeat(32), internalToken: 'x'.repeat(16), demoPassword: 'x'.repeat(8), logLevel: false }, { campaigns: store, delivery: store });
await app.ready();
const out = new URL('../../docs/openapi.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
await app.close();
