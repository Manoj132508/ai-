import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/primitives/Button.jsx';
import Input from '../components/primitives/Input.jsx';

export default function RegisterPage() {
  const { status, register } = useAuth();
  const location = useLocation();

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Same single-redirect pattern as LoginPage -- see the comment there for why
  // an imperative navigate() alongside this guard loses a race.
  const destination = location.state?.from?.pathname ?? '/';
  if (status === 'authenticated') return <Navigate to={destination} replace />;

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      // The guard above handles the redirect once `status` flips.
      await register(form);
    } catch (err) {
      setFieldErrors(err.details?.fields ?? {});
      // EMAIL_TAKEN is about the email field specifically, so it belongs
      // beside that input rather than in a banner the user has to connect to
      // the right box themselves.
      if (err.code === 'EMAIL_TAKEN') {
        setFieldErrors({ email: err.message });
      } else {
        setFormError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-4)' }}>
        Create an account
      </h2>

      {formError && (
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
        label="Name"
        name="name"
        autoComplete="name"
        value={form.name}
        onChange={update('name')}
        error={fieldErrors.name}
        required
      />

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
        autoComplete="new-password"
        hint="At least 8 characters."
        value={form.password}
        onChange={update('password')}
        error={fieldErrors.password}
        required
      />

      <Button type="submit" fullWidth loading={submitting}>
        Create account
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
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </form>
  );
}
