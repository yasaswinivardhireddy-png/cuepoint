import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import { useSession } from '../auth.tsx';
import { HourlyChart } from '../components/HourlyChart.tsx';
import { ErrorMessage, Loading, PageHeading } from '../components/Layout.tsx';
import { PacingBar, StatusBadge } from '../components/PacingBar.tsx';
import { capitalize, DEVICES, formatMoney, formatNumber } from '../format.ts';
import { useResource } from '../useResource.ts';

const list = (values: string[], all: string) => (values.length ? values.join(', ') : all);

export default function CampaignDetailPage() {
  const { id = '' } = useParams();
  const { token } = useSession();
  const campaign = useResource(() => api.campaign(token, id), [token, id]);
  const delivery = useResource(() => api.delivery(token, id), [token, id]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');

  if (campaign.error) {
    const missing = campaign.error instanceof ApiError && campaign.error.status === 404;
    return (
      <>
        <PageHeading title="Campaign not found">{missing ? 'Campaign not found' : 'Could not load the campaign'}</PageHeading>
        {missing ? (
          <p>
            It does not exist or belongs to another advertiser. <Link to="/campaigns">Back to campaigns</Link>
          </p>
        ) : (
          <ErrorMessage error={campaign.error} retry={campaign.reload} />
        )}
      </>
    );
  }
  if (!campaign.data) return <Loading what="the campaign" />;

  const { data: c, etag } = campaign.data;
  const next = c.status === 'active' ? 'paused' : 'active';

  async function toggle() {
    setSaving(true);
    setMessage('');
    setFailure('');
    try {
      await api.update(token, c.id, etag ?? '', { status: next });
      setMessage(next === 'paused' ? 'Campaign paused. Ad breaks stop including it within a few seconds.' : 'Campaign resumed.');
      campaign.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        setFailure('Someone else changed this campaign while you were looking at it. The latest version is now shown; try again.');
        campaign.reload();
      } else {
        setFailure(err instanceof Error ? err.message : 'Could not save');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/campaigns">Campaigns</Link> /
      </p>
      <div className="page-header">
        <PageHeading title={c.name}>
          {c.name} <StatusBadge status={c.status} />
        </PageHeading>
        <button type="button" onClick={toggle} disabled={saving}>
          {saving ? 'Saving…' : next === 'paused' ? 'Pause campaign' : 'Resume campaign'}
        </button>
      </div>
      <div aria-live="polite">
        {message && <p className="notice success">{message}</p>}
        {failure && <p className="notice error">{failure}</p>}
      </div>

      <section className="cards" aria-label="Summary">
        <dl>
          <div>
            <dt>Advertiser</dt>
            <dd>{c.advertiserId.replace(/^adv-/, '')}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{capitalize(c.category)}</dd>
          </div>
          <div>
            <dt>Flight</dt>
            <dd>
              {c.startDate} → {c.endDate}
            </dd>
          </div>
          <div>
            <dt>CPM</dt>
            <dd>{formatMoney(c.cpmCents)}</dd>
          </div>
          <div>
            <dt>Daily goal</dt>
            <dd>{formatNumber(c.dailyImpressionGoal)} impressions</dd>
          </div>
          <div>
            <dt>Frequency cap</dt>
            <dd>{c.frequencyCapPerDay ? `${c.frequencyCapPerDay} per viewer per day` : 'None'}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="delivery-heading">
        <h2 id="delivery-heading">Delivery today</h2>
        <PacingBar delivered={delivery.data?.deliveredToday ?? c.deliveredToday} goal={c.dailyImpressionGoal} />
        {delivery.data && (
          <p className="muted">
            An even pace would be {formatNumber(delivery.data.expectedByNow)} impressions by now.{' '}
            <button type="button" className="link-button" onClick={() => { delivery.reload(); campaign.reload(); }}>
              Refresh
            </button>
          </p>
        )}
        {delivery.error && <ErrorMessage error={delivery.error} retry={delivery.reload} />}
        {delivery.data && <HourlyChart hourly={delivery.data.hourly} />}
        {delivery.data && (
          <>
            <h3>Last 7 days</h3>
            <ul className="days">
              {delivery.data.daily.map((d) => (
                <li key={d.day}>
                  <span>{d.day}</span> <strong>{formatNumber(d.impressions)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="targeting-heading">
        <h2 id="targeting-heading">Targeting</h2>
        <dl className="inline">
          <dt>Genres</dt>
          <dd>{list(c.targeting.genres.map(capitalize), 'All genres')}</dd>
          <dt>Devices</dt>
          <dd>{list(c.targeting.devices.map((d) => DEVICES.find((x) => x.value === d)?.label ?? d), 'All devices')}</dd>
          <dt>Countries</dt>
          <dd>{list(c.targeting.countries, 'All countries')}</dd>
        </dl>
      </section>

      <section aria-labelledby="creatives-heading">
        <h2 id="creatives-heading">Creatives</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="num">
                Length
              </th>
              <th scope="col">Video</th>
            </tr>
          </thead>
          <tbody>
            {c.creatives.map((cr) => (
              <tr key={cr.id}>
                <td>{cr.name}</td>
                <td className="num">{cr.durationSec} s</td>
                <td className="break">
                  {cr.mediaUrl} <span className="muted">({cr.width}×{cr.height})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
