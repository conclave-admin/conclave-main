import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ProtectedRoute from './components/routing/ProtectedRoute';
import PublicOnlyRoute from './components/routing/PublicOnlyRoute';
import Spinner from './components/ui/Spinner';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { RealtimeProvider } from './contexts/RealtimeContext';
import { OutboxProvider } from './contexts/OutboxContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import StaticPage from './pages/StaticPage';

const CatchUpDigestPage = lazy(() => import('./pages/CatchUpDigestPage'));
const Chats = lazy(() => import('./pages/Chats'));
const Decisions = lazy(() => import('./pages/Decisions'));
const DiscoverRooms = lazy(() => import('./pages/DiscoverRooms'));
const DecisionDetail = lazy(() => import('./pages/DecisionDetail'));
const Login = lazy(() => import('./pages/Login'));
const NewChat = lazy(() => import('./pages/NewChat'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Register = lazy(() => import('./pages/Register'));
const Room = lazy(() => import('./pages/Room'));
const RoomInfo = lazy(() => import('./pages/RoomInfo'));
const Settings = lazy(() => import('./pages/Settings'));
const Tasks = lazy(() => import('./pages/Tasks'));

// Keep public-page illustrations and content outside the signed-in app bundle.
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
            <OutboxProvider>
            <Suspense fallback={<Spinner fullPage label="Loading" />}>
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
                  {/* Target of the post-auth redirect. Two panes: the list,
                      and the open conversation — both keyed off this URL so a
                      filtered or deep-linked view survives a reload. */}
                  <Route path="/chats" element={<Chats />}>
                    <Route path=":roomId" element={<Room />} />
                    <Route path=":roomId/info" element={<RoomInfo />} />
                  </Route>

                  {/* The sidebar has always linked to /dms. Rather than
                      maintain a second list component, it resolves into the
                      same one with the DMs chip selected — one implementation,
                      and the chip and the route cannot disagree. */}
                  <Route path="/dms" element={<Navigate to="/chats?filter=dms" replace />} />

                  {/* Stub behind the sidebar's "Invite members" and the mobile
                      compose button. */}
                  <Route path="/new" element={<NewChat />} />
                  <Route path="/discover" element={<DiscoverRooms />} />

                  <Route path="/profile" element={<Profile />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/decisions" element={<Decisions />} />
                  {/* Registered as a sibling, not a child of /decisions: the
                      board is a list page and the detail page is a different
                      layout, not a nested view of it. */}
                  <Route path="/decisions/:decisionId" element={<DecisionDetail />} />
                  <Route path="/digest" element={<CatchUpDigestPage />} />
                  <Route path="/tasks" element={<Tasks />} />
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </OutboxProvider>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
