import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type AdBreak } from '../api.ts';
import { PageHeading } from '../components/Layout.tsx';
import { capitalize, COUNTRIES, DEVICES, GENRES } from '../format.ts';

const BREAKS = [30, 60, 90, 120];
const randomViewer = () => `viewer-${Math.floor(1000 + Math.random() * 9000)}`;

/** Requests an ad break the way a video player would, then shows what was chosen and why. */
export default function SimulatorPage() {
  const [params, setParams] = useState({ genre: 'sports', device: 'ctv', country: 'IN', pod: '60', uid: randomViewer() });
  const [result, setResult] = useState<AdBreak>();
  const [played, setPlayed] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [vast, setVast] = useState('');

  const set = (key: keyof typeof params, value: string) => setParams((p) => ({ ...p, [key]: value }));

  async function request(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    setVast('');
    setPlayed(0);
    try {
      const next = await api.adBreak(params);
      setResult(next);
      setStatus(next.ads.length ? `Ad break filled: ${next.ads.length} ads, ${next.filledSec} of ${next.podDurationSec} seconds.` : 'No ad could fill this break.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The ad server did not answer');
    } finally {
      setBusy(false);
    }
  }

  async function play() {
    if (!result) return;
    setBusy(true);
    let recorded = 0;
    for (const ad of result.ads) {
      if (await api.impression(ad.impressionUrl).catch(() => false)) recorded++;
    }
    setPlayed(recorded);
    setStatus(`Played the break: ${recorded} impression${recorded === 1 ? '' : 's'} recorded. Request again to see frequency caps take effect.`);
    setBusy(false);
  }

  async function showVast() {
    try {
      setVast(await api.vast(params));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load VAST');
    }
  }

  return (
    <>
      <PageHeading title="Ad break simulator">Ad break simulator</PageHeading>
      <p className="lead">
        Ask the ad server to fill a break the way a video player would. It applies flight dates, targeting, frequency caps, pacing and
        competitive separation, and explains every campaign it skipped.
      </p>

      <form className="simulator" onSubmit={request}>
        <div className="field">
          <label htmlFor="genre">Content genre</label>
          <select id="genre" value={params.genre} onChange={(e) => set('genre', e.target.value)}>
            {GENRES.map((g) => (
              <option key={g} value={g}>
                {capitalize(g)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="device">Device</label>
          <select id="device" value={params.device} onChange={(e) => set('device', e.target.value)}>
            {DEVICES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="country">Country</label>
          <select id="country" value={params.country} onChange={(e) => set('country', e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pod">Break length</label>
          <select id="pod" value={params.pod} onChange={(e) => set('pod', e.target.value)}>
            {BREAKS.map((b) => (
              <option key={b} value={b}>
                {b} seconds
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="uid">Viewer ID</label>
          <input id="uid" value={params.uid} onChange={(e) => set('uid', e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={busy}>
          Request ad break
        </button>
      </form>

      <div aria-live="polite" className="sr-status">
        {status && <p className="notice">{status}</p>}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <section aria-labelledby="break-heading">
          <h2 id="break-heading">
            Ad break <span className="muted small">decision {result.decisionId.slice(0, 8)}</span>
          </h2>
          <div className="timeline" aria-hidden="true">
            {result.ads.map((ad) => (
              <div key={ad.sequence} className={`segment cat-${ad.category}`} style={{ flexGrow: ad.durationSec }}>
                {ad.durationSec}s
              </div>
            ))}
            {result.filledSec < result.podDurationSec && (
              <div className="segment empty" style={{ flexGrow: result.podDurationSec - result.filledSec }}>
                unfilled
              </div>
            )}
          </div>
          {result.ads.length > 0 ? (
            <ol className="ads">
              {result.ads.map((ad) => (
                <li key={ad.sequence}>
                  <strong>{ad.campaignName}</strong> <span className="muted">({ad.advertiserId.replace(/^adv-/, '')}, {ad.category})</span> — {ad.durationSec} s
                </li>
              ))}
            </ol>
          ) : (
            <p>No campaign could fill this break.</p>
          )}
          <div className="actions">
            <button type="button" onClick={play} disabled={busy || result.ads.length === 0 || played > 0}>
              {played > 0 ? 'Impressions recorded' : 'Play break (send impressions)'}
            </button>
            <button type="button" className="link-button" onClick={showVast}>
              View the VAST response
            </button>
          </div>

          {result.skipped && result.skipped.length > 0 && (
            <>
              <h3>Campaigns not in this break</h3>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Why it was skipped</th>
                  </tr>
                </thead>
                <tbody>
                  {result.skipped.map((s) => (
                    <tr key={s.campaignId}>
                      <td>
                        <Link to={`/campaigns/${s.campaignId}`}>{s.campaignName}</Link>
                      </td>
                      <td>{capitalize(s.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {vast && (
            <>
              <h3>VAST 4.2 response</h3>
              <pre className="code" tabIndex={0}>
                {vast}
              </pre>
            </>
          )}
        </section>
      )}
    </>
  );
}
