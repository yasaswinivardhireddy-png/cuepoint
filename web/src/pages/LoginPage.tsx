import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { PageHeading } from '../components/Layout.tsx';
import { useAuth } from '../auth.tsx';

const DEMO_ACCOUNTS = [
  ['ads@acmemotors.example', 'Acme Motors (advertiser)'],
  ['ads@bluepeak.example', 'Bluepeak Beverages (advertiser)'],
  ['admin@cuepoint.dev', 'Ad operations (admin)'],
] as const;

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/campaigns'} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="login">
      <div className="login-card">
        <p className="brand-large" aria-hidden="true">
          ▶ Cuepoint
        </p>
        <PageHeading title="Sign in">Sign in to the campaign manager</PageHeading>
        <form onSubmit={submit} noValidate>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <section aria-labelledby="demo-heading" className="demo">
          <h2 id="demo-heading">Demo accounts</h2>
          <p className="muted">All use the demo password set for this deployment.</p>
          <ul>
            {DEMO_ACCOUNTS.map(([address, label]) => (
              <li key={address}>
                <button type="button" className="link-button" onClick={() => setEmail(address)}>
                  {address}
                </button>{' '}
                <span className="muted">{label}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
