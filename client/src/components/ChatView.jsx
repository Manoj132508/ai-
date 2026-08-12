import { useEffect, useRef, useState } from 'react';
import { useAsk } from '../hooks/useAsk.js';
import Button from './primitives/Button.jsx';
import Spinner from './primitives/Spinner.jsx';
import EmptyState from './primitives/EmptyState.jsx';
import { LiveStatus } from './primitives/Skeleton.jsx';
import styles from './ChatView.module.css';

const STICK_THRESHOLD_PX = 100;

function CitationCard({ citation, position }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={styles.citation}>
      <button
        type="button"
        className={styles.citationHeader}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className={styles.citationIndex}>[{position}]</span>
        <span className={styles.citationName}>{citation.documentName}</span>
        {citation.page != null && <span className={styles.citationPage}>p.{citation.page}</span>}
        {/* The score is shown, not hidden. A citation the user cannot judge
            the strength of is a citation they have to take on trust. */}
        <span className={styles.citationScore}>{citation.score}</span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <p className={styles.citationSnippet}>{citation.snippet}</p>}
    </li>
  );
}

export default function ChatView({ kb }) {
  const [question, setQuestion] = useState('');
  const { ask, cancel, answer, citations, meta, status, error } = useAsk({
    knowledgeBaseId: kb.id,
  });

  const scrollRef = useRef(null);
  const stickToBottom = useRef(true);

  /*
   * Stick-to-bottom. Auto-scroll only while the user is already near the
   * bottom, so scrolling up to re-read an earlier answer is not fought by
   * incoming tokens.
   *
   * The 100px tolerance is not sloppiness: sub-pixel rounding and content
   * growing between the scroll event and the check mean an exact
   * scrollTop + clientHeight === scrollHeight test fails intermittently, and
   * auto-scroll then disengages at random.
   */
  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < STICK_THRESHOLD_PX;
  }

  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [answer, status]);

  const busy = status === 'retrieving' || status === 'streaming';
  const isRefusal = meta && meta.grounded === false;

  function handleSubmit(event) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    ask(trimmed);
    // Cleared only on submit, never on failure -- losing a typed question to
    // a failed request is the most infuriating bug in any chat UI.
    setQuestion('');
  }

  if (kb.chunkCount === 0) {
    return (
      <EmptyState
        icon="💬"
        title="Nothing to ask about yet"
        description="Upload a document and wait for it to finish indexing, then come back."
      />
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.transcript} ref={scrollRef} onScroll={handleScroll}>
        {status === 'idle' && (
          <EmptyState
            icon="❓"
            title="Ask a question"
            description={`Answers come only from the ${kb.documentCount} document(s) in this knowledge base, with citations.`}
          />
        )}

        {status === 'retrieving' && (
          <p className={styles.searching}>
            <Spinner size="sm" /> Searching your documents…
          </p>
        )}

        {answer && (
          <div className={isRefusal ? styles.refusal : styles.answer}>
            {answer}
            {status === 'streaming' && <span className={styles.caret} aria-hidden="true" />}
          </div>
        )}

        {/* Announced per change, not per token: a screen reader reading one
            token at a time is unusable. */}
        <LiveStatus>
          {status === 'retrieving' && 'Searching your documents'}
          {status === 'done' && (isRefusal ? 'No answer found in your documents' : 'Answer complete')}
        </LiveStatus>

        {error && (
          <div className={styles.error} role="alert">
            <strong>{error.message}</strong>
            {error.code && <span className={styles.errorCode}>{error.code}</span>}
          </div>
        )}

        {citations.length > 0 && (
          <section className={styles.sources}>
            <h3 className={styles.sourcesTitle}>Sources</h3>
            <ul className={styles.citationList}>
              {citations.map((citation, index) => (
                <CitationCard key={citation.chunkId} citation={citation} position={index + 1} />
              ))}
            </ul>
          </section>
        )}

        {meta && status === 'done' && (
          <p className={styles.meta}>
            {meta.retrieved} chunk(s) retrieved · best match{' '}
            {meta.top_score == null ? '—' : meta.top_score.toFixed(3)}
            {isRefusal && ' · below the grounding threshold, so no answer was generated'}
          </p>
        )}
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="question">
          Ask about your documents
        </label>
        <input
          id="question"
          className={styles.input}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about your documents…"
          autoComplete="off"
          disabled={busy}
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={cancel}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!question.trim()}>
            Ask
          </Button>
        )}
      </form>
    </div>
  );
}
