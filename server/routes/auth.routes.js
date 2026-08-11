import { Router } from 'express';
import { register, login, me, logout } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCsrfToken } from '../middleware/csrf.js';

const router = Router();

/*
 * register and login are NOT CSRF-protected, and must not be.
 *
 * There is no session to abuse yet, and no CSRF cookie to echo — requiring
 * one would make login impossible on a fresh browser. The attack CSRF
 * prevents is "make the victim's authenticated browser do something"; an
 * unauthenticated POST has nothing to hijack. (Login CSRF — logging a victim
 * into the attacker's account — is a real but much narrower issue, mitigated
 * here by SameSite=Strict.)
 */
router.post('/register', register);
router.post('/login', login);

// Safe method: no CSRF token needed, and requireCsrfToken would skip it anyway.
router.get('/me', requireAuth, me);

// Logout DOES change state, so it is protected. Without this an attacker's
// page could forcibly log users out — a nuisance rather than a breach, but
// still an unintended state change.
router.post('/logout', requireAuth, requireCsrfToken, logout);

export default router;
