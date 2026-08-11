import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/primitives/Button.jsx';
import Input from '../components/primitives/Input.jsx';

export default function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Where RequireAuth intercepted, if it did. Falls back to the dashboard for
  // someone who came to /login directly.
  const destination = location.state?.from?.pathname ?? '/';

  /*
   * ONE redirect, not two.
   *
   * The first version also called navigate(destination) after a successful
   * login, and the two raced: setting status to 'authenticated' re-renders
   * this component, this guard fires, and it beat the imperative navigate --
   * so every deep link landed on the dashboard instead. React Router's
   * v7_startTransition flag makes it worse by deprioritising navigate().
   *
   * Deriving the destination here and letting the guard do the work means
   * there is only one answer to "where do we go when authenticated", so
   * nothing can win a race against it.
   */
  if (status === 'authenticated') return <Navigate to={destination} replace />;

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  async function handleSubmit(event) {
    event.preventDefault(); // stop the browser's native form navigation
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      // No navigate() here on purpose -- setting the session flips `status`,
      // and the guard above performs the redirect.
      await login({ email: form.email, password: form.password });
    } catch (err) {
      setFieldErrors(err.details?.fields ?? {});
      setFormError(err.message);
      // Note what is NOT cleared: the email stays. Wiping the form on a failed
      // login means retyping everything to fix one typo.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-4)' }}>
        Sign in
      </h2>

      {formError && (
        // role="alert" so the failure is announced immediately rather than
        // being silently painted for sighted users only.
        <div
          role="alert"
          style={{
            marginBottom: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--status-failed)',
            borderRadius: 'var(--radius)',
            color: 'var(--status-failed)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          {formError}
        </div>
      )}

      <Input
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        value={form.email}
        onChange={update('email')}
        error={fieldErrors.email}
        required
      />

      <Input
        label="Password"
        type="password"
        name="password"
        // Lets a password manager recognise this as a sign-in, not a new
        // password.
        autoComplete="current-password"
        value={form.password}
        onChange={update('password')}
        error={fieldErrors.password}
        required
      />

      <Button type="submit" fullWidth loading={submitting}>
        Sign in
      </Button>

      <p
        style={{
          marginTop: 'var(--space-4)',
          marginBottom: 0,
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-muted)',
          textAlign: 'center',
        }}
      >
        No account? <Link to="/register">Create one</Link>
      </p>
    </form>
  );
}
