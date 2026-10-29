import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { api } from './api';
import { App } from './App';
import { setLanguage } from './i18n';

void api.settings().then((view) => {
  setLanguage(view.language);
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App initial={view} />
    </StrictMode>,
  );
});
