import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { useSession } from '../auth.tsx';
import { PageHeading } from '../components/Layout.tsx';
import { capitalize, CATEGORIES, DEVICES, DURATIONS, GENRES, today } from '../format.ts';
import { useResource } from '../useResource.ts';
import { validateCampaign, type CampaignFields, type FieldErrors } from '../validation.ts';

const MAX_CREATIVES = 5;

/** Maps a validation key such as "creatives.0.name" to its input's id. */
const fieldId = (key: string) => key.replace(/^creatives\.(\d+)\.(\w+)$/, 'creative-$1-$2');

function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, error?: string, hint?: string) => [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

export default function NewCampaignPage() {
  const { token, user } = useSession();
  const navigate = useNavigate();
  const isAdmin = user.role === 'admin';
  const advertisers = useResource(() => (isAdmin ? api.advertisers(token) : Promise.resolve([])), [token, isAdmin]);
  const start = today();
  const [form, setForm] = useState<CampaignFields>({
    advertiserId: '',
    name: '',
    category: '',
    startDate: start,
    endDate: addDays(start, 30),
    dailyGoal: '10000',
    cpm: '25.00',
    frequencyCap: '3',
    genres: [],
    devices: [],
    countries: 'IN',
    creatives: [{ name: '', durationSec: '30', mediaUrl: '' }],
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof CampaignFields>(key: K, value: CampaignFields[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: 'genres' | 'devices', value: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }));
  const setCreative = (i: number, key: keyof CampaignFields['creatives'][number], value: string) =>
    setForm((f) => ({ ...f, creatives: f.creatives.map((c, j) => (j === i ? { ...c, [key]: value } : c)) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setServerError('');
    const { errors: found, draft } = validateCampaign(form, { isAdmin, today: today() });
    setErrors(found);
    if (!draft) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setBusy(true);
    try {
      const created = await api.create(token, draft);
      navigate(`/campaigns/${created.id}`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not create the campaign');
      requestAnimationFrame(() => summaryRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const errorList = Object.entries(errors);
  return (
    <>
      <PageHeading title="New campaign">New campaign</PageHeading>
      {(errorList.length > 0 || serverError) && (
        <div className="notice error" role="alert" tabIndex={-1} ref={summaryRef}>
          <h2>{serverError ? 'The campaign was not saved' : `Fix ${errorList.length === 1 ? 'this problem' : `these ${errorList.length} problems`}`}</h2>
          {serverError && <p>{serverError}</p>}
          <ul>
            {errorList.map(([key, message]) => (
              <li key={key}>
                <a href={`#${fieldId(key)}`}>{message}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit} noValidate className="campaign-form">
        <fieldset>
          <legend>Basics</legend>
          {isAdmin && (
            <Field id="advertiserId" label="Advertiser" error={errors.advertiserId}>
              <select id="advertiserId" value={form.advertiserId} onChange={(e) => set('advertiserId', e.target.value)} aria-invalid={!!errors.advertiserId} aria-describedby={describedBy('advertiserId', errors.advertiserId)}>
                <option value="">Choose…</option>
                {advertisers.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id="name" label="Campaign name" error={errors.name}>
            <input id="name" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!errors.name} aria-describedby={describedBy('name', errors.name)} />
          </Field>
          <Field id="category" label="Category" error={errors.category} hint="Ads of the same category never share an ad break.">
            <select id="category" value={form.category} onChange={(e) => set('category', e.target.value)} aria-invalid={!!errors.category} aria-describedby={describedBy('category', errors.category, 'hint')}>
              <option value="">Choose…</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {capitalize(c)}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field id="startDate" label="Start date (UTC)" error={errors.startDate}>
              <input id="startDate" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} aria-invalid={!!errors.startDate} aria-describedby={describedBy('startDate', errors.startDate)} />
            </Field>
            <Field id="endDate" label="End date (UTC)" error={errors.endDate}>
              <input id="endDate" type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} aria-invalid={!!errors.endDate} aria-describedby={describedBy('endDate', errors.endDate)} />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Budget and delivery</legend>
          <div className="row">
            <Field id="dailyGoal" label="Daily impression goal" error={errors.dailyGoal} hint="Delivery is spread evenly over the day.">
              <input id="dailyGoal" inputMode="numeric" value={form.dailyGoal} onChange={(e) => set('dailyGoal', e.target.value)} aria-invalid={!!errors.dailyGoal} aria-describedby={describedBy('dailyGoal', errors.dailyGoal, 'hint')} />
            </Field>
            <Field id="cpm" label="CPM in US dollars" error={errors.cpm} hint="Price per thousand impressions. Higher prices win ad slots first.">
              <input id="cpm" inputMode="decimal" value={form.cpm} onChange={(e) => set('cpm', e.target.value)} aria-invalid={!!errors.cpm} aria-describedby={describedBy('cpm', errors.cpm, 'hint')} />
            </Field>
            <Field id="frequencyCap" label="Frequency cap per viewer per day" error={errors.frequencyCap} hint="0 means no cap.">
              <input id="frequencyCap" inputMode="numeric" value={form.frequencyCap} onChange={(e) => set('frequencyCap', e.target.value)} aria-invalid={!!errors.frequencyCap} aria-describedby={describedBy('frequencyCap', errors.frequencyCap, 'hint')} />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Targeting</legend>
          <p className="hint">Leave a group empty to reach everyone in it.</p>
          <fieldset className="checks">
            <legend>Genres</legend>
            {GENRES.map((g) => (
              <label key={g}>
                <input type="checkbox" checked={form.genres.includes(g)} onChange={() => toggle('genres', g)} /> {capitalize(g)}
              </label>
            ))}
          </fieldset>
          <fieldset className="checks">
            <legend>Devices</legend>
            {DEVICES.map((d) => (
              <label key={d.value}>
                <input type="checkbox" checked={form.devices.includes(d.value)} onChange={() => toggle('devices', d.value)} /> {d.label}
              </label>
            ))}
          </fieldset>
          <Field id="countries" label="Countries" error={errors.countries} hint="Two-letter codes separated by commas, such as IN, US.">
            <input id="countries" value={form.countries} onChange={(e) => set('countries', e.target.value)} aria-invalid={!!errors.countries} aria-describedby={describedBy('countries', errors.countries, 'hint')} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Creatives</legend>
          {errors.creatives && <p className="field-error">{errors.creatives}</p>}
          {form.creatives.map((c, i) => (
            <div className="creative" key={i}>
              <Field id={`creative-${i}-name`} label={`Creative ${i + 1} name`} error={errors[`creatives.${i}.name`]}>
                <input id={`creative-${i}-name`} value={c.name} onChange={(e) => setCreative(i, 'name', e.target.value)} aria-invalid={!!errors[`creatives.${i}.name`]} aria-describedby={describedBy(`creative-${i}-name`, errors[`creatives.${i}.name`])} />
              </Field>
              <Field id={`creative-${i}-durationSec`} label="Length">
                <select id={`creative-${i}-durationSec`} value={c.durationSec} onChange={(e) => setCreative(i, 'durationSec', e.target.value)}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} seconds
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`creative-${i}-mediaUrl`} label="Video URL (https)" error={errors[`creatives.${i}.mediaUrl`]}>
                <input id={`creative-${i}-mediaUrl`} type="url" placeholder="https://" value={c.mediaUrl} onChange={(e) => setCreative(i, 'mediaUrl', e.target.value)} aria-invalid={!!errors[`creatives.${i}.mediaUrl`]} aria-describedby={describedBy(`creative-${i}-mediaUrl`, errors[`creatives.${i}.mediaUrl`])} />
              </Field>
              {form.creatives.length > 1 && (
                <button type="button" className="link-button" onClick={() => set('creatives', form.creatives.filter((_, j) => j !== i))}>
                  Remove creative {i + 1}
                </button>
              )}
            </div>
          ))}
          {form.creatives.length < MAX_CREATIVES && (
            <button type="button" onClick={() => set('creatives', [...form.creatives, { name: '', durationSec: '15', mediaUrl: '' }])}>
              Add another creative
            </button>
          )}
        </fieldset>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </form>
    </>
  );
}
