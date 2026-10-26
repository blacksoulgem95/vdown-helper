import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { StudioApp } from './StudioApp';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <StudioApp />
  </StrictMode>,
);
