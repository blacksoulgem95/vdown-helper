/** Parser for HLS attribute lists, e.g. BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720 */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && (input[i] === ',' || input[i] === ' ' || input[i] === '\t')) i++;
    const eq = input.indexOf('=', i);
    if (eq === -1) break;
    const key = input.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value: string;
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        value = input.slice(i + 1);
        i = n;
      } else {
        value = input.slice(i + 1, end);
        i = end + 1;
      }
    } else {
      const comma = input.indexOf(',', i);
      const end = comma === -1 ? n : comma;
      value = input.slice(i, end).trim();
      i = end;
    }
    if (key) out[key] = value;
  }
  return out;
}

export function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const m = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
