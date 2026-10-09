import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ProtectedRoute from './components/routing/ProtectedRoute';
import PublicOnlyRoute from './components/routing/PublicOnlyRoute';
import Spinner from './components/ui/Spinner';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { RealtimeProvider } from './contexts/RealtimeContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import CatchUpDigestPage from './pages/CatchUpDigestPage';
import Chats from './pages/Chats';
import Decisions from './pages/Decisions';
import Login from './pages/Login';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';
import Register from './pages/Register';
import Room from './pages/Room';
import Settings from './pages/Settings';
import StaticPage from './pages/StaticPage';
import Tasks from './pages/Tasks';

// Lazy because Landing statically imports GSAP, and GSAP is landing-only. A
// signed-in user going to the chat list must never download it, so it rides
// in this chunk rather than in the entry bundle.
const Landing = lazy(() => import('./pages/Landing'));

/**
 * `/` is the public landing page.
 *
 * Two things it has to get right. The session restore is awaited before
 * deciding anything: redirecting on a guess and correcting a moment later is
 * visible as a flash of the marketing page to someone who is already signed
 * in. And the redirect target is `/chats`, never `/` — the catch-all sends
 * unknown paths to `/`, so a loop here would not resolve on its own.
 */
function LandingRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <Spinner fullPage label="Loading" />;
  if (isAuthenticated) return <Navigate to="/chats" replace />;

  return (
    <Suspense fallback={<Spinner fullPage label="Loading" />}>
      <Landing />
    </Suspense>
  );
}

export default function App() {
  return (
    // Outermost: the auth screens need the theme too, and it does not depend on
    // the session, so there is no reason to nest it under AuthProvider. ToastProvider
    // sits above AuthProvider for the same reason — registration wants a toast.
    // Each added level indents the tree below it; that is the only reason the
    // routes moved.
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>
            <Routes>
              <Route path="/" element={<LandingRoute />} />

              <Route element={<PublicOnlyRoute />}>
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
              </Route>

              {/* Placeholders behind the landing footer. They render an honest
                  empty state rather than invented pricing or legal copy. */}
              <Route path="/pricing" element={<StaticPage title="Pricing" />} />
              <Route path="/privacy" element={<StaticPage title="Privacy" />} />
              <Route path="/terms" element={<StaticPage title="Terms" />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<AppShell />}>
                  {/* Target of the post-auth redirect. Replaced in phase 4 by
                      the real chat list. */}
                  <Route path="/chats" element={<Chats />} />
                  <Route path="/rooms/:roomId" element={<Room />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/decisions" element={<Decisions />} />
                  <Route path="/digest" element={<CatchUpDigestPage />} />
                  <Route path="/tasks" element={<Tasks />} />
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
