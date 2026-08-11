import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Local disk storage for uploaded documents.
 *
 * Phase 14 swaps this for S3. Everything that touches the filesystem lives
 * here so that swap is one file, and so there is exactly one place where a
 * path is constructed — which is the part that has to be right.
 */

export async function ensureUploadDir() {
  await fs.mkdir(config.uploadDir, { recursive: true });
}

/**
 * Builds the on-disk name for an upload.
 *
 * THE ORIGINAL FILENAME IS NEVER USED IN A PATH. It is attacker-controlled:
 * `../../../.ssh/authorized_keys` is a valid value for a multipart filename
 * field, and joining it to an upload directory writes wherever the attacker
 * likes. A UUID plus a whitelisted extension has no path semantics at all, so
 * traversal is not defended against — it is impossible to express.
 *
 * The original name is still stored in Mongo, for display only.
 */
export function buildStoredName(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  return `${randomUUID()}${safeExt}`;
}

/**
 * Resolves a stored name to an absolute path, refusing anything that escapes
 * the upload directory.
 *
 * Belt and braces: stored names are UUIDs we generated, so this should never
 * trigger. It exists because "should never" stops being true the moment
 * someone adds a code path that takes the name from somewhere else.
 */
export function resolveStoredPath(storedName) {
  const root = path.resolve(config.uploadDir);
  const resolved = path.resolve(root, storedName);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to resolve a path outside the upload directory: ${storedName}`);
  }
  return resolved;
}

export async function readFileHead(storedName, bytes = 16) {
  const handle = await fs.open(resolveStoredPath(storedName), 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Deletes a stored file, tolerating absence.
 *
 * ENOENT is not an error here. Delete is called on the failure path of an
 * upload and on document deletion, and a file that is already gone means the
 * goal is met. Throwing would turn a successful cleanup into a 500 and, worse,
 * would abort a cascading delete partway through.
 */
export async function deleteStoredFile(storedName, { requestId } = {}) {
  try {
    await fs.unlink(resolveStoredPath(storedName));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    // Logged rather than thrown: an orphaned file wastes disk, but failing the
    // user's delete because cleanup stumbled is the worse outcome.
    logger.error('failed to delete stored file', {
      storedName,
      message: err.message,
      requestId,
    });
    return false;
  }
}
