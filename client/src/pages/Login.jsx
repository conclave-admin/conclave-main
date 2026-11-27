import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthLayout from "@/components/layout/AuthLayout";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PasswordInput from "@/components/ui/PasswordInput";
import { useAuth } from "@/contexts/AuthContext";
import { isOperatorHost } from "@/config/operatorHost";

/**
 * Sign in.
 *
 * The error is a live region rather than bare text: a failed submit moves no
 * focus and changes nothing visibly on some layouts, so without `role="alert"`
 * a screen-reader user can press the button and get silence.
 *
 * `type="button"` is not set on the submit — Button defaults to it, and this
 * one passes "submit" explicitly so the form actually submits.
 */
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await login(form);
      // Always the chat list, never the page you were bounced from. Resuming a
      // deep link sounds considerate until the session expires on /settings or
      // /profile, where signing in then dumping you back on that screen reads
      // as "the app ignored my login" rather than as "we remembered".
      navigate(isOperatorHost ? "/moderation/reports" : sessionStorage.getItem("conclave:pending-team-invitation") ? "/join-team" : sessionStorage.getItem("conclave:pending-invitation") ? "/join" : "/chats", { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || "Could not sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title={isOperatorHost ? "Operator sign in" : "Welcome back"}
      description={isOperatorHost ? "Sign in with your provisioned Conclave operator account" : "Sign in to your private workspace"}
      alternateText={isOperatorHost ? "Operator access is provisioned by an existing platform administrator." : "Anyone can join Conclave. Create an account to start collaborating."}
    >
      <form onSubmit={submit} className="space-y-5" noValidate={false}>
        <Input
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <PasswordInput
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={form.password}
          onChange={(event) =>
            setForm({ ...form, password: event.target.value })
          }
        />

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-error/10 p-3 text-body text-error"
          >
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>

        <Link
          className="block text-label text-brand hover:underline"
          to="/account/recovery"
        >
          Forgot password?
        </Link>
        {isOperatorHost && <a className="block text-label text-brand hover:underline" href="https://conclave.com.ng/register">Create a regular Conclave account</a>}
        {!isOperatorHost && <Link className="block text-label text-brand hover:underline" to="/appeal">Appeal an account action</Link>}
        {!isOperatorHost && <Link
          className="inline-block text-label text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          to="/register"
        >Need an account?</Link>}
      </form>
    </AuthLayout>
  );
}
