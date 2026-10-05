import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthLayout from '../components/layout/AuthLayout';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { login } = useAuth(); const navigate = useNavigate(); const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' }); const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false);
  async function submit(event) { event.preventDefault(); setSubmitting(true); setError(''); try { await login(form); navigate(location.state?.from?.pathname || '/', { replace: true }); } catch (err) { setError(err.response?.data?.message || 'Could not sign in.'); } finally { setSubmitting(false); } }
  return <AuthLayout title="Welcome back" description="Sign in to your private workspace" alternateText="Anyone can join Conclave. Create an account to start collaborating."><form onSubmit={submit} className="space-y-5"><Input id="email" label="Email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /><Input id="password" label="Password" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />{error && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>}<Button type="submit" className="w-full" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</Button><Link className="inline-block text-sm font-semibold text-brand hover:underline" to="/register">Need an account?</Link></form></AuthLayout>;
}
