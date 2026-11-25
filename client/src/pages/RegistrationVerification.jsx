import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Page from "@/components/layout/Page";
import Button from "@/components/ui/Button";
import { useAuth } from "@/contexts/AuthContext";
import { requestVerification } from "@/services/security.service";

function nextPath() {
  if (sessionStorage.getItem("conclave:pending-team-invitation")) return "/join-team";
  if (sessionStorage.getItem("conclave:pending-invitation")) return "/join";
  return "/chats";
}

export default function RegistrationVerification() {
  const { user, refreshUser } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(() =>
    location.state?.verificationEmailQueued === false
      ? "We couldn't send the verification email automatically. You can request another one below."
      : `We sent a verification link to ${user?.email || "your email address"}. The link expires after 30 minutes.`,
  );
  const [error, setError] = useState("");
  const verified = Boolean(user?.email_verified_at);

  useEffect(() => {
    const refresh = () => refreshUser().catch(() => {});
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshUser]);

  async function resend() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestVerification();
      setNotice(result.message || "If your account needs verification, a link will arrive shortly.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not send the verification email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    setChecking(true);
    setError("");
    try {
      const current = await refreshUser();
      setNotice(current?.email_verified_at ? "Your email is verified." : "We haven't received your verification yet. Open the link in your email, then check again.");
    } catch {
      setError("Could not check verification status. Try again when you're connected.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Page width="form" className="py-8 sm:py-12">
      <section className="rounded-3xl border border-line bg-surface p-6 shadow-sm sm:p-9" aria-labelledby="registration-verification-title">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-soft text-brand" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h12a2.25 2.25 0 0 1 2.25 2.25v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 6 7.5 6 7.5-6" />
          </svg>
        </div>
        <p className="mt-5 text-center text-metadata font-semibold uppercase tracking-[0.14em] text-brand">Account verification</p>
        <h1 id="registration-verification-title" className="mt-2 text-center text-h1 text-ink">
          {verified ? "Your email is verified" : "Check your email"}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-center text-body leading-6 text-muted">
          {verified
            ? `You're all set${user?.email ? `, ${user.email} is verified` : ""}. Continue to your Conclave conversations.`
            : <>We sent a verification link to <strong className="break-all font-semibold text-ink">{user?.email}</strong>. Verify your address to finish setting up your account.</>}
        </p>

        {notice && <p role="status" className="mt-5 rounded-xl bg-canvas px-4 py-3 text-center text-body text-muted">{notice}</p>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-error/10 px-4 py-3 text-body text-error">{error}</p>}

        {!verified && (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button type="button" className="flex-1" onClick={checkStatus} disabled={checking || busy}>
              {checking ? "Checking…" : "I've verified my email"}
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={resend} disabled={busy || checking}>
              {busy ? "Sending…" : "Resend verification email"}
            </Button>
          </div>
        )}

        {!verified && (
          <p className="mt-5 text-center text-metadata text-muted">
            You can keep using Conclave while you wait. Email verification is needed to accept an email-bound team invitation.
          </p>
        )}
        <Link to={nextPath()} className="mt-6 flex min-h-11 items-center justify-center rounded-xl border border-line px-4 text-label font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
          {verified ? "Continue" : "Continue to Conclave"}
        </Link>
        <Link to="/settings" className="mt-4 block text-center text-metadata text-muted underline underline-offset-4 hover:text-ink">
          Manage account settings
        </Link>
      </section>
    </Page>
  );
}
