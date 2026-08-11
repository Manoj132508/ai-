import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="scaffold-page">
      <h1>Page not found</h1>
      <p style={{ color: 'var(--color-muted)' }}>
        That page does not exist. <Link to="/">Back to your knowledge bases</Link>
      </p>
    </div>
  );
}
