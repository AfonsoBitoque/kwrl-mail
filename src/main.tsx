import React from 'react';
import ReactDOM from 'react-dom/client';

// Ordem deliberada da cascata: 0. Fontes Locais (.woff2) -> 1. Tokens -> 2. Tipografia -> 3. Layout
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/layout.css';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
