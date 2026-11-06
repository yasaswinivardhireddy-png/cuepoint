import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, onUnauthorized, type Session } from './api.ts';

interface AuthValue {
  session: Session | null;
  /** True after the user signed out on purpose (as opposed to the token expiring). */
  signedOut: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);
const KEY = 'cuepoint.session';

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

// The session lives in sessionStorage: it ends with the tab, and the JWT itself expires after 8 hours.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(load);
  const [signedOut, setSignedOut] = useState(false);

  const end = useCallback((explicit: boolean) => {
    sessionStorage.removeItem(KEY);
    setSignedOut(explicit);
    setSession(null);
  }, []);
  const signOut = useCallback(() => end(true), [end]);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await api.login(email, password);
    sessionStorage.setItem(KEY, JSON.stringify(next));
    setSignedOut(false);
    setSession(next);
  }, []);

  // An expired or revoked token returns the user to where they were after signing in again.
  useEffect(() => onUnauthorized(() => end(false)), [end]);

  const value = useMemo(() => ({ session, signedOut, signIn, signOut }), [session, signedOut, signIn, signOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth needs an AuthProvider');
  return value;
}

/** The signed-in session; use inside RequireAuth. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error('No session');
  return session;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, signedOut } = useAuth();
  const location = useLocation();
  // After an explicit sign-out the next person starts fresh instead of on the previous user's page.
  if (!session) return <Navigate to="/login" replace state={signedOut ? undefined : { from: location.pathname }} />;
  return children;
}
