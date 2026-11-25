import JoinRoom from "./pages/JoinRoom";
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import ProtectedRoute from "./components/routing/ProtectedRoute";
import PublicOnlyRoute from "./components/routing/PublicOnlyRoute";
import Spinner from "./components/ui/Spinner";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { PushProvider } from "./contexts/PushContext";
import { SyncProvider } from "./contexts/SyncContext";
import { RealtimeProvider } from "./contexts/RealtimeContext";
import { OutboxProvider } from "./contexts/OutboxContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { isOperatorHost, operatorUrl } from "./config/operatorHost";
import OperatorShell from "./components/routing/OperatorShell";
import { CallProvider } from "./contexts/CallContext";
import StaticPage from "./pages/StaticPage";

const CatchUpDigestPage = lazy(() => import("./pages/CatchUpDigestPage"));
const Chats = lazy(() => import("./pages/Chats"));
const Decisions = lazy(() => import("./pages/Decisions"));
const DiscoverRooms = lazy(() => import("./pages/DiscoverRooms"));
const DecisionDetail = lazy(() => import("./pages/DecisionDetail"));
const Login = lazy(() => import("./pages/Login"));
const NewChat = lazy(() => import("./pages/NewChat"));
const Notifications = lazy(() => import("./pages/Notifications"));
const MemberProfile = lazy(() => import("./pages/MemberProfile"));
const Profile = lazy(() => import("./pages/Profile"));
const Register = lazy(() => import("./pages/Register"));
const AccountRecovery = lazy(() => import("./pages/AccountRecovery"));
const RegistrationVerification = lazy(() => import("./pages/RegistrationVerification"));
const Room = lazy(() => import("./pages/ConversationRoute"));
const RoomInfo = lazy(() => import("./pages/RoomInfo"));
const RoomEvents = lazy(() => import("./pages/RoomEvents"));
const Settings = lazy(() => import("./pages/Settings"));
const MessageActivity = lazy(() => import("./pages/MessageActivity"));
const Tasks = lazy(() => import("./pages/Tasks"));
const ProjectsIndex = lazy(() =>
  import("./pages/WorkProjects").then((m) => ({ default: m.ProjectsIndex })),
);
const ProjectDetail = lazy(() =>
  import("./pages/WorkProjects").then((m) => ({ default: m.ProjectDetail })),
);
const WorkInbox = lazy(() => import("./pages/WorkInbox"));
const WorkSearch = lazy(() => import("./pages/WorkSearch"));
const RoomBrief = lazy(() => import("./pages/RoomBrief"));
const TeamHome = lazy(() => import("./pages/TeamHome"));
const JoinTeam = lazy(() => import("./pages/JoinTeam"));
const ModerationInbox = lazy(() => import("./pages/ModerationInbox"));
const ModerationAppeals = lazy(() => import("./pages/ModerationAppeals"));
const AppealRequest = lazy(() => import("./pages/AppealRequest"));
const CallHistory = lazy(() => import("./pages/CallHistory"));
const PlatformOperators = lazy(() => import("./pages/PlatformOperators"));

// Keep public-page illustrations and content outside the signed-in app bundle.
const Landing = lazy(() => import("./pages/Landing"));

// A conversation has room-scoped drafts, history, scroll and read state. Give
// each room its own component lifetime when switching directly between chats.
function RoomRoute() {
  const { roomId } = useParams();
  return <Room key={roomId} />;
}

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

function OperatorHome() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Spinner fullPage label="Loading" />;
  return <Navigate to={isAuthenticated ? "/moderation/reports" : "/login"} replace />;
}

function PublicModerationRedirect() {
  const location = window.location;
  useEffect(() => {
    window.location.replace(operatorUrl(`${location.pathname}${location.search}${location.hash}`));
  }, [location.hash, location.pathname, location.search]);
  return <Spinner fullPage label="Opening operator console" />;
}

