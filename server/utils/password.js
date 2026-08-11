import bcrypt from 'bcryptjs';

/**
 * Password hashing.
 *
 * COST 12. Each increment doubles the work. 12 costs roughly a quarter-second
 * here, which is imperceptible on a login and expensive at scale for someone
 * brute-forcing a stolen database dump. That asymmetry is the entire point of
 * a password hash: it is *deliberately* slow.
 *
 * ALWAYS THE ASYNC API. bcryptjs is pure JavaScript, so `hashSync` runs the
 * whole computation on the event loop — a quarter-second during which the
 * process cannot serve any other request, answer a health check, or accept a
 * connection. Ten concurrent logins would serialise into a 2.5-second stall
 * for every user on the server. The async form yields between rounds.
 *
 * (Native `bcrypt` moves the work to the libuv threadpool and is faster, but
 * needs a compiler toolchain to install. `bcryptjs` trades speed for
 * portability, which is the right call for a project meant to be cloned and
 * run.)
 */
const COST = 12;

export function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, COST);
}

/**
 * Compares a plaintext password against a stored hash.
 *
 * bcrypt.compare is constant-time with respect to the hash contents, so it
 * does not leak information through timing. It returns false — rather than
 * throwing — when the stored value is not a valid bcrypt digest, which is why
 * the phase 7 seed placeholder can never be logged into.
 */
export function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}
