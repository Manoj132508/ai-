import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

/**
 * Accessible modal dialog.
 *
 * Four things a div with `position: fixed` does not give you, and which are
 * the whole reason this is a component rather than inline markup:
 *
 * 1. FOCUS MOVES IN on open, and RETURNS to the trigger on close. Without the
 *    return, closing a dialog dumps keyboard focus back at the top of the
 *    document and the user has to tab all the way to where they were.
 * 2. FOCUS IS TRAPPED. Tab from the last control wraps to the first instead of
 *    escaping to the page behind, which a screen-reader user cannot see.
 * 3. ESCAPE CLOSES IT.
 * 4. `aria-modal` + `role="dialog"` tell assistive technology the rest of the
 *    page is inert.
 *
 * Rendered through a portal so a parent's `overflow: hidden` or stacking
 * context cannot clip it — the classic "my modal is behind the header" bug.
 */
export default function Modal({ open, onClose, title, children, footer }) {
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;

    // Focus the first control, or the dialog itself if it has none.
    const focusables = dialogRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusables?.[0] ?? dialogRef.current)?.focus();

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!items?.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      // The wrap. Without it, Tab walks out of the dialog into the page behind.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    // The page behind must not scroll while a dialog is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        // Stops a click inside from reaching the backdrop's close handler.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="modal-title" className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
