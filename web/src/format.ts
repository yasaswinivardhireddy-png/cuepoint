export const CATEGORIES = ['auto', 'beverage', 'finance', 'insurance', 'telecom', 'travel', 'retail', 'food', 'tech', 'entertainment'] as const;
export const GENRES = ['sports', 'news', 'drama', 'comedy', 'kids', 'reality', 'documentary'] as const;
export const DEVICES = [
  { value: 'ctv', label: 'Connected TV' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'web', label: 'Web' },
] as const;
export const DURATIONS = [6, 10, 15, 20, 30, 60] as const;
export const COUNTRIES = ['IN', 'US', 'GB', 'SG', 'AE'] as const;

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatNumber = (n: number) => n.toLocaleString('en-US');

export const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function dayFraction(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getTime() - midnight) / 86_400_000;
}

export type PaceStatus = 'not started' | 'behind' | 'on pace' | 'ahead' | 'goal reached';

/** Compares today's delivery with an even spread of the daily goal over the UTC day. */
export function paceStatus(delivered: number, goal: number, now = new Date()): PaceStatus {
  if (goal > 0 && delivered >= goal) return 'goal reached';
  const expected = goal * dayFraction(now);
  if (delivered === 0 && expected < 1) return 'not started';
  if (expected <= 0) return 'on pace';
  const ratio = delivered / expected;
  if (ratio < 0.8) return 'behind';
  if (ratio > 1.15) return 'ahead';
  return 'on pace';
}
