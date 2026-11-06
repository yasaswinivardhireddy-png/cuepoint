import type { CampaignDraft } from './api.ts';
import { CATEGORIES } from './format.ts';

export interface CreativeFields {
  name: string;
  durationSec: string;
  mediaUrl: string;
}

export interface CampaignFields {
  advertiserId: string;
  name: string;
  category: string;
  startDate: string;
  endDate: string;
  dailyGoal: string;
  cpm: string; // dollars
  frequencyCap: string;
  genres: string[];
  devices: string[];
  countries: string; // "IN, US"
  creatives: CreativeFields[];
}

export type FieldErrors = Record<string, string>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isWhole = (s: string) => /^\d+$/.test(s.trim());

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks the form the way the API will, so people see every problem at once, next to its field.
 * Returns the request body when there are no errors.
 */
export function validateCampaign(f: CampaignFields, opts: { isAdmin: boolean; today: string }): { errors: FieldErrors; draft?: CampaignDraft } {
  const errors: FieldErrors = {};
  if (opts.isAdmin && !f.advertiserId) errors.advertiserId = 'Choose the advertiser this campaign belongs to.';
  const name = f.name.trim();
  if (name.length < 3 || name.length > 80) errors.name = 'Enter a name between 3 and 80 characters.';
  if (!(CATEGORIES as readonly string[]).includes(f.category)) errors.category = 'Choose a category.';
  if (!DATE.test(f.startDate)) errors.startDate = 'Enter a start date.';
  if (!DATE.test(f.endDate)) errors.endDate = 'Enter an end date.';
  else if (DATE.test(f.startDate) && f.endDate < f.startDate) errors.endDate = 'The end date must be on or after the start date.';
  else if (f.endDate < opts.today) errors.endDate = 'The end date is in the past.';

  const goal = Number(f.dailyGoal);
  if (!isWhole(f.dailyGoal) || goal < 100 || goal > 10_000_000) errors.dailyGoal = 'Enter a whole number from 100 to 10,000,000.';
  const cpm = Number(f.cpm);
  if (f.cpm.trim() === '' || !Number.isFinite(cpm) || cpm < 0.5 || cpm > 1000) errors.cpm = 'Enter a CPM from $0.50 to $1,000.';
  const cap = Number(f.frequencyCap);
  if (!isWhole(f.frequencyCap) || cap > 50) errors.frequencyCap = 'Enter a whole number from 0 (no cap) to 50.';

  const countries = [...new Set(f.countries.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()))];
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) errors.countries = 'Use two-letter country codes, such as IN or US, separated by commas.';

  if (f.creatives.length === 0) errors.creatives = 'Add at least one creative.';
  f.creatives.forEach((c, i) => {
    if (!c.name.trim()) errors[`creatives.${i}.name`] = `Enter a name for creative ${i + 1}.`;
    if (!isHttpsUrl(c.mediaUrl.trim())) errors[`creatives.${i}.mediaUrl`] = `Enter an https:// video URL for creative ${i + 1}.`;
  });

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    draft: {
      ...(opts.isAdmin ? { advertiserId: f.advertiserId } : {}),
      name,
      category: f.category,
      startDate: f.startDate,
      endDate: f.endDate,
      dailyImpressionGoal: goal,
      cpmCents: Math.round(cpm * 100),
      frequencyCapPerDay: cap,
      targeting: { genres: f.genres, devices: f.devices, countries },
      creatives: f.creatives.map((c) => ({ name: c.name.trim(), durationSec: Number(c.durationSec), mediaUrl: c.mediaUrl.trim() })),
    },
  };
}
