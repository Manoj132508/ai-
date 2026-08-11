import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';

// Import order matters: Bootstrap first, then our tokens, then our global
// rules. Later stylesheets win on equal specificity, so this is what lets the
// token layer override Bootstrap's defaults.
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles/tokens.css';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Opt in to the v7 behaviours now, while the app is small. Both are
        already the default in React Router 7; adopting them here means the
        upgrade is a version bump rather than a migration. */}
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
