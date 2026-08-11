import multer from 'multer';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  buildStoredName,
  readFileHead,
  deleteStoredFile,
  resolveStoredPath,
} from '../services/fileStorage.js';

/**
 * Upload handling, in two stages.
 *
 * Stage 1 (multer) enforces the size limit and writes the bytes to disk under
 * a generated name. Stage 2 reads the file back and verifies its *content*.
 *
 * WHY TWO STAGES. multer's `fileFilter` runs before any bytes arrive, so the
 * only things it can inspect are the filename and the `Content-Type` the
 * client sent — both attacker-controlled. Renaming `payload.exe` to
 * `report.pdf` and declaring `application/pdf` passes any extension or
 * mimetype check. The only trustworthy signal is what the bytes actually are,
 * and that requires having them.
 */

const ALLOWED = {
  'application/pdf': { ext: '.pdf', label: 'PDF' },
  'text/plain': { ext: '.txt', label: 'plain text' },
  'text/markdown': { ext: '.md', label: 'Markdown' },
};

/*
 * File signatures ("magic numbers"). A PDF always begins %PDF-.
 *
 * Plain text and Markdown have NO signature — any byte sequence is a valid
 * text file — so they get a content heuristic instead (see below). Pretending
 * otherwise would be security theatre.
 */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, resolveStoredPath('.')),
  filename: (_req, file, cb) => cb(null, buildStoredName(file.originalname)),
});

export const receiveUpload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    // Bounds the non-file parts too. Without it a request can carry unlimited
    // form fields and exhaust memory long before the file limit applies.
    fields: 10,
    parts: 12,
  },
  fileFilter(_req, file, cb) {
    // A cheap first pass only. It rejects the obviously wrong before we spend
    // disk on them; it is NOT the security control. That is verifyFileContent.
    const ext = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    const extAllowed = Object.values(ALLOWED).some((entry) => entry.ext === ext);
    if (!extAllowed) {
      return cb(new ApiError('FILE_TYPE_UNSUPPORTED'));
    }
    return cb(null, true);
  },
}).single('file');

/**
 * Is this buffer plausibly UTF-8 text?
 *
 * Text has no magic number, so this asks a different question: does the
 * content look like text at all? A NUL byte is the strongest signal that it
 * does not — no legitimate UTF-8 text document contains one, while nearly
 * every binary format does within its first few bytes.
 *
 * This is a heuristic and is treated as one. The real protection against a
 * malicious "text" file is that we never execute it and never serve it back
 * inline: downloads get Content-Disposition: attachment and
 * X-Content-Type-Options: nosniff, so a browser cannot be tricked into
 * running it (phase 11).
 */
function looksLikeText(head) {
  if (head.includes(0x00)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
  return !decoded.includes('�'); // replacement char => invalid UTF-8
}

/**
 * Stage 2: verify the bytes on disk match a type we accept.
 *
 * On rejection the file is deleted before the error propagates. Without that,
 * every rejected upload leaves a file behind and the directory becomes an
 * unbounded store of exactly the content we refused.
 */
export const verifyFileContent = asyncHandler(async (req, _res, next) => {
  if (!req.file) throw new ApiError('VALIDATION_ERROR', 'No file was uploaded.');

  const storedName = req.file.filename;
  const head = await readFileHead(storedName, 16);

  const isPdf = head.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
  const isText = looksLikeText(head);

  let detectedMime = null;
  if (isPdf) detectedMime = 'application/pdf';
  else if (isText) {
    detectedMime = req.file.originalname.toLowerCase().endsWith('.md')
      ? 'text/markdown'
      : 'text/plain';
  }

  if (!detectedMime) {
    await deleteStoredFile(storedName, { requestId: req.id });
    throw new ApiError(
      'FILE_TYPE_UNSUPPORTED',
      'That file is not a readable PDF or text document, whatever its name suggests.',
    );
  }

  // A .pdf extension over non-PDF bytes, or vice versa. Worth logging: it is
  // either a corrupted file or someone probing the validator.
  const claimedExt = req.file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (ALLOWED[detectedMime].ext !== claimedExt && detectedMime === 'application/pdf') {
    req.log.warn('upload extension does not match content', {
      claimedExt,
      detectedMime,
    });
  }

  // Downstream uses the DETECTED type. req.file.mimetype came from the client
  // and is never trusted again after this point.
  req.file.detectedMimeType = detectedMime;
  next();
});
