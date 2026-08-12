import { useCallback, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { knowledgeBaseService } from '../services/knowledgeBaseService.js';
import { documentService } from '../services/documentService.js';
import { useAsync } from '../hooks/useAsync.js';
import { usePolling } from '../hooks/usePolling.js';
import Button from '../components/primitives/Button.jsx';
import Input from '../components/primitives/Input.jsx';
import Modal from '../components/primitives/Modal.jsx';
import StatusBadge from '../components/primitives/StatusBadge.jsx';
import EmptyState from '../components/primitives/EmptyState.jsx';
import ErrorState from '../components/primitives/ErrorState.jsx';
import { Skeleton, SkeletonGroup, LiveStatus } from '../components/primitives/Skeleton.jsx';
import FileDropzone from '../components/FileDropzone.jsx';
import ChatView from '../components/ChatView.jsx';
import { formatBytes, formatRelativeTime } from '../utils/format.js';
import styles from './KnowledgeBasePage.module.css';

export default function KnowledgeBasePage({ view }) {
  const { kbId } = useParams();

  const load = useCallback(() => knowledgeBaseService.get(kbId), [kbId]);
  const { data, error, loading, reload } = useAsync(load);
  const kb = data?.knowledgeBase;

  if (loading) {
    return (
      <SkeletonGroup>
        <Skeleton variant="text" width="30%" height="1.6em" />
        <Skeleton variant="text" width="55%" />
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Skeleton variant="rect" height={120} />
        </div>
      </SkeletonGroup>
    );
  }

  if (error) {
    // A 404 here means "does not exist" OR "belongs to someone else" -- the
    // API deliberately does not distinguish, so neither does this copy.
    return (
      <ErrorState
        title={error.code === 'KB_NOT_FOUND' ? 'Knowledge base not found' : undefined}
        message={error.message}
        code={error.code}
        onRetry={error.code === 'KB_NOT_FOUND' ? undefined : reload}
      />
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.heading}>{kb.name}</h1>
        {kb.description && <p className={styles.description}>{kb.description}</p>}
      </header>

      <nav className={styles.tabs} aria-label="Knowledge base sections">
        <NavLink end to={`/kb/${kbId}`} className={({ isActive }) => tabClass(isActive)}>
          Chat
        </NavLink>
        <NavLink to={`/kb/${kbId}/documents`} className={({ isActive }) => tabClass(isActive)}>
          Documents
        </NavLink>
        <NavLink to={`/kb/${kbId}/settings`} className={({ isActive }) => tabClass(isActive)}>
          Settings
        </NavLink>
      </nav>

      {view === 'chat' && <ChatView kb={kb} />}
      {view === 'documents' && <DocumentsView kbId={kbId} onDocumentsChanged={reload} />}
      {view === 'settings' && <SettingsView kb={kb} onUpdated={reload} />}
    </div>
  );

  function tabClass(isActive) {
    return `${styles.tab} ${isActive ? styles.tabActive : ''}`;
  }
}

function DocumentsView({ kbId, onDocumentsChanged }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(() => knowledgeBaseService.listDocuments(kbId, { limit: 50 }), [kbId]);
  const { data, error, loading, reload } = useAsync(load);

  const documents = data?.items ?? [];

  /*
   * Poll only while something is actually in flight, and stop by itself when
   * nothing is. `enabled` is a derived condition rather than a flag someone
   * has to remember to clear -- which is how polling loops end up running
   * forever.
   *
   * (Nothing moves out of 'uploaded' until phase 10 wires up indexing, so in
   * practice this stays off today. The mechanism is here and correct.)
   */
  const isWorkInFlight = documents.some((doc) => doc.status === 'processing');
  usePolling(reload, { intervalMs: 3000, enabled: isWorkInFlight });

  async function handleUpload(file) {
    setUploading(true);
    setUploadError(null);
    try {
      await knowledgeBaseService.uploadDocument(kbId, file);
      await reload();
      onDocumentsChanged(); // refresh the parent's documentCount
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
    }
  }

  async function confirmDelete() {
    const doc = pendingDelete;
    setPendingDelete(null);
    await documentService.remove(doc.id);
    await reload();
    onDocumentsChanged();
  }

  return (
    <div>
      <FileDropzone onFile={handleUpload} disabled={uploading} />

      {uploading && (
        <p className={styles.uploadingNote} role="status">
          Uploading…
        </p>
      )}

      {uploadError && (
        <div className={styles.uploadError} role="alert">
          <strong>{uploadError.message}</strong>
          {uploadError.code && <span className={styles.code}>{uploadError.code}</span>}
        </div>
      )}

      <LiveStatus>
        {loading ? 'Loading documents' : `${documents.length} documents`}
      </LiveStatus>

      <div className={styles.list}>
        {error ? (
          <ErrorState message={error.message} code={error.code} onRetry={reload} />
        ) : (
          <SkeletonGroup busy={loading}>
            {loading ? (
              [0, 1, 2].map((i) => (
                <div key={i} className={styles.row}>
                  <Skeleton variant="text" width="40%" />
                </div>
              ))
            ) : documents.length === 0 ? (
              <EmptyState
                icon="📄"
                title="No documents yet"
                description="Upload a PDF or text file above to get started."
              />
            ) : (
              documents.map((doc) => (
                <div key={doc.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.name}>{doc.originalName}</span>
                    <span className={styles.meta}>
                      {formatBytes(doc.sizeBytes)}
                      {doc.pageCount ? ` · ${doc.pageCount} pages` : ''}
                      {doc.chunkCount ? ` · ${doc.chunkCount} chunks` : ''}
                      {` · ${formatRelativeTime(doc.createdAt)}`}
                    </span>
                    {/* A persistent failure belongs beside the thing that
                        failed, with its recovery action -- not in a toast
                        that vanishes. */}
                    {doc.status === 'failed' && doc.errorMessage && (
                      <span className={styles.rowError}>{doc.errorMessage}</span>
                    )}
                  </div>

                  <StatusBadge status={doc.status} />

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(doc)}
                    aria-label={`Delete ${doc.originalName}`}
                  >
                    Delete
                  </Button>
                </div>
              ))
            )}
          </SkeletonGroup>
        )}
      </div>

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="Delete this document?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          <strong>{pendingDelete?.originalName}</strong> and anything indexed from it will be
          removed. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

function SettingsView({ kb, onUpdated }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: kb.name, description: kb.description ?? '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setSaved(false);
    try {
      await knowledgeBaseService.update(kb.id, form);
      onUpdated();
      setSaved(true);
    } catch (err) {
      setFieldErrors(err.details?.fields ?? { name: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await knowledgeBaseService.remove(kb.id);
      navigate('/', { replace: true });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.settings}>
      <form onSubmit={handleSave} noValidate>
        <Input
          label="Name"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          error={fieldErrors.name}
          maxLength={100}
        />
        <Input
          label="Description"
          value={form.description}
          onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
          error={fieldErrors.description}
          maxLength={500}
        />
        <Button type="submit" loading={saving}>
          Save changes
        </Button>
        <LiveStatus>{saved ? 'Changes saved' : ''}</LiveStatus>
        {saved && (
          <span className={styles.savedNote} aria-hidden="true">
            Saved
          </span>
        )}
      </form>

      <section className={styles.danger}>
        <h2 className={styles.dangerTitle}>Delete this knowledge base</h2>
        <p className={styles.dangerText}>
          Its {kb.documentCount} document(s), conversations and indexed content are removed
          permanently.
        </p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete knowledge base
        </Button>
      </section>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this knowledge base?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              // Typed confirmation, not just a second button. Destructive and
              // irreversible actions should cost more than one reflexive
              // click.
              disabled={confirmText !== kb.name}
              loading={deleting}
              onClick={handleDelete}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          This cannot be undone. Type <strong>{kb.name}</strong> to confirm.
        </p>
        <Input
          label="Knowledge base name"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </Modal>
    </div>
  );
}
