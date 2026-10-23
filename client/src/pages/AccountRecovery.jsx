import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import AuthLayout from "../components/layout/AuthLayout";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";
import {
  requestRecovery,
  redeemAccountToken,
} from "../services/security.service";
export default function AccountRecovery() {
  const { kind } = useParams();
  const [token] = useState(() => {
    const value =
      new URLSearchParams(location.hash.slice(1)).get("token") || "";
    if (value) history.replaceState(null, "", location.pathname);
    return value;
  });
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (token && kind !== "verify" && password !== confirm)
        throw new Error("Passwords do not match.");
      const result = token
        ? await redeemAccountToken(kind, token, password)
        : await requestRecovery(email);
      setNotice(result.message);
      setDone(true);
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          "Could not complete this request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title={
        kind === "verify"
          ? "Verify your email"
          : token
            ? "Choose a new password"
            : "Recover your account"
      }
      description="Keep access to your Conclave account"
      alternateText=""
    >
      <form onSubmit={submit} className="space-y-4">
        {!done && !token && (
          <Input
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        {!done && token && kind !== "verify" && (
          <>
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <p className="text-metadata text-muted">
              Resetting your password signs out all devices. It does not recover
              encrypted history; keep your separate encryption recovery key.
            </p>
          </>
        )}
        {!done && (
          <Button type="submit" disabled={busy}>
            {busy
              ? "Working…"
              : kind === "verify"
                ? "Verify email"
                : token
                  ? "Reset password"
                  : "Send recovery link"}
          </Button>
        )}
        {notice && (
          <p role="status" className="text-body text-ink">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-body text-error">
            {error}
          </p>
        )}
        <Link to="/login" className="block text-body text-brand">
          Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
