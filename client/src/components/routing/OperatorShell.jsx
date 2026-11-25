import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import Spinner from "@/components/ui/Spinner";
import { useAuth } from "@/contexts/AuthContext";

const navLink = "rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-canvas hover:text-ink";

export default function OperatorShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    let active = true;
    api.get("/moderation/access")
      .then(({ data }) => { if (active) setRole(data.data?.role || data.role); })
      .catch((cause) => { if (active) setError(cause.response?.data?.message || "This account does not have operator access."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAuthenticated, isLoading]);

  if (isLoading || (isAuthenticated && loading)) return <Spinner fullPage label="Loading operator console" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (error || !["moderator", "admin"].includes(role))
    return <main className="grid min-h-dvh place-items-center bg-canvas p-6"><section className="max-w-md rounded-2xl border border-line bg-surface p-7 text-center shadow-card"><h1 className="text-h2 text-ink">Operator access required</h1><p className="mt-3 text-body text-muted">{error || "This account does not have operator access."}</p><a className="mt-5 inline-flex text-label text-brand hover:underline" href="https://conclave.com.ng">Return to Conclave</a></section></main>;

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link to="/moderation/reports" className="text-lg font-semibold tracking-tight">Conclave <span className="text-brand">Operator</span></Link>
          <nav aria-label="Operator navigation" className="flex flex-wrap items-center gap-1">
            <Link className={navLink} to="/moderation/reports">Reports</Link>
            <Link className={navLink} to="/moderation/appeals">Appeals</Link>
            {role === "admin" && <Link className={navLink} to="/moderation/operators">Operators</Link>}
            <a className={navLink} href="https://conclave.com.ng">Public app</a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8">
        {location.pathname === "/moderation/operators" && role !== "admin"
          ? <Navigate to="/moderation/reports" replace />
          : <Outlet context={{ setRoomHeader: () => {}, role }} />}
      </main>
    </div>
  );
}
