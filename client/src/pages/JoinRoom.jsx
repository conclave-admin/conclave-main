import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  acceptInvitation,
  invitationStatus,
} from "../services/roomLifecycle.service";
import Button from "../components/ui/Button";
import AuthLayout from "../components/layout/AuthLayout";
const pendingKey = "conclave:pending-invitation";
export default function JoinRoom() {
  const { user, isAuthenticated, isLoading } = useAuth(),
    navigate = useNavigate();
  const [token] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("token") ||
      sessionStorage.getItem(pendingKey) ||
      "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const valid = /^[-\w]{43}$/.test(token);
  useEffect(() => {
    if (!valid || !isAuthenticated || isLoading) return;
    let active = true;
    setBusy(true);
    setError("");
    invitationStatus(token)
      .then((result) => {
        if (!active) return;
        if (result.status === "joined") {
          sessionStorage.removeItem(pendingKey);
          navigate(`/chats/${result.roomId}`);
        } else setStatus(result.status);
      })
      .catch((e) => {
        if (active) {
          if (e.response?.status === 404) sessionStorage.removeItem(pendingKey);
          setError(e.response?.data?.message || e.message);
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [valid, token, isAuthenticated, isLoading, user?.id, navigate]);

  useEffect(() => {
    if (valid) sessionStorage.setItem(pendingKey, token);
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, [token, valid]);
  return (
    <AuthLayout>
      <div className="space-y-4">
        <h1 className="text-h1 text-ink">Join a Conclave room</h1>
        <p className="text-body text-muted">
          The invitation is checked when you choose to join. Private room
          details and messages stay hidden until membership is granted.
        </p>
        {!valid ? (
          <p role="alert" className="text-error">
            This invitation is invalid. Ask an admin for a new link.
          </p>
        ) : isLoading ? (
          <p role="status">Restoring your account…</p>
        ) : !isAuthenticated ? (
          <>
            <p className="text-body text-ink">
              Sign in, then return here to accept this invitation.
            </p>
            <Link
              className="inline-flex min-h-11 items-center text-brand"
              to="/login"
            >
              Sign in to continue
            </Link>
          </>
        ) : (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result =
                  status === "pending"
                    ? await invitationStatus(token)
                    : await acceptInvitation(token);
                if (result.status === "joined") {
                  sessionStorage.removeItem(pendingKey);
                  navigate(`/chats/${result.roomId}`);
                } else setStatus(result.status);
              } catch (e) {
                setError(e.response?.data?.message || e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "Checking invitation…"
              : status === "pending"
                ? "Check request status"
                : status === "rejected"
                  ? "Submit another join request"
                  : "Accept invitation"}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="text-body text-ink">
            {status === "pending"
              ? "Your join request is pending admin approval."
              : status === "rejected"
                ? "Your request was declined. You may submit a new request."
                : "Invitation is ready to accept."}
          </p>
        )}
        <Link className="block text-label text-brand" to="/chats">
          Back to conversations
        </Link>
      </div>
    </AuthLayout>
  );
}