function RuntimeProviders({ children }) {
  if (isOperatorHost) return children;
  return (
    <RealtimeProvider>
      <CallProvider>
        <SyncProvider>
          <PushProvider>
            <OutboxProvider>{children}</OutboxProvider>
          </PushProvider>
        </SyncProvider>
      </CallProvider>
    </RealtimeProvider>
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
          <RuntimeProviders>
                  <Suspense fallback={<Spinner fullPage label="Loading" />}>
                    <Routes>
                      {isOperatorHost ? <>
                        <Route path="/" element={<OperatorHome />} />
                        <Route path="/login" element={<Login />} />
                        <Route path="/account/:kind" element={<AccountRecovery />} />
                        <Route element={<ProtectedRoute />}>
                          <Route element={<OperatorShell />}>
                            <Route path="/moderation/reports" element={<ModerationInbox />} />
                            <Route path="/moderation/appeals" element={<ModerationAppeals />} />
                            <Route path="/moderation/operators" element={<PlatformOperators />} />
                          </Route>
                        </Route>
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </> : <>
                      <Route path="/" element={<LandingRoute />} />
                      <Route path="/moderation" element={<PublicModerationRedirect />} />
                      <Route path="/moderation/*" element={<PublicModerationRedirect />} />
                      <Route path="/appeal" element={<AppealRequest />} />
                      <Route
                        path="/account/:kind"
                        element={<AccountRecovery />}
                      />

                      <Route element={<PublicOnlyRoute />}>
                        <Route path="/login" element={<Login />} />
                        <Route path="/register" element={<Register />} />
                      </Route>

                      {/* Placeholders behind the landing footer. They render an honest
                  empty state rather than invented pricing or legal copy. */}
                      <Route
                        path="/pricing"
                        element={<StaticPage title="Pricing" />}
                      />
                      <Route
                        path="/privacy"
                        element={<StaticPage title="Privacy" />}
                      />
                      <Route
                        path="/terms"
                        element={<StaticPage title="Terms" />}
                      />

                      <Route element={<ProtectedRoute />}>
                        <Route path="/verify-email" element={<RegistrationVerification />} />
                      </Route>

                      <Route element={<ProtectedRoute />}>
                        <Route element={<AppShell />}>
                          {/* Target of the post-auth redirect. Two panes: the list,
                      and the open conversation — both keyed off this URL so a
                      filtered or deep-linked view survives a reload. */}
                          <Route path="/chats" element={<Chats />}>
                          <Route path=":roomId" element={<RoomRoute />} />
                            <Route path=":roomId/events" element={<RoomEvents />} />
                            <Route path=":roomId/info" element={<RoomInfo />} />
                          </Route>

                          {/* The sidebar has always linked to /dms. Rather than
                      maintain a second list component, it resolves into the
                      same one with the DMs chip selected — one implementation,
                      and the chip and the route cannot disagree. */}
                          <Route
                            path="/dms"
                            element={
                              <Navigate to="/chats?filter=dms" replace />
                            }
                          />

                          {/* Stub behind the sidebar's "Invite members" and the mobile
                      compose button. */}
                          <Route
                            path="/activity"
                            element={<MessageActivity />}
                          />
                          <Route path="/calls" element={<CallHistory />} />
                          <Route path="/new" element={<NewChat />} />
                          <Route path="/discover" element={<DiscoverRooms />} />
                          <Route path="/teams" element={<TeamHome />} />
                          <Route path="/teams/:teamId" element={<TeamHome />} />

                          <Route path="/profile" element={<Profile />} />
                          <Route
                            path="/profile/:userId"
                            element={<MemberProfile />}
                          />
                          <Route path="/settings" element={<Settings />} />
                          <Route
                            path="/notifications"
                            element={<Notifications />}
                          />
                          <Route path="/decisions" element={<Decisions />} />
                          {/* Registered as a sibling, not a child of /decisions: the
                      board is a list page and the detail page is a different
                      layout, not a nested view of it. */}
                          <Route
                            path="/decisions/:decisionId"
                            element={<DecisionDetail />}
                          />
                          <Route
                            path="/digest"
                            element={<CatchUpDigestPage />}
                          />
                          <Route path="/tasks" element={<Tasks />} />
                          <Route path="/work" element={<ProjectsIndex />} />
                          <Route
                            path="/work/projects/:projectId"
                            element={<ProjectDetail />}
                          />
                          <Route path="/work/inbox" element={<WorkInbox />} />
                          <Route path="/work/search" element={<WorkSearch />} />
                          <Route
                            path="/work/rooms/:roomId/brief"
                            element={<RoomBrief />}
                          />
                        </Route>
                      </Route>

                      <Route path="/join" element={<JoinRoom />} />
                      <Route path="/join-team" element={<JoinTeam />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                      </>}
                    </Routes>
                  </Suspense>
          </RuntimeProviders>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
