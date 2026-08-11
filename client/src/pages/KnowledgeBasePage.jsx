import { useParams } from 'react-router-dom';

/*
 * One component serves all three knowledge base views (chat / documents /
 * settings), selected by the `view` prop set in the route table.
 *
 * Why one component and not three routes to three pages: all three share the
 * same sidebar, the same tab strip, and the same "does this KB exist and is it
 * mine?" fetch. Splitting them would duplicate that shell three times, and the
 * tab strip would have to be lifted into a layout anyway.
 */
export default function KnowledgeBasePage({ view }) {
  const { kbId } = useParams();

  return (
    <div className="scaffold-page">
      <h1>Knowledge base</h1>
      <p style={{ color: 'var(--color-muted)' }}>
        id: <code>{kbId}</code> &middot; view: <code>{view}</code>
      </p>
    </div>
  );
}
