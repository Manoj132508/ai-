import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { knowledgeBaseService } from '../services/knowledgeBaseService.js';
import { useAsync } from '../hooks/useAsync.js';
import Button from '../components/primitives/Button.jsx';
import Input from '../components/primitives/Input.jsx';
import Modal from '../components/primitives/Modal.jsx';
import EmptyState from '../components/primitives/EmptyState.jsx';
import ErrorState from '../components/primitives/ErrorState.jsx';
import { Skeleton, SkeletonGroup, LiveStatus } from '../components/primitives/Skeleton.jsx';
import { formatRelativeTime } from '../utils/format.js';
import styles from './DashboardPage.module.css';

function KnowledgeBaseCard({ kb }) {
  return (
    <Link to={`/kb/${kb.id}`} className={styles.card}>
      <h3 className={styles.cardTitle}>{kb.name}</h3>
      {kb.description && <p className={styles.cardDescription}>{kb.description}</p>}
      <dl className={styles.stats}>
        <div>
          <dt>Documents</dt>
          <dd>{kb.documentCount}</dd>
        </div>
        <div>
          <dt>Chunks</dt>
          <dd>{kb.chunkCount || '—'}</dd>
        </div>
      </dl>
      <p className={styles.timestamp}>Updated {formatRelativeTime(kb.updatedAt)}</p>
    </Link>
  );
}

export default function DashboardPage() {
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => knowledgeBaseService.list({ limit: 24 }), []);
  const { data, error, loading, reload } = useAsync(load);

  const items = data?.items ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Your knowledge bases</h1>
        <Button onClick={() => setCreating(true)}>New knowledge base</Button>
      </header>

      {/* Small, separate live region. The content region below is NOT live,
          or the whole list would be read aloud when it arrives. */}
      <LiveStatus>
        {loading
          ? 'Loading knowledge bases'
          : error
            ? 'Failed to load knowledge bases'
            : `${items.length} knowledge bases loaded`}
      </LiveStatus>

      {error ? (
        <ErrorState message={error.message} code={error.code} onRetry={reload} />
      ) : (
        <SkeletonGroup busy={loading}>
          {loading ? (
            <div className={styles.grid}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={styles.card}>
                  <Skeleton variant="text" width="60%" />
                  <Skeleton variant="text" />
                  <Skeleton variant="text" width="35%" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon="📚"
              title="No knowledge bases yet"
              // Every empty state names the next action -- "no knowledge
              // bases" alone is a dead end.
              description="Create one, upload some documents, and start asking questions about them."
              action={<Button onClick={() => setCreating(true)}>Create your first one</Button>}
            />
          ) : (
            <div className={styles.grid}>
              {items.map((kb) => (
                <KnowledgeBaseCard key={kb.id} kb={kb} />
              ))}
            </div>
          )}
        </SkeletonGroup>
      )}

      <CreateKnowledgeBaseModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />
    </div>
  );
}

function CreateKnowledgeBaseModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await knowledgeBaseService.create({
        name: form.name,
        description: form.description,
      });
      setForm({ name: '', description: '' });
      onCreated();
    } catch (err) {
      setFieldErrors(err.details?.fields ?? {});
      if (!err.details?.fields) setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New knowledge base"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="create-kb-form" loading={submitting}>
            Create
          </Button>
        </>
      }
    >
      {/* The submit button lives in the modal footer, outside this form
          element, so it is linked back with form="create-kb-form". */}
      <form id="create-kb-form" onSubmit={handleSubmit} noValidate>
        {formError && (
          <p role="alert" style={{ color: 'var(--status-failed)', marginTop: 0 }}>
            {formError}
          </p>
        )}
        <Input
          label="Name"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          error={fieldErrors.name}
          maxLength={100}
          required
        />
        <Input
          label="Description"
          hint="Optional."
          value={form.description}
          onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
          error={fieldErrors.description}
          maxLength={500}
        />
      </form>
    </Modal>
  );
}
