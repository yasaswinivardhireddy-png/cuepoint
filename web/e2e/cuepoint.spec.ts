import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'cuepoint-demo';
const SCREENSHOTS = process.env.SCREENSHOT_DIR;

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
}

/** Fails on any WCAG 2.1 A or AA violation axe-core can detect on the current page. */
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`)).toEqual([]);
}

async function snap(page: Page, name: string) {
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

/** Today's delivered impressions, read from the progress bar's accessible name. */
async function deliveredToday(page: Page): Promise<number> {
  const label = (await page.getByRole('progressbar').first().getAttribute('aria-label')) ?? '';
  return Number(label.split(' of ')[0]?.replace(/,/g, ''));
}

test('advertisers see only their own campaigns', async ({ page }) => {
  await page.goto('/login');
  await expectAccessible(page);
  await signIn(page, 'ads@acmemotors.example');
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: 'Winter Drive' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'City EV Launch' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Summer Fizz' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Advertiser' })).toHaveCount(0);
  await expectAccessible(page);
  await snap(page, 'campaigns');
});

test('an advertiser cannot open another advertiser’s campaign', async ({ page }) => {
  await signIn(page, 'admin@cuepoint.dev');
  await page.getByRole('link', { name: 'Summer Fizz' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Summer Fizz/ })).toBeVisible();
  const url = page.url();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'ads@acmemotors.example');
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Campaign not found' })).toBeVisible();
  await expect(page.getByText('Summer Fizz')).toHaveCount(0);
});

test('create a campaign, then pause and resume it', async ({ page }) => {
  await signIn(page, 'ads@acmemotors.example');
  await page.getByRole('navigation').getByRole('link', { name: 'New campaign' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New campaign' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByRole('alert')).toContainText('Fix these 4 problems');
  await expectAccessible(page);
  await snap(page, 'form-errors');

  const name = `Spring Test Drive ${Date.now() % 100000}`;
  await page.getByLabel('Campaign name').fill(name);
  await page.getByLabel('Category').selectOption('auto');
  await page.getByLabel('Daily impression goal').fill('5000');
  await page.getByRole('checkbox', { name: 'Drama' }).check();
  await page.getByLabel('Creative 1 name').fill('Spring 30');
  await page.getByLabel('Video URL (https)').fill('https://media.example.com/creatives/spring-30s.mp4');
  await page.getByRole('button', { name: 'Create campaign' }).click();

  await expect(page.getByRole('heading', { level: 1, name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText('Drama', { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Pause campaign' }).click();
  await expect(page.getByText(/Campaign paused/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).getByText('Paused')).toBeVisible();
  await page.getByRole('button', { name: 'Resume campaign' }).click();
  await expect(page.getByText('Campaign resumed.')).toBeVisible();

  await page.getByRole('navigation').getByRole('link', { name: 'Campaigns' }).click();
  await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible();
});

test('the simulator explains each decision and enforces frequency caps', async ({ page }) => {
  await signIn(page, 'admin@cuepoint.dev');
  await page.getByRole('link', { name: 'Ad break simulator' }).click();
  await page.getByLabel('Content genre').selectOption('sports');
  await page.getByLabel('Device').selectOption('ctv');
  await page.getByLabel('Country').selectOption('IN');
  await page.getByLabel('Break length').selectOption('60');
  await page.getByLabel('Viewer ID').fill(`e2e-viewer-${Date.now()}`);

  const ads = page.getByRole('list').filter({ hasText: 'Winter Drive' });
  // Winter Drive is capped at 3 per viewer per day: three plays, then it must drop out.
  for (let play = 1; play <= 3; play++) {
    await page.getByRole('button', { name: 'Request ad break' }).click();
    await expect(ads).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Competitive separation: another auto ad is in this break' })).toBeVisible();
    await page.getByRole('button', { name: 'Play break (send impressions)' }).click();
    await expect(page.getByText(/impressions? recorded\./)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Request ad break' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Winter Drive' })).toContainText('Frequency cap reached: this viewer saw it 3 of 3 times today');
  await expect(page.getByRole('list').filter({ hasText: 'Winter Drive' })).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole('button', { name: 'View the VAST response' }).click();
  await expect(page.locator('pre.code')).toContainText('<VAST version="4.2"');
  await snap(page, 'simulator');
});

test('played impressions show up in delivery reporting', async ({ page }) => {
  await signIn(page, 'ads@acmemotors.example');
  await page.getByRole('link', { name: 'Winter Drive' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery today' })).toBeVisible();
  const before = await deliveredToday(page);
  const detail = page.url();

  await page.getByRole('link', { name: 'Ad break simulator' }).click();
  await page.getByLabel('Viewer ID').fill(`e2e-delivery-${Date.now()}`);
  await page.getByRole('button', { name: 'Request ad break' }).click();
  await expect(page.getByRole('list').filter({ hasText: 'Winter Drive' })).toBeVisible();
  await page.getByRole('button', { name: 'Play break (send impressions)' }).click();
  await expect(page.getByText(/impressions? recorded\./)).toBeVisible();

  // The impression travels ad server → SQS → worker → DynamoDB → API.
  await page.goto(detail);
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(1000);
        return deliveredToday(page);
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBeGreaterThan(before);
  await expectAccessible(page);
  await snap(page, 'campaign-detail');
});
