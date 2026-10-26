import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { PopupApp } from './PopupApp';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
