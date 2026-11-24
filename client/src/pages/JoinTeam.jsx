import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthLayout from "@/components/layout/AuthLayout";
import Button from "@/components/ui/Button";
import { useAuth } from "@/contexts/AuthContext";
import { requestVerification } from "@/services/security.service";
import { acceptInvite, previewInvite } from "@/services/teams.service";

// Keep the capability out of persistent storage. It survives navigation within
// this tab so a member can verify, sign in, or register and then return.
let pendingInvitation = "";
window.addEventListener("conclave:session-ended", () => {
  pendingInvitation = "";
});

export default function JoinTeam() {
  const { user, isAuthenticated, isLoading, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("token") ||
      pendingInvitation,
  );
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sessionStorage.removeItem("conclave:pending-team-invitation");
    if (token) {
      pendingInvitation = token;
      if (location.hash) history.replaceState(null, "", location.pathname);
    }
  }, [token]);

  useEffect(() => {
    const clear = () => {
      pendingInvitation = "";
      setToken("");
      setPreview(null);
    };
    window.addEventListener("conclave:session-ended", clear);
    return () => window.removeEventListener("conclave:session-ended", clear);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || isLoading || !token) return;
    let live = true;
    previewInvite(token)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((requestError) => {
        if (live)
          setError(
            requestError.response?.data?.message || "Invitation unavailable",
          );
      });
    return () => {
      live = false;
    };
  }, [isAuthenticated, isLoading, token]);

  useEffect(() => {
    if (!isAuthenticated || !preview?.email_bound) return;
    const refresh = () => refreshUser().catch(() => {});
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [isAuthenticated, preview?.email_bound, refreshUser]);

  const verificationRequired =
    Boolean(preview?.email_bound) && !user?.email_verified_at;

  async function resendVerification() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestVerification();
      setNotice(result.message);
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ||
          "Could not send the verification email.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true);
    setError("");
    try {
      const result = await acceptInvite(token);
      pendingInvitation = "";
      navigate(`/teams/${result.teamId}`, { replace: true });
    } catch (requestError) {
      setError(
        requestError.response?.data?.message || "Could not accept invitation",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Join a team" description="Get started together in Conclave">
      {!token ? (
        <p role="alert">This invitation link is incomplete.</p>
      ) : isLoading ? (
        <p role="status">Restoring your account…</p>
      ) : !isAuthenticated ? (
        <div className="space-y-3">
          <p>Sign in or register, then return here to accept the invitation.</p>
          <Link className="block text-brand underline" to="/login">
            Sign in
          </Link>
          <Link className="block text-brand underline" to="/register">
            Create account
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {preview && (
            <p className="text-body">
              {preview.inviter} invited you to <strong>{preview.name}</strong>.
              Joining adds you to its general room; other rooms require separate
              access.
            </p>
          )}
          {verificationRequired && (
            <section className="rounded-xl border border-line bg-surface-subtle p-4">
              <h2 className="font-semibold text-ink">Verify your email first</h2>
              <p className="mt-1 text-body text-muted">
                This invitation is tied to a verified email address. Open the
                verification link we send, then return to this tab.
              </p>
              <Button
                className="mt-3"
                variant="secondary"
                disabled={busy}
                onClick={resendVerification}
              >
                {busy ? "Sending…" : "Send verification email"}
              </Button>
            </section>
          )}
          <Button
            disabled={!preview || busy || verificationRequired}
            onClick={accept}
          >
            {busy ? "Joining…" : "Accept invitation"}
          </Button>
          {notice && (
            <p role="status" className="text-body text-ink">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
