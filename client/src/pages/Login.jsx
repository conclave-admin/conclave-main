import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthLayout from '@/components/layout/AuthLayout';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';

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
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(form);
      navigate(location.state?.from?.pathname || '/chats', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      description="Sign in to your private workspace"
      alternateText="Anyone can join Conclave. Create an account to start collaborating."
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
        <Input
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />

        {error && (
          <p role="alert" className="rounded-lg bg-error/10 p-3 text-body text-error">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>

        <Link
          className="inline-block text-label text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          to="/register"
        >
          Need an account?
        </Link>
      </form>
    </AuthLayout>
  );
}
