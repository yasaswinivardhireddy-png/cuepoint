import { Link, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { useSession } from '../auth.tsx';
import { ErrorMessage, Loading, PageHeading } from '../components/Layout.tsx';
import { PacingBar, StatusBadge } from '../components/PacingBar.tsx';
import { capitalize, formatMoney, formatNumber } from '../format.ts';
import { useResource } from '../useResource.ts';

const FILTERS = [
  ['', 'All'],
  ['active', 'Active'],
  ['paused', 'Paused'],
] as const;

export default function CampaignsPage() {
  const { token, user } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const campaigns = useResource(() => api.campaigns(token, status || undefined), [token, status]);
  const isAdmin = user.role === 'admin';

  return (
    <>
      <div className="page-header">
        <PageHeading title="Campaigns">Campaigns</PageHeading>
        <Link className="button primary" to="/campaigns/new">
          New campaign
        </Link>
      </div>

      <fieldset className="segmented">
        <legend className="visually-hidden">Show campaigns</legend>
        {FILTERS.map(([value, label]) => (
          <label key={value || 'all'}>
            <input type="radio" name="status" value={value} checked={status === value} onChange={() => setParams(value ? { status: value } : {})} />
            {label}
          </label>
        ))}
      </fieldset>

      {campaigns.error && <ErrorMessage error={campaigns.error} retry={campaigns.reload} />}
      {campaigns.loading && !campaigns.data && <Loading what="campaigns" />}
      {campaigns.data && campaigns.data.length === 0 && (
        <p className="empty">
          No campaigns yet. <Link to="/campaigns/new">Create the first one</Link>.
        </p>
      )}
      {campaigns.data && campaigns.data.length > 0 && (
        <div className="table-wrap" aria-busy={campaigns.loading}>
          <table className="campaigns">
            <caption className="visually-hidden">Campaigns with today's delivery</caption>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                {isAdmin && <th scope="col">Advertiser</th>}
                <th scope="col">Status</th>
                <th scope="col">Flight</th>
                <th scope="col" className="num">
                  CPM
                </th>
                <th scope="col" className="num">
                  Daily goal
                </th>
                <th scope="col">Delivered today</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/campaigns/${c.id}`}>{c.name}</Link>
                    <div className="muted small">{capitalize(c.category)}</div>
                  </td>
                  {isAdmin && <td>{c.advertiserId.replace(/^adv-/, '')}</td>}
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="nowrap">
                    {c.startDate} → {c.endDate}
                  </td>
                  <td className="num">{formatMoney(c.cpmCents)}</td>
                  <td className="num">{formatNumber(c.dailyImpressionGoal)}</td>
                  <td>
                    <PacingBar delivered={c.deliveredToday} goal={c.dailyImpressionGoal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
