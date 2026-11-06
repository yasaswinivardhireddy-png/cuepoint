import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth, useSession } from '../auth.tsx';

/** Page title that also takes focus after navigation, so screen readers announce the new page. */
export function PageHeading({ children, title }: { children: ReactNode; title: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Cuepoint`;
    ref.current?.focus();
  }, [title]);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

export function Layout() {
  const { signOut } = useAuth();
  const { user } = useSession();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand" aria-hidden="true">
          ▶ Cuepoint
        </span>
        <nav aria-label="Main">
          <NavLink to="/campaigns" end>
            Campaigns
          </NavLink>
          <NavLink to="/campaigns/new">New campaign</NavLink>
          <NavLink to="/simulator">Ad break simulator</NavLink>
        </nav>
        <div className="account">
          <span>
            {user.name} <span className="muted">({user.role})</span>
          </span>
          <button type="button" className="link-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" className="page">
        <Outlet />
      </main>
    </>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}

export function ErrorMessage({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <p>{error.message}</p>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
