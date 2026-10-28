/**
 * Console logging for the content scripts. The page is hostile and its addresses can carry tokens, so callers pass only
 * fixed words chosen by the extension, never page-derived text. (The extension pages use the redacting logger of
 * lib/security; it is not used here, so the shared core never loads in the page.)
 */
export const log = {
  warn: (...words: Array<string | number | boolean>): void => console.warn('[vdown]', ...words),
};
