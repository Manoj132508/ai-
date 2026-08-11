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
});
