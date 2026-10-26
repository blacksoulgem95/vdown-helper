import { describe, expect, it } from 'vitest';
import { childrenNamed, decodeEntities, firstChild, localName, parseXml } from '@/lib/xml';

describe('parseXml', () => {
  it('parses elements, attributes, text, CDATA, comments and processing instructions', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!-- a comment -->
      <a x="1" y='two &amp; three'>
        <b/>
        <c:d k="v">text &lt;ok&gt; <![CDATA[<raw & stuff>]]></c:d>
        <e></e>
      </a>`);
    expect(root?.name).toBe('a');
    expect(root?.attrs).toEqual({ x: '1', y: 'two & three' });
    expect(root?.children.map((c) => c.name)).toEqual(['b', 'c:d', 'e']);
    const d = firstChild(root!, 'd')!;
    expect(d.text.trim()).toBe('text <ok> <raw & stuff>');
    expect(localName('cenc:pssh')).toBe('pssh');
    expect(childrenNamed(root!, 'b')).toHaveLength(1);
  });
  it('decodes only the predefined and numeric entities and never expands custom ones', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;')).toBe('<>&"\'AB');
    expect(decodeEntities('&custom;&#0;&#xD800;&#99999999;')).toBe('&custom;&#0;&#xD800;&#99999999;');
  });
  it.each([
    ['empty', ''],
    ['text only', 'hello'],
    ['unclosed', '<a><b></a>'],
    ['mismatched', '<a></b>'],
    ['two roots', '<a/><b/>'],
    ['trailing junk', '<a/>junk'],
    ['bad attribute', '<a x=1/>'],
    ['unterminated comment', '<a><!-- x </a>'],
    ['custom entity declaration', '<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'],
    ['internal subset', '<!DOCTYPE a [ ]><a/>'],
    ['unterminated CDATA', '<a><![CDATA[x</a>'],
  ])('rejects %s without throwing', (_n, text) => {
    expect(() => parseXml(text)).not.toThrow();
    expect(parseXml(text)).toBeUndefined();
  });
  it('enforces node and depth limits', () => {
    expect(parseXml('<a>' + '<b/>'.repeat(50) + '</a>', { maxNodes: 10 })).toBeUndefined();
    expect(parseXml('<a>'.repeat(100) + '</a>'.repeat(100))).toBeUndefined();
    expect(parseXml('<a>' + '<b/>'.repeat(50) + '</a>')).toBeDefined();
  });
  it('accepts a DOCTYPE without a subset', () => {
    expect(parseXml('<!DOCTYPE MPD><MPD/>')?.name).toBe('MPD');
  });
});
