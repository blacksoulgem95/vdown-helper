import type { MetaMedia } from '../metadata';

/** What a site adapter needs the page to look up: one anonymous request, and how to read its answer. */
export interface SiteLookup {
  site: 'commons' | 'archive' | 'peertube';
  /** Same-origin API address (the page's own site), fetched without credentials. */
  apiUrl: string;
  parse: (json: unknown) => MetaMedia[];
}
