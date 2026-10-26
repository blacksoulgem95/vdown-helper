import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { OptionsApp } from './OptionsApp';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
