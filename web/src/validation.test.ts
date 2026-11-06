import { describe, expect, it } from 'vitest';
import { paceStatus } from './format.ts';
import { validateCampaign, type CampaignFields } from './validation.ts';

const valid: CampaignFields = {
  advertiserId: '',
  name: '  Winter Drive  ',
  category: 'auto',
  startDate: '2026-11-06',
  endDate: '2026-12-06',
  dailyGoal: '10000',
  cpm: '25.5',
  frequencyCap: '3',
  genres: ['sports'],
  devices: ['ctv'],
  countries: 'in, us,IN',
  creatives: [{ name: 'Spot', durationSec: '30', mediaUrl: 'https://media.example.com/a.mp4' }],
};

describe('validateCampaign', () => {
  it('builds the API request from valid fields', () => {
    const { errors, draft } = validateCampaign(valid, { isAdmin: false, today: '2026-11-06' });
    expect(errors).toEqual({});
    expect(draft).toEqual({
      name: 'Winter Drive',
      category: 'auto',
      startDate: '2026-11-06',
      endDate: '2026-12-06',
      dailyImpressionGoal: 10000,
      cpmCents: 2550,
      frequencyCapPerDay: 3,
      targeting: { genres: ['sports'], devices: ['ctv'], countries: ['IN', 'US'] },
      creatives: [{ name: 'Spot', durationSec: 30, mediaUrl: 'https://media.example.com/a.mp4' }],
    });
  });

  it('reports every problem with its field', () => {
    const { errors, draft } = validateCampaign(
      {
        ...valid,
        name: 'ab',
        category: '',
        endDate: '2026-11-01',
        dailyGoal: '12.5',
        cpm: 'free',
        frequencyCap: '99',
        countries: 'India',
        creatives: [{ name: '', durationSec: '30', mediaUrl: 'http://insecure.example.com/a.mp4' }],
      },
      { isAdmin: true, today: '2026-11-06' },
    );
    expect(draft).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(
      ['advertiserId', 'category', 'countries', 'cpm', 'creatives.0.mediaUrl', 'creatives.0.name', 'dailyGoal', 'endDate', 'frequencyCap', 'name'].sort(),
    );
    expect(errors.endDate).toBe('The end date must be on or after the start date.');
  });

  it('rejects an end date in the past', () => {
    const { errors } = validateCampaign({ ...valid, startDate: '2026-10-01', endDate: '2026-10-31' }, { isAdmin: false, today: '2026-11-06' });
    expect(errors.endDate).toBe('The end date is in the past.');
  });
});

describe('paceStatus', () => {
  const noon = new Date('2026-11-06T12:00:00Z');
  it.each([
    [0, 1000, new Date('2026-11-06T00:00:10Z'), 'not started'],
    [300, 1000, noon, 'behind'],
    [480, 1000, noon, 'on pace'],
    [650, 1000, noon, 'ahead'],
    [1000, 1000, noon, 'goal reached'],
  ])('%i of %i at %s is %s', (delivered, goal, now, expected) => {
    expect(paceStatus(delivered, goal, now)).toBe(expected);
  });
});
