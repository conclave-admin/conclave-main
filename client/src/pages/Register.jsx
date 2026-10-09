import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from '@/components/layout/AuthLayout';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Create an account.
 *
 * Navigates to `/chats` rather than `/` because `/` is the public landing
 * page as of this phase; an authenticated user has nowhere else to go, and
 * landing back on the marketing page after signing up reads as a failure.
 */
export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await register(form);
      navigate('/chats', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create your account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      description="Join your private Conclave workspace"
      alternateText="Already have an account?"
      alternateLink="/login"
      alternateLabel="Sign in"
    >
      <form onSubmit={submit} className="space-y-5">
        <Input
          id="displayName"
          label="Display name"
          autoComplete="name"
          required
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />
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
          minLength={8}
          autoComplete="new-password"
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
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
