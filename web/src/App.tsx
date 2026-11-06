import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './auth.tsx';
import { Layout, Loading } from './components/Layout.tsx';

// Each page is its own chunk, so signing in downloads only the login screen.
const LoginPage = lazy(() => import('./pages/LoginPage.tsx'));
const CampaignsPage = lazy(() => import('./pages/CampaignsPage.tsx'));
const CampaignDetailPage = lazy(() => import('./pages/CampaignDetailPage.tsx'));
const NewCampaignPage = lazy(() => import('./pages/NewCampaignPage.tsx'));
const SimulatorPage = lazy(() => import('./pages/SimulatorPage.tsx'));

export function AppRoutes() {
  return (
    <Suspense fallback={<Loading what="the page" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/new" element={<NewCampaignPage />} />
          <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
          <Route path="/simulator" element={<SimulatorPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/campaigns" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
