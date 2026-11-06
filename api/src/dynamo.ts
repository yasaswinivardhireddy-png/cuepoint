import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { Campaign } from './domain.ts';
import { ConflictError, type CampaignStore, type DeliveryPoint, type DeliveryStore } from './store.ts';

export interface DynamoConfig {
  campaignsTable: string;
  deliveryTable: string;
  region: string;
  endpoint?: string; // a moto server in local runs and CI
}

type Page = { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };

/** Campaigns and delivery counters in DynamoDB; infra/terraform creates the tables. */
export class DynamoStore implements CampaignStore, DeliveryStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly cfg: DynamoConfig;

  constructor(cfg: DynamoConfig) {
    this.cfg = cfg;
    const client = new DynamoDBClient({ region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}), maxAttempts: 3 });
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(id: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.cfg.campaignsTable, Key: { id }, ConsistentRead: true }));
    return out.Item as Campaign | undefined;
  }

  async listByAdvertiser(advertiserId: string) {
    return this.collect((startKey) =>
      this.doc.send(
        new QueryCommand({
          TableName: this.cfg.campaignsTable,
          IndexName: 'byAdvertiser',
          KeyConditionExpression: 'advertiserId = :a',
          ExpressionAttributeValues: { ':a': advertiserId },
          ExclusiveStartKey: startKey,
        }),
      ),
    );
  }

  async listAll() {
    return this.collect((startKey) => this.doc.send(new ScanCommand({ TableName: this.cfg.campaignsTable, ExclusiveStartKey: startKey })));
  }

  private async collect(page: (startKey?: Record<string, unknown>) => Promise<Page>) {
    const items: Campaign[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await page(startKey);
      items.push(...((out.Items ?? []) as unknown as Campaign[]));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async create(campaign: Campaign) {
    try {
      await this.doc.send(new PutCommand({ TableName: this.cfg.campaignsTable, Item: campaign, ConditionExpression: 'attribute_not_exists(id)' }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConflictError(campaign.id);
      throw err;
    }
  }

  async update(campaign: Campaign, expectedVersion: number) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.cfg.campaignsTable,
          Item: campaign,
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expectedVersion },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async ping() {
    await this.doc.send(new GetCommand({ TableName: this.cfg.campaignsTable, Key: { id: '__health__' } }));
  }

  async dailyTotals(campaignIds: string[], day: string) {
    const totals = new Map(campaignIds.map((id) => [id, 0]));
    for (let i = 0; i < campaignIds.length; i += 100) {
      let keys: Record<string, unknown>[] | undefined = campaignIds.slice(i, i + 100).map((campaignId) => ({ campaignId, period: day }));
      // Under load BatchGet can return some keys unprocessed; retry those with backoff.
      for (let attempt = 0; keys?.length && attempt < 5; attempt++) {
        const out = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.cfg.deliveryTable]: { Keys: keys } } }));
        for (const item of out.Responses?.[this.cfg.deliveryTable] ?? []) totals.set(item.campaignId as string, Number(item.impressions ?? 0));
        keys = out.UnprocessedKeys?.[this.cfg.deliveryTable]?.Keys as Record<string, unknown>[] | undefined;
        if (keys?.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    return totals;
  }

  async periods(campaignId: string, from: string, to: string) {
    const points: DeliveryPoint[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.cfg.deliveryTable,
          KeyConditionExpression: 'campaignId = :c AND #p BETWEEN :from AND :to',
          ExpressionAttributeNames: { '#p': 'period' },
          ExpressionAttributeValues: { ':c': campaignId, ':from': from, ':to': to },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of out.Items ?? []) points.push({ period: item.period as string, impressions: Number(item.impressions ?? 0) });
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return points;
  }
}
