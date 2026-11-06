export interface User {
  email: string;
  name: string;
  role: 'admin' | 'advertiser';
  advertiserId?: string;
}

export interface Session {
  token: string;
  user: User;
}

export interface Creative {
  id: string;
  name: string;
  durationSec: number;
  mediaUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface Targeting {
  genres: string[];
  devices: string[];
  countries: string[];
}

export interface Campaign {
  id: string;
  advertiserId: string;
  name: string;
  category: string;
  status: 'active' | 'paused';
  startDate: string;
  endDate: string;
  dailyImpressionGoal: number;
  cpmCents: number;
  frequencyCapPerDay: number;
  targeting: Targeting;
  creatives: Creative[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deliveredToday: number;
}

export interface CampaignDraft {
  advertiserId?: string;
  name: string;
  category: string;
  startDate: string;
  endDate: string;
  dailyImpressionGoal: number;
  cpmCents: number;
  frequencyCapPerDay: number;
  targeting: Targeting;
  creatives: { name: string; durationSec: number; mediaUrl: string }[];
}

export interface Delivery {
  campaignId: string;
  day: string;
  dailyImpressionGoal: number;
  deliveredToday: number;
  expectedByNow: number;
  pacing: number;
  hourly: { hour: string; impressions: number }[];
  daily: { day: string; impressions: number }[];
}

export interface Advertiser {
  id: string;
  name: string;
}

export interface PlacedAd {
  sequence: number;
  campaignId: string;
  campaignName: string;
  advertiserId: string;
  category: string;
  creativeId: string;
  durationSec: number;
  mediaUrl: string;
  impressionUrl: string;
}

export interface AdBreak {
  decisionId: string;
  podDurationSec: number;
  filledSec: number;
  ads: PlacedAd[];
  skipped?: { campaignId: string; campaignName: string; reason: string }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorized: () => void = () => {};

/** Called when the API rejects the session token, so the app can sign the user out. */
export function onUnauthorized(handler: () => void) {
  unauthorized = handler;
}

async function call<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<{ data: T; etag: string | null }> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body !== undefined) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...rest, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && token) unauthorized();
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, error?.code ?? 'error', error?.message ?? `Request failed (${res.status})`);
  }
  return { data: body as T, etag: res.headers.get('etag') };
}

export const api = {
  login: (email: string, password: string) => call<Session>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }).then((r) => r.data),

  campaigns: (token: string, status?: string) =>
    call<{ items: Campaign[] }>(`/api/v1/campaigns${status ? `?status=${encodeURIComponent(status)}` : ''}`, { token }).then((r) => r.data.items),

  campaign: (token: string, id: string) => call<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`, { token }),

  delivery: (token: string, id: string) => call<Delivery>(`/api/v1/campaigns/${encodeURIComponent(id)}/delivery`, { token }).then((r) => r.data),

  advertisers: (token: string) => call<{ items: Advertiser[] }>('/api/v1/advertisers', { token }).then((r) => r.data.items),

  create: (token: string, draft: CampaignDraft) => call<Campaign>('/api/v1/campaigns', { method: 'POST', token, body: JSON.stringify(draft) }).then((r) => r.data),

  /** `etag` must be the one read with the campaign; a stale one fails with 412. */
  update: (token: string, id: string, etag: string, patch: Partial<Pick<Campaign, 'status' | 'name' | 'cpmCents' | 'dailyImpressionGoal'>>) =>
    call<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', token, headers: { 'if-match': etag }, body: JSON.stringify(patch) }),

  adBreak: (params: Record<string, string>) => call<AdBreak>(`/ads/v1/pods?${new URLSearchParams({ ...params, debug: '1' })}`).then((r) => r.data),

  vast: async (params: Record<string, string>) => {
    const res = await fetch(`/ads/v1/pods?${new URLSearchParams({ ...params, format: 'vast' })}`);
    if (!res.ok) throw new ApiError(res.status, 'error', `Request failed (${res.status})`);
    return res.text();
  },

  /** What a video player does when an ad starts playing. */
  impression: async (url: string) => {
    const res = await fetch(url, { keepalive: true });
    return res.status === 204;
  },
};
