import { useRef, useState } from 'react';
import styles from './FileDropzone.module.css';

const ACCEPT = '.pdf,.txt,.md';
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Drag-and-drop plus click-to-browse file input.
 *
 * ACCESSIBILITY: drag-and-drop is unusable without a pointer, so the visible
 * surface is a <button> that opens the native file picker. The real <input
 * type="file"> is visually hidden but still in the DOM — never
 * `display: none`, which would remove it from the accessibility tree and
 * break the picker for assistive technology.
 *
 * The size and type checks here are a courtesy: they give instant feedback
 * instead of making the user wait for an upload that will be refused. They
 * are NOT security. The server re-checks the size and, unlike the browser,
 * inspects the actual bytes.
 */
export default function FileDropzone({ onFile, disabled }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState(null);

  function handleFiles(fileList) {
    setLocalError(null);
    const file = fileList?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (!ACCEPT.split(',').includes(ext)) {
      setLocalError('Only PDF, TXT and Markdown files can be uploaded.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError('That file is larger than the 10 MB limit.');
      return;
    }

    onFile(file);
  }

  return (
    <div>
      <button
        type="button"
        className={`${styles.zone} ${dragging ? styles.dragging : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault(); // without this the browser opens the file itself
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        disabled={disabled}
      >
        <span className={styles.icon} aria-hidden="true">
          ⬆
        </span>
        <span className={styles.primary}>
          {dragging ? 'Drop to upload' : 'Drop a file here, or click to browse'}
        </span>
        <span className={styles.secondary}>PDF, TXT or Markdown · up to 10 MB</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className={styles.hiddenInput}
        onChange={(e) => {
          handleFiles(e.target.files);
          // Reset, or selecting the SAME file twice in a row fires no change
          // event the second time and the upload silently does nothing.
          e.target.value = '';
        }}
        // The visible button is the labelled control; this duplicate would
        // otherwise be announced as a second, unlabelled one.
        tabIndex={-1}
        aria-hidden="true"
      />

      {localError && (
        <p role="alert" className={styles.error}>
          {localError}
        </p>
      )}
    </div>
  );
}
