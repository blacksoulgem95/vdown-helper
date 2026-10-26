import { archiveLookup } from './archive';
import { commonsLookup } from './commons';
import { peertubeLookup } from './peertube';
import type { SiteLookup } from './types';

export type { SiteLookup } from './types';

/**
 * The open sites with a public, anonymous API that vdown-helper knows. Recognition is by address only; there is no
 * adapter for any streaming service with a private or undocumented interface, and none will be added.
 */
export function siteLookupFor(page: URL): SiteLookup | undefined {
  return commonsLookup(page) ?? archiveLookup(page) ?? peertubeLookup(page);
}
