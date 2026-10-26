/**
 * A small, safe XML reader for manifests (MPD, TTML). The service worker has no DOMParser, and a manifest comes from
 * a hostile page, so this reader is deliberately limited: no DTD processing and no custom entities (so no entity
 * expansion attacks), hard limits on size, depth and node count, and it never throws: it returns undefined.
 */
export interface XmlNode {
  /** Qualified name as written, e.g. "SegmentTemplate" or "cenc:pssh". */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
  /** Character data and child elements in document order (for mixed content such as subtitles). */
  content: (string | XmlNode)[];
}

function appendText(node: XmlNode, s: string): void {
  node.text += s;
  const last = node.content[node.content.length - 1];
  if (typeof last === 'string') node.content[node.content.length - 1] = last + s;
  else node.content.push(s);
}

export interface XmlLimits {
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxNodes: 200_000, maxDepth: 64 };

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x')) return safeChar(parseInt(body.slice(2), 16), m);
    if (body.startsWith('#')) return safeChar(parseInt(body.slice(1), 10), m);
    return ENTITIES[body] ?? m; // unknown (custom) entities are left as written, never expanded
  });
}

function safeChar(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : fallback;
}

/** Name without its namespace prefix: "cenc:pssh" -> "pssh". */
export const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

/** After the root element only whitespace, comments and processing instructions may follow. */
function onlyTrailingNoise(src: string, from: number): boolean {
  // Linear: every step either advances past something well-formed or stops. (A global lazy regex over "<!--<!--<!--..."
  // restarts a scan to the end of the text at every repeat, which is quadratic.)
  let i = from;
  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (i >= src.length) return true;
    let end: number;
    if (src.startsWith('<!--', i)) end = src.indexOf('-->', i + 4) + 3;
    else if (src.startsWith('<?', i)) end = src.indexOf('?>', i + 2) + 2;
    else return false;
    if (end < i + 2) return false; // indexOf found nothing (-1 + 3 or -1 + 2)
    i = end;
  }
}

export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlNode | undefined {
  const { maxNodes, maxDepth } = { ...DEFAULT_LIMITS, ...limits };
  const src = input.replace(/^\uFEFF/, '');
  const n = src.length;
  let i = 0;
  let nodes = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  const isNameChar = (c: string) => /[A-Za-z0-9_:.\-\u00B7-\uFFFD]/.test(c);

  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i && stack.length > 0) {
      const top = stack[stack.length - 1] as XmlNode;
      appendText(top, decodeEntities(src.slice(i, textEnd)));
    }
    if (lt === -1) break;
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) return undefined;
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1 || stack.length === 0) return undefined;
      appendText(stack[stack.length - 1] as XmlNode, src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) return undefined;
      i = end + 2;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE: skipped, never interpreted. An internal subset (custom entities) is refused outright.
      const end = src.indexOf('>', i + 2);
      if (end === -1) return undefined;
      const decl = src.slice(i, end + 1);
      if (/<!ENTITY/i.test(decl) || decl.includes('[')) return undefined;
      i = end + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i + 2);
      if (end === -1) return undefined;
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) return undefined;
      i = end + 1;
      if (stack.length === 0) return onlyTrailingNoise(src, i) ? root : undefined;
    } else {
      // start tag
      let j = i + 1;
      while (j < n && isNameChar(src[j] as string)) j++;
      const name = src.slice(i + 1, j);
      if (!name) return undefined;
      const node: XmlNode = { name, attrs: {}, children: [], text: '', content: [] };
      let selfClosing = false;
      for (;;) {
        while (j < n && /\s/.test(src[j] as string)) j++;
        if (j >= n) return undefined;
        if (src[j] === '>') {
          j++;
          break;
        }
        if (src[j] === '/' && src[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        let k = j;
        while (k < n && isNameChar(src[k] as string)) k++;
        const attr = src.slice(j, k);
        if (!attr) return undefined;
        j = k;
        while (j < n && /\s/.test(src[j] as string)) j++;
        if (src[j] !== '=') return undefined;
        j++;
        while (j < n && /\s/.test(src[j] as string)) j++;
        const quote = src[j];
        if (quote !== '"' && quote !== "'") return undefined;
        const close = src.indexOf(quote, j + 1);
        if (close === -1) return undefined;
        node.attrs[attr] = decodeEntities(src.slice(j + 1, close));
        j = close + 1;
      }
      if (++nodes > maxNodes) return undefined;
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(node);
        parent.content.push(node);
      } else if (root)
        return undefined; // a second root element
      else root = node;
      i = j;
      if (!selfClosing) {
        if (stack.length + 1 > maxDepth) return undefined;
        stack.push(node);
      } else if (stack.length === 0) {
        return onlyTrailingNoise(src, i) ? root : undefined;
      }
    }
  }
  return undefined; // unclosed elements
}

/** Direct children with the given local name. */
export const childrenNamed = (node: XmlNode, local: string): XmlNode[] =>
  node.children.filter((c) => localName(c.name) === local);

export const firstChild = (node: XmlNode, local: string): XmlNode | undefined =>
  node.children.find((c) => localName(c.name) === local);
