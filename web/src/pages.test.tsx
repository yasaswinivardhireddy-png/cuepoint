import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth.tsx';
import CampaignsPage from './pages/CampaignsPage.tsx';
import NewCampaignPage from './pages/NewCampaignPage.tsx';
import SimulatorPage from './pages/SimulatorPage.tsx';

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> };

/** Replaces fetch with a router of canned responses and records every call. */
function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const { status = 200, body, headers = {} } = handler(url, init);
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    }),
  );
  return calls;
}

function signIn(role: 'admin' | 'advertiser' = 'advertiser') {
  const user = role === 'admin' ? { email: 'admin@cuepoint.dev', name: 'Ad Operations', role } : { email: 'ads@acmemotors.example', name: 'Acme Motors', role, advertiserId: 'adv-acme-motors' };
  sessionStorage.setItem('cuepoint.session', JSON.stringify({ token: 'jwt', user }));
}

function renderAt(path: string, routes: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>{routes}</Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const campaign = (overrides: Record<string, unknown> = {}) => ({
  id: 'cmp-1',
  advertiserId: 'adv-acme-motors',
  name: 'Winter Drive',
  category: 'auto',
  status: 'active',
  startDate: '2026-11-03',
  endDate: '2026-12-03',
  dailyImpressionGoal: 20000,
  cpmCents: 3500,
  frequencyCapPerDay: 3,
  targeting: { genres: ['sports'], devices: ['ctv'], countries: ['IN'] },
  creatives: [],
  version: 1,
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
  deliveredToday: 4200,
  ...overrides,
});

describe('campaign list', () => {
  it('shows delivery against the goal and the advertiser column only to admins', async () => {
    signIn('admin');
    mockFetch(() => ({ body: { items: [campaign(), campaign({ id: 'cmp-2', name: 'Summer Fizz', advertiserId: 'adv-bluepeak', status: 'paused', deliveredToday: 0 })] } }));
    renderAt('/campaigns', <Route path="/campaigns" element={<CampaignsPage />} />);

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Advertiser' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Summer Fizz' })).toHaveAttribute('href', '/campaigns/cmp-2');
    expect(screen.getByRole('progressbar', { name: '4,200 of 20,000 impressions today' })).toBeInTheDocument();
    expect(within(table).getAllByText('$35.00')).toHaveLength(2);
  });

  it('filters by status through the URL', async () => {
    signIn();
    const calls = mockFetch(() => ({ body: { items: [] } }));
    renderAt('/campaigns', <Route path="/campaigns" element={<CampaignsPage />} />);
    await screen.findByText(/No campaigns yet/);
    await userEvent.click(screen.getByRole('radio', { name: 'Paused' }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/v1/campaigns?status=paused'));
    expect(screen.queryByRole('columnheader', { name: 'Advertiser' })).not.toBeInTheDocument();
  });
});

