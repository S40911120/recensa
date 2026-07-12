import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted fonts (offline-capable, consistent across OSes, no system-font or CDN dependency):
// DM Sans = UI body text (soft-geometric; rounded terminals match the rounded UI, professional not playful),
// JetBrains Mono = code/data, Bricolage = brand wordmark
import '@fontsource-variable/dm-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource-variable/bricolage-grotesque';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
