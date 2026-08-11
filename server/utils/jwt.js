import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

/**
 * Session tokens.
 *
 * The payload carries the user id and nothing else. Every additional claim is
 * a copy of data that can go stale: a token minted before an email change
 * would carry the old address for its entire lifetime, and no server-side
 * edit can reach it. The id is the one fact that never changes, so anything
 * else is loaded fresh from the database.
 *
 * Note what a JWT does *not* give us: revocation. A stolen token is valid
 * until it expires, because verification is a signature check with no
 * database lookup. That is the trade — statelessness for revocability — and
 * it is why the lifetime is short and the cookie is httpOnly. A system
 * needing instant logout-everywhere would need a server-side session store or
 * a token denylist.
 */
export function signSessionToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    issuer: 'aika',
  });
}

/**
 * Verifies and decodes a token.
 *
 * Returns null on *any* failure — bad signature, expired, malformed, wrong
 * issuer. The caller must not distinguish between them when responding: an
 * error saying "token expired" versus "signature invalid" tells an attacker
 * which half of their forgery attempt was wrong.
 *
 * `issuer` is verified as well as the signature. Without it, a token signed
 * with the same secret by another service would be accepted here.
 */
export function verifySessionToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { issuer: 'aika' });
  } catch {
    return null;
  }
}
