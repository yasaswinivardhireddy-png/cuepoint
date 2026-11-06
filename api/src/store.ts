import type { Campaign } from './domain.ts';

export interface CampaignStore {
  get(id: string): Promise<Campaign | undefined>;
  listByAdvertiser(advertiserId: string): Promise<Campaign[]>;
  listAll(): Promise<Campaign[]>;
  /** Fails with ConflictError if the ID exists. */
  create(campaign: Campaign): Promise<void>;
  /** Writes only if the stored version is still `expectedVersion`; returns false otherwise. */
  update(campaign: Campaign, expectedVersion: number): Promise<boolean>;
  ping(): Promise<void>;
}

export interface DeliveryPoint {
  period: string; // "2026-11-06" for a day, "2026-11-06T09" for an hour
  impressions: number;
}

/** Read side of the delivery counters the reporting worker maintains. */
export interface DeliveryStore {
  dailyTotals(campaignIds: string[], day: string): Promise<Map<string, number>>;
  periods(campaignId: string, from: string, to: string): Promise<DeliveryPoint[]>;
}

export class ConflictError extends Error {}

const clone = <T>(value: T): T => structuredClone(value);

/** In-process store for tests and running without AWS. */
export class MemoryStore implements CampaignStore, DeliveryStore {
  readonly campaigns = new Map<string, Campaign>();
  readonly delivery = new Map<string, number>(); // `${campaignId}|${period}`

  async get(id: string) {
    const c = this.campaigns.get(id);
    return c && clone(c);
  }

  async listByAdvertiser(advertiserId: string) {
    return [...this.campaigns.values()].filter((c) => c.advertiserId === advertiserId).map(clone);
  }

  async listAll() {
    return [...this.campaigns.values()].map(clone);
  }

  async create(campaign: Campaign) {
    if (this.campaigns.has(campaign.id)) throw new ConflictError(campaign.id);
    this.campaigns.set(campaign.id, clone(campaign));
  }

  async update(campaign: Campaign, expectedVersion: number) {
    if (this.campaigns.get(campaign.id)?.version !== expectedVersion) return false;
    this.campaigns.set(campaign.id, clone(campaign));
    return true;
  }

  async ping() {}

  record(campaignId: string, period: string, impressions: number) {
    const key = `${campaignId}|${period}`;
    this.delivery.set(key, (this.delivery.get(key) ?? 0) + impressions);
  }

  async dailyTotals(campaignIds: string[], day: string) {
    return new Map(campaignIds.map((id) => [id, this.delivery.get(`${id}|${day}`) ?? 0]));
  }

  async periods(campaignId: string, from: string, to: string) {
    const points: DeliveryPoint[] = [];
    for (const [key, impressions] of this.delivery) {
      const [id, period] = key.split('|') as [string, string];
      if (id === campaignId && period >= from && period <= to) points.push({ period, impressions });
    }
    return points.sort((a, b) => a.period.localeCompare(b.period));
  }
}
