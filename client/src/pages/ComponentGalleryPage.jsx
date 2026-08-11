import { useState } from 'react';
import Button from '../components/primitives/Button.jsx';
import Spinner from '../components/primitives/Spinner.jsx';
import { Skeleton, SkeletonGroup } from '../components/primitives/Skeleton.jsx';
import EmptyState from '../components/primitives/EmptyState.jsx';
import ErrorState from '../components/primitives/ErrorState.jsx';
import StatusBadge from '../components/primitives/StatusBadge.jsx';

/*
 * A living styleguide, reachable at /dev/components.
 *
 * Why this exists: primitives are hard to review inside a half-built feature.
 * Rendering every variant and every state on one page means a visual
 * regression is obvious, and it lets us exercise states (error, retrying,
 * empty) that are otherwise awkward to reach on purpose.
 *
 * It ships only in development -- see the route guard in App.jsx.
 */
function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 'var(--space-6)' }}>
      <h2
        style={{
          fontSize: 'var(--font-size-lg)',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: 'var(--space-2)',
          marginBottom: 'var(--space-3)',
        }}
      >
        {title}
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {children}
      </div>
    </section>
  );
}

export default function ComponentGalleryPage() {
  const [retrying, setRetrying] = useState(false);

  return (
    <div className="scaffold-page" style={{ maxWidth: 900 }}>
      <h1>Component gallery</h1>
      <p style={{ color: 'var(--color-muted)' }}>
        Development only. Every primitive, every state.
      </p>

      <Section title="Button — variants">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="ghost">Ghost</Button>
      </Section>

      <Section title="Button — sizes">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </Section>

      <Section title="Button — loading and disabled">
        <Button loading>Uploading</Button>
        <Button variant="secondary" loading>
          Re-indexing
        </Button>
        <Button disabled>Disabled</Button>
      </Section>

      <Section title="Spinner">
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
      </Section>

      <Section title="StatusBadge — the Document.status enum">
        <StatusBadge status="uploaded" />
        <StatusBadge status="processing" />
        <StatusBadge status="indexed" />
        <StatusBadge status="failed" />
        <StatusBadge status="not-a-real-status" />
      </Section>

      <Section title="Skeleton">
        <div style={{ width: 260 }}>
          <SkeletonGroup label="Loading documents">
            <Skeleton variant="text" width="70%" />
            <Skeleton variant="text" />
            <Skeleton variant="text" width="40%" />
          </SkeletonGroup>
        </div>
        <Skeleton variant="rect" width={180} />
        <Skeleton variant="circle" />
      </Section>

      <Section title="EmptyState">
        <div style={{ flex: 1, border: '1px dashed var(--color-border)' }}>
          <EmptyState
            icon="📄"
            title="No documents yet"
            description="Upload a PDF to start asking questions about it."
            action={<Button>Upload a document</Button>}
          />
        </div>
      </Section>

      <Section title="ErrorState">
        <div style={{ flex: 1 }}>
          <ErrorState
            message="We couldn't load your documents. Check your connection and try again."
            code="AI_SERVICE_UNAVAILABLE"
            retrying={retrying}
            onRetry={() => {
              setRetrying(true);
              setTimeout(() => setRetrying(false), 1500);
            }}
          />
        </div>
      </Section>
    </div>
  );
}