describe('new campaign form', () => {
  it('lists problems with links to the fields, then posts a valid campaign', async () => {
    signIn();
    const calls = mockFetch((url, init) => (init?.method === 'POST' ? { status: 201, body: campaign({ id: 'cmp-new' }) } : { body: { items: [] } }));
    renderAt(
      '/campaigns/new',
      <>
        <Route path="/campaigns/new" element={<NewCampaignPage />} />
        <Route path="/campaigns/:id" element={<p>Detail page</p>} />
      </>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create campaign' }));
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByRole('heading', { name: 'Fix these 4 problems' })).toBeInTheDocument();
    expect(within(summary).getByRole('link', { name: 'Enter a name between 3 and 80 characters.' })).toHaveAttribute('href', '#name');
    expect(screen.getByLabelText('Campaign name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Campaign name')).toHaveAccessibleDescription('Enter a name between 3 and 80 characters.');

    await user.type(screen.getByLabelText('Campaign name'), 'Winter Drive');
    await user.selectOptions(screen.getByLabelText('Category'), 'auto');
    await user.click(screen.getByRole('checkbox', { name: 'Sports' }));
    await user.click(screen.getByRole('checkbox', { name: 'Connected TV' }));
    await user.type(screen.getByLabelText('Creative 1 name'), 'Winter 30');
    await user.type(screen.getByLabelText('Video URL (https)'), 'https://media.example.com/winter-30.mp4');
    await user.click(screen.getByRole('button', { name: 'Create campaign' }));

    expect(await screen.findByText('Detail page')).toBeInTheDocument();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/v1/campaigns');
    expect(new Headers(post.init?.headers).get('authorization')).toBe('Bearer jwt');
    expect(JSON.parse(String(post.init?.body))).toMatchObject({
      name: 'Winter Drive',
      category: 'auto',
      dailyImpressionGoal: 10000,
      cpmCents: 2500,
      frequencyCapPerDay: 3,
      targeting: { genres: ['sports'], devices: ['ctv'], countries: ['IN'] },
      creatives: [{ name: 'Winter 30', durationSec: 30, mediaUrl: 'https://media.example.com/winter-30.mp4' }],
    });
  });

  it('shows the API error when the server rejects the campaign', async () => {
    signIn();
    mockFetch(() => ({ status: 400, body: { error: { code: 'invalid_request', message: 'endDate is in the past' } } }));
    renderAt('/campaigns/new', <Route path="/campaigns/new" element={<NewCampaignPage />} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Campaign name'), 'Winter Drive');
    await user.selectOptions(screen.getByLabelText('Category'), 'auto');
    await user.type(screen.getByLabelText('Creative 1 name'), 'Spot');
    await user.type(screen.getByLabelText('Video URL (https)'), 'https://media.example.com/a.mp4');
    await user.click(screen.getByRole('button', { name: 'Create campaign' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The campaign was not saved');
    expect(alert).toHaveTextContent('endDate is in the past');
  });
});

describe('ad break simulator', () => {
  it('shows the break, explains skipped campaigns and sends impressions when played', async () => {
    signIn();
    const calls = mockFetch((url) =>
      url.startsWith('/ads/v1/pods')
        ? {
            body: {
              decisionId: 'abcdef1234567890',
              podDurationSec: 60,
              filledSec: 45,
              ads: [
                { sequence: 1, campaignId: 'cmp-1', campaignName: 'Winter Drive', advertiserId: 'adv-acme-motors', category: 'auto', creativeId: 'c1', durationSec: 30, mediaUrl: 'https://m/1.mp4', impressionUrl: '/ads/v1/events?d=1' },
                { sequence: 2, campaignId: 'cmp-2', campaignName: 'Summer Fizz', advertiserId: 'adv-bluepeak', category: 'beverage', creativeId: 'c2', durationSec: 15, mediaUrl: 'https://m/2.mp4', impressionUrl: '/ads/v1/events?d=2' },
              ],
              skipped: [{ campaignId: 'cmp-3', campaignName: 'Zephyr SUV Season', reason: 'competitive separation: another auto ad is in this break' }],
            },
          }
        : { status: 204 },
    );
    renderAt('/simulator', <Route path="/simulator" element={<SimulatorPage />} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Break length'), '60');
    await user.click(screen.getByRole('button', { name: 'Request ad break' }));

    expect(await screen.findByText('Ad break filled: 2 ads, 45 of 60 seconds.')).toBeInTheDocument();
    expect(calls[0]?.url).toMatch(/^\/ads\/v1\/pods\?genre=sports&device=ctv&country=IN&pod=60&uid=viewer-\d{4}&debug=1$/);
    const skipped = screen.getByRole('table');
    expect(within(skipped).getByRole('cell', { name: 'Competitive separation: another auto ad is in this break' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Play break (send impressions)' }));
    expect(await screen.findByText(/2 impressions recorded/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith('/ads/v1/events')).map((c) => c.url)).toEqual(['/ads/v1/events?d=1', '/ads/v1/events?d=2']);
    expect(screen.getByRole('button', { name: 'Impressions recorded' })).toBeDisabled();
  });
});
