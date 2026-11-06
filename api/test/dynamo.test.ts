import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Campaign } from '../src/domain.ts';
import { DynamoStore } from '../src/dynamo.ts';
import { ConflictError } from '../src/store.ts';

// Runs against a moto server (AWS_ENDPOINT_URL), with throwaway tables shaped like infra/terraform's.
const endpoint = process.env.AWS_ENDPOINT_URL;
const suffix = randomUUID().slice(0, 8);
const campaignsTable = `test-campaigns-${suffix}`;
const deliveryTable = `test-delivery-${suffix}`;

const raw = new DynamoDBClient({ region: 'ap-south-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

function campaign(id: string, advertiserId: string): Campaign {
  return {
    id,
    advertiserId,
    name: id,
    category: 'auto',
    status: 'active',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    dailyImpressionGoal: 1000,
    cpmCents: 2000,
    frequencyCapPerDay: 0,
    targeting: { genres: [], devices: [], countries: [] },
    creatives: [{ id: 'cr', name: 'cr', durationSec: 30, mediaUrl: 'https://a.example.com/a.mp4', mimeType: 'video/mp4', width: 1920, height: 1080 }],
    version: 1,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

describe.skipIf(!endpoint)('DynamoStore (moto)', () => {
  let store: DynamoStore;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    await raw.send(
      new CreateTableCommand({
        TableName: campaignsTable,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'advertiserId', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [{ IndexName: 'byAdvertiser', KeySchema: [{ AttributeName: 'advertiserId', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } }],
      }),
    );
    await raw.send(
      new CreateTableCommand({
        TableName: deliveryTable,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'campaignId', AttributeType: 'S' }, { AttributeName: 'period', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'campaignId', KeyType: 'HASH' }, { AttributeName: 'period', KeyType: 'RANGE' }],
      }),
    );
    store = new DynamoStore({ campaignsTable, deliveryTable, region: 'ap-south-1', endpoint });
  });

  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: campaignsTable }));
    await raw.send(new DeleteTableCommand({ TableName: deliveryTable }));
  });

  it('creates, reads, lists by advertiser and refuses duplicates', async () => {
    await store.create(campaign('cmp-a', 'adv-1'));
    await store.create(campaign('cmp-b', 'adv-1'));
    await store.create(campaign('cmp-c', 'adv-2'));
    await expect(store.create(campaign('cmp-a', 'adv-1'))).rejects.toBeInstanceOf(ConflictError);

    expect((await store.get('cmp-a'))?.creatives[0]?.durationSec).toBe(30);
    expect(await store.get('cmp-missing')).toBeUndefined();
    expect((await store.listByAdvertiser('adv-1')).map((c) => c.id).sort()).toEqual(['cmp-a', 'cmp-b']);
    expect(await store.listAll()).toHaveLength(3);
    await store.ping();
  });

  it('updates only from the expected version', async () => {
    const next = { ...campaign('cmp-a', 'adv-1'), cpmCents: 3000, version: 2 };
    expect(await store.update(next, 1)).toBe(true);
    expect(await store.update({ ...next, cpmCents: 1, version: 3 }, 1)).toBe(false);
    expect((await store.get('cmp-a'))?.cpmCents).toBe(3000);
  });

  it('reads the delivery counters the worker writes', async () => {
    const doc = DynamoDBDocumentClient.from(raw);
    for (const [campaignId, period, impressions] of [['cmp-a', '2026-11-06', 120], ['cmp-a', '2026-11-06T09', 80], ['cmp-a', '2026-11-06T10', 40], ['cmp-b', '2026-11-06', 7]] as const) {
      await doc.send(new PutCommand({ TableName: deliveryTable, Item: { campaignId, period, impressions } }));
    }
    const totals = await store.dailyTotals(['cmp-a', 'cmp-b', 'cmp-c'], '2026-11-06');
    expect(Object.fromEntries(totals)).toEqual({ 'cmp-a': 120, 'cmp-b': 7, 'cmp-c': 0 });
    expect(await store.periods('cmp-a', '2026-11-06', '2026-11-06T99')).toEqual([
      { period: '2026-11-06', impressions: 120 },
      { period: '2026-11-06T09', impressions: 80 },
      { period: '2026-11-06T10', impressions: 40 },
    ]);
  });
});
