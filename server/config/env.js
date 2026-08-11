/**
 * Environment configuration -- read once, validated once, frozen.
 *
 * Why a module instead of `process.env` at each call site:
 *
 *  - A typo in `process.env.PROT` is `undefined` and fails silently at 3am.
 *    Here it fails at startup, in one place.
 *  - Types are coerced once (PORT is a Number, CORS_ORIGINS is an Array)
 *    rather than every consumer re-parsing a string.
 *  - Tests can read the same object instead of mutating global state.
 *
 * Loaded via `node --env-file=.env` (built into Node 20+), so there is no
 * dotenv dependency.
 */

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const isProduction = NODE_ENV === 'production';

function requiredInProduction(name, devFallback) {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) {
    // Fail fast and loudly. A production server that boots with a missing
    // secret is worse than one that refuses to boot: it runs, appears
    // healthy, and fails on the first real request.
    throw new Error(
      `Missing required environment variable ${name} in production. ` +
        `See server/.env.example.`,
    );
  }
  return devFallback;
}

/**
 * Required in EVERY environment, with no fallback.
 *
 * A development default for a signing secret is how a placeholder reaches
 * production: it works locally, nobody notices it is unset on the server, and
 * the deploy succeeds with a secret that is public in the repository. Anyone
 * who has read the source can then mint valid sessions for any account.
 *
 * Refusing to boot without it is the only version of this that cannot be
 * forgotten.
 */
function required(name, hint) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return value;
}

function parseDurationMs(value) {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`JWT_EXPIRES_IN must look like "15m", "7d"; got "${value}"`);
  const units = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };
  return Number(match[1]) * units[match[2]];
}

const port = Number(process.env.PORT ?? 4200);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PORT must be a valid port number, received "${process.env.PORT}"`);
}

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProduction,
  isDevelopment: NODE_ENV === 'development',
  isTest: NODE_ENV === 'test',
  port,

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5177')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  aiServiceUrl: process.env.AI_SERVICE_URL ?? 'http://127.0.0.1:8000',
  internalApiKey: requiredInProduction('INTERNAL_API_KEY', 'dev-internal-key-change-me'),

  // No production default: an Atlas URI carries credentials, so a fallback
  // would either be a placeholder that fails confusingly or a real secret in
  // source. Required in production, loopback in development.
  mongodbUri: requiredInProduction(
    'MONGODB_URI',
    'mongodb://127.0.0.1:27017/ai_knowledge_assistant',
  ),

  jwtSecret: required(
    'JWT_SECRET',
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  ),

  // Short by design. A JWT cannot be revoked — verification is a signature
  // check with no database lookup — so the expiry is the only bound on how
  // long a stolen token stays useful.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  jwtExpiresMs: parseDurationMs(process.env.JWT_EXPIRES_IN ?? '2h'),

  // Local disk in development; phase 14 swaps this for S3. Relative paths are
  // resolved against the server directory, not the shell's cwd, so `npm run
  // dev` from anywhere behaves the same.
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
});
