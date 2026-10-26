/**
 * A DASH manifest holds many representations behind one URL. Wherever the app passes "a URL" around (variants,
 * audio tracks, requests) a representation is addressed as `<manifest url>#vdh-rep=<id>`. The fragment is never sent
 * to a server, so the URL stays a valid, safe http(s) URL everywhere else.
 */
const KEY = 'vdh-rep=';

export function dashRef(manifestUrl: string, repId: string): string {
  return `${manifestUrl.split('#')[0]}#${KEY}${encodeURIComponent(repId)}`;
}

export function parseDashRef(url: string): { manifestUrl: string; repId: string } | undefined {
  const i = url.indexOf(`#${KEY}`);
  if (i === -1) return undefined;
  let repId: string;
  try {
    repId = decodeURIComponent(url.slice(i + 1 + KEY.length));
  } catch {
    return undefined;
  }
  return repId ? { manifestUrl: url.slice(0, i), repId } : undefined;
}
