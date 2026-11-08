import React from 'react';
import ReactDOM from 'react-dom/client';

// Ordem deliberada da cascata: 0. Fontes Locais (.woff2) -> 1. Tokens -> 2. Tipografia -> 3. Layout
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/layout.css';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider } from './i18n';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
);
