import { t, type MessageKey } from '@/lib/i18n';
import type { EngineError } from './api';
import { td } from './i18n';

const KEYS: Record<string, MessageKey> = {
  'http-error': 'jobErrHttp',
  network: 'jobErrNetwork',
  protected: 'errProtected',
  'too-large': 'issueTooLarge',
  ffmpeg: 'jobErrFfmpeg',
  decrypt: 'jobErrDecrypt',
  interrupted: 'jobErrInterrupted',
  invalid: 'jobErrInvalid',
};

/** The engine's error in the user's language (the HTTP status is kept: it tells what the server said). */
export function errorText(e: EngineError): string {
  if (e.code === 'invalid' && e.message.includes('schedule')) return td('setWindowInvalid');
  if (e.code === 'invalid' && e.message.includes('full path')) return td('folderRelative');
  if (e.code === 'invalid' && e.message.includes('re-encode is not there')) return td('encFileGone');
  const key = KEYS[e.code];
  const base = key ? t(key) : t('errGeneric');
  return e.code === 'http-error' ? `${base} (${e.message})` : base;
}
