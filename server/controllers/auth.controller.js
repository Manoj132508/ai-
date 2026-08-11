import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok, noContent } from '../utils/respond.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { signSessionToken } from '../utils/jwt.js';
import { setSessionCookie, setCsrfCookie, clearAuthCookies } from '../utils/cookies.js';
import { User } from '../models/index.js';

// Deliberately permissive. Strict email regexes reject valid addresses; the
// only authoritative validation is sending mail to it. This catches typos.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validateCredentials({ email, password, name }, { requireName }) {
  const fields = {};

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    fields.email = 'Enter a valid email address.';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    fields.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (requireName && (typeof name !== 'string' || name.trim().length === 0)) {
    fields.name = 'Name is required.';
  }

  if (Object.keys(fields).length > 0) {
    throw new ApiError('VALIDATION_ERROR', 'Please correct the highlighted fields.', {
      fields,
    });
  }
}

/** Issues both cookies and returns the safe user projection. */
function establishSession(res, user) {
  setSessionCookie(res, signSessionToken(user._id));
  setCsrfCookie(res);
  return { id: user._id, email: user.email, name: user.name };
}

export const register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body ?? {};
  validateCredentials({ email, password, name }, { requireName: true });

  const normalisedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await User.create({ email: normalisedEmail, name: name.trim(), passwordHash });
  } catch (err) {
    /*
     * 11000 is MongoDB's duplicate-key error, raised by the unique index on
     * email. We catch it rather than doing findOne-then-create, because
     * check-then-write is a race: two simultaneous registrations both pass the
     * check before either inserts. The index is the guarantee; this catch just
     * turns it into a decent message.
     */
    if (err?.code === 11000) throw new ApiError('EMAIL_TAKEN');
    throw err;
  }

  req.log.info('user registered', { userId: String(user._id) });
  return ok(res, { user: establishSession(res, user) }, 201);
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  validateCredentials({ email, password }, { requireName: false });

  // passwordHash is select:false, so it must be asked for explicitly.
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select(
    '+passwordHash',
  );

  /*
   * TIMING: if no user exists we must still spend roughly the same time as a
   * real comparison. Returning immediately makes "unknown email" measurably
   * faster than "wrong password", which turns login into an account-existence
   * oracle — the same information leak the identical error message is there to
   * prevent.
   */
  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');

  if (!user || !passwordOk) {
    // ONE message for both cases. "No account with that email" is a free
    // account-enumeration tool.
    req.log.warn('login failed', { email: String(email).slice(0, 64) });
    throw new ApiError('AUTH_INVALID', 'Invalid email or password.');
  }

  req.log.info('user logged in', { userId: String(user._id) });
  return ok(res, { user: establishSession(res, user) });
});

/**
 * The authenticated-refresh endpoint the SPA calls on boot.
 *
 * Deep-linking is why this exists: a page loaded directly at /kb/abc has no
 * in-memory session, so the app must ask the server who it is before deciding
 * what to render — and show a spinner until it answers, never a flash of the
 * login page.
 */
export const me = asyncHandler(async (req, res) => ok(res, { user: req.user }));

export const logout = asyncHandler(async (req, res) => {
  clearAuthCookies(res);
  req.log.info('user logged out', { userId: String(req.user?.id ?? 'anonymous') });
  return noContent(res);
});
