import { CATEGORIES, CREATIVE_DURATIONS, DEVICES, GENRES } from './domain.ts';

// JSON Schemas validate requests, shape responses (unknown fields are never serialized) and
// generate the OpenAPI document served at /docs.

const day = { type: 'string', format: 'date', description: 'UTC calendar day, YYYY-MM-DD' } as const;

const creativeProps = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  durationSec: { type: 'integer', enum: CREATIVE_DURATIONS },
  mediaUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 500 },
  width: { type: 'integer', minimum: 320, maximum: 7680, default: 1920 },
  height: { type: 'integer', minimum: 180, maximum: 4320, default: 1080 },
} as const;

const targetingProps = {
  genres: { type: 'array', uniqueItems: true, items: { type: 'string', enum: GENRES } },
  devices: { type: 'array', uniqueItems: true, items: { type: 'string', enum: DEVICES } },
  countries: { type: 'array', uniqueItems: true, maxItems: 50, items: { type: 'string', pattern: '^[A-Z]{2}$' } },
} as const;

// No defaults here: Ajv fills defaults in, and a default inside a PATCH body would overwrite
// stored targeting on every unrelated edit.
const editable = {
  name: { type: 'string', minLength: 3, maxLength: 80 },
  status: { type: 'string', enum: ['active', 'paused'] },
  endDate: day,
  dailyImpressionGoal: { type: 'integer', minimum: 100, maximum: 10_000_000 },
  cpmCents: { type: 'integer', minimum: 50, maximum: 100_000, description: 'Price per thousand impressions, in cents' },
  frequencyCapPerDay: { type: 'integer', minimum: 0, maximum: 50, description: 'Impressions per viewer per day; 0 means no cap' },
  targeting: { type: 'object', additionalProperties: false, properties: targetingProps, description: 'Lists given here replace the stored ones; omitted lists are kept' },
} as const;

export const campaignCreate = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'category', 'startDate', 'endDate', 'dailyImpressionGoal', 'cpmCents', 'creatives'],
  properties: {
    ...editable,
    advertiserId: { type: 'string', pattern: '^adv-[a-z0-9-]{2,40}$', description: 'Admins only; advertisers always create for themselves' },
    category: { type: 'string', enum: CATEGORIES },
    startDate: day,
    status: { ...editable.status, default: 'active' },
    frequencyCapPerDay: { ...editable.frequencyCapPerDay, default: 0 },
    targeting: { type: 'object', additionalProperties: false, properties: targetingProps, description: 'Empty or missing lists target everyone' },
    creatives: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['name', 'durationSec', 'mediaUrl'], properties: creativeProps },
    },
  },
} as const;

export const campaignPatch = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: editable,
} as const;

export const campaign = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    advertiserId: { type: 'string' },
    name: { type: 'string' },
    category: { type: 'string' },
    status: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    dailyImpressionGoal: { type: 'integer' },
    cpmCents: { type: 'integer' },
    frequencyCapPerDay: { type: 'integer' },
    targeting: {
      type: 'object',
      properties: {
        genres: { type: 'array', items: { type: 'string' } },
        devices: { type: 'array', items: { type: 'string' } },
        countries: { type: 'array', items: { type: 'string' } },
      },
    },
    creatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          durationSec: { type: 'integer' },
          mediaUrl: { type: 'string' },
          mimeType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
      },
    },
    version: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    deliveredToday: { type: 'integer', description: 'Impressions counted so far today' },
  },
} as const;

export const errorBody = {
  type: 'object',
  properties: {
    error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
  },
} as const;

export const campaignId = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^cmp-[0-9a-f-]{36}$' } },
} as const;

export const delivery = {
  type: 'object',
  properties: {
    campaignId: { type: 'string' },
    day: { type: 'string' },
    dailyImpressionGoal: { type: 'integer' },
    deliveredToday: { type: 'integer' },
    expectedByNow: { type: 'integer', description: 'Impressions an even delivery over the day would have reached by now' },
    pacing: { type: 'number', description: 'deliveredToday / expectedByNow; 1.0 is exactly on pace' },
    hourly: { type: 'array', items: { type: 'object', properties: { hour: { type: 'string' }, impressions: { type: 'integer' } } } },
    daily: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, impressions: { type: 'integer' } } } },
  },
} as const;
