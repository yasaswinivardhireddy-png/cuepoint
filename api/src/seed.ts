import { createHash } from 'node:crypto';
import { addDays, today, type Campaign, type Category, type Device } from './domain.ts';
import { ConflictError, type CampaignStore } from './store.ts';

interface Demo {
  advertiserId: string;
  name: string;
  category: Category;
  cpmCents: number;
  goal: number;
  cap: number;
  genres?: string[];
  devices?: Device[];
  countries?: string[];
  creatives: [string, number][];
  status?: 'paused';
  startsInDays?: number;
}

// Two auto advertisers compete for the same breaks, so competitive separation is visible in the demo.
const DEMOS: Demo[] = [
  { advertiserId: 'adv-acme-motors', name: 'Winter Drive', category: 'auto', cpmCents: 3500, goal: 20000, cap: 3, genres: ['sports', 'news'], devices: ['ctv'], countries: ['IN'], creatives: [['Winter Drive 30', 30], ['Winter Drive 15', 15]] },
  { advertiserId: 'adv-acme-motors', name: 'City EV Launch', category: 'auto', cpmCents: 2800, goal: 15000, cap: 2, genres: ['drama', 'comedy'], creatives: [['City EV 30', 30]] },
  { advertiserId: 'adv-zephyr-motors', name: 'Zephyr SUV Season', category: 'auto', cpmCents: 3200, goal: 18000, cap: 3, genres: ['sports'], creatives: [['Zephyr SUV 30', 30], ['Zephyr SUV 15', 15]] },
  { advertiserId: 'adv-bluepeak', name: 'Summer Fizz', category: 'beverage', cpmCents: 2200, goal: 30000, cap: 4, genres: ['sports', 'comedy', 'reality'], creatives: [['Summer Fizz 15', 15], ['Summer Fizz 30', 30]] },
  { advertiserId: 'adv-bluepeak', name: 'Match Day Refresh', category: 'beverage', cpmCents: 2600, goal: 25000, cap: 3, genres: ['sports'], devices: ['ctv', 'mobile'], creatives: [['Match Day 20', 20]] },
  { advertiserId: 'adv-summit', name: 'Home Shield', category: 'insurance', cpmCents: 1800, goal: 10000, cap: 2, genres: ['news', 'documentary'], creatives: [['Home Shield 30', 30]] },
  { advertiserId: 'adv-summit', name: 'Travel Cover', category: 'insurance', cpmCents: 1900, goal: 8000, cap: 2, creatives: [['Travel Cover 15', 15]], startsInDays: 10 },
  { advertiserId: 'adv-orbit', name: '5G Everywhere', category: 'telecom', cpmCents: 2000, goal: 40000, cap: 0, creatives: [['5G Everywhere 15', 15], ['5G Bumper 6', 6]] },
  { advertiserId: 'adv-orbit', name: 'Holiday Bundle', category: 'telecom', cpmCents: 2400, goal: 20000, cap: 2, creatives: [['Holiday Bundle 30', 30]], status: 'paused' },
];

/** A UUID-shaped ID derived from `seed`, so every replica seeding at once writes the same items. */
function stableId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Adds the demo campaigns to an empty store; returns how many it created. */
export async function seedDemo(store: CampaignStore, now = new Date()): Promise<number> {
  if ((await store.listAll()).length > 0) return 0;
  const day = today(now);
  let created = 0;
  for (const [i, d] of DEMOS.entries()) {
    const at = new Date(now.getTime() - (DEMOS.length - i) * 60_000).toISOString();
    const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const campaign: Campaign = {
      id: `cmp-${stableId(`${d.advertiserId}/${slug}`)}`,
      advertiserId: d.advertiserId,
      name: d.name,
      category: d.category,
      status: d.status ?? 'active',
      startDate: addDays(day, d.startsInDays ?? -3),
      endDate: addDays(day, 27),
      dailyImpressionGoal: d.goal,
      cpmCents: d.cpmCents,
      frequencyCapPerDay: d.cap,
      targeting: { genres: d.genres ?? [], devices: d.devices ?? [], countries: d.countries ?? [] },
      creatives: d.creatives.map(([name, durationSec]) => ({
        id: `crv-${stableId(`${slug}/${durationSec}`).slice(0, 8)}`,
        name,
        durationSec,
        mediaUrl: `https://media.example.com/creatives/${slug}-${durationSec}s.mp4`,
        mimeType: 'video/mp4',
        width: 1920,
        height: 1080,
      })),
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await store.create(campaign);
      created++;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err; // another replica seeded it first
    }
  }
  return created;
}
