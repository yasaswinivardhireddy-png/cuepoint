export const CATEGORIES = ['auto', 'beverage', 'finance', 'insurance', 'telecom', 'travel', 'retail', 'food', 'tech', 'entertainment'] as const;
export const GENRES = ['sports', 'news', 'drama', 'comedy', 'kids', 'reality', 'documentary'] as const;
export const DEVICES = ['ctv', 'mobile', 'web'] as const;
export const CREATIVE_DURATIONS = [6, 10, 15, 20, 30, 60] as const;

export type Category = (typeof CATEGORIES)[number];
export type Device = (typeof DEVICES)[number];
export type Status = 'active' | 'paused';

export interface Creative {
  id: string;
  name: string;
  durationSec: number;
  mediaUrl: string;
  mimeType: 'video/mp4';
  width: number;
  height: number;
}

export interface Targeting {
  genres: string[];
  devices: Device[];
  countries: string[];
}

export interface Campaign {
  id: string;
  advertiserId: string;
  name: string;
  category: Category;
  status: Status;
  startDate: string; // YYYY-MM-DD, UTC, inclusive
  endDate: string;
  dailyImpressionGoal: number;
  cpmCents: number;
  frequencyCapPerDay: number; // 0 = no cap
  targeting: Targeting;
  creatives: Creative[];
  version: number; // optimistic concurrency: every update must name the version it read
  createdAt: string;
  updatedAt: string;
}

export interface Advertiser {
  id: string;
  name: string;
}

export interface Principal {
  sub: string;
  name: string;
  role: 'admin' | 'advertiser';
  adv?: string; // the advertiser an advertiser user belongs to
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** UTC calendar day, as used for flight dates, daily goals and delivery periods. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayFraction(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getTime() - midnight) / 86_400_000;
}
