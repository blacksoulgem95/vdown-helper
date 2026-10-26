import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Reads the real design tokens from the stylesheet so the test follows the source of truth.
const css = readFileSync(resolve(import.meta.dirname, '../src/styles/theme.css'), 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`token ${name} not found`);
  return m[1] as string;
};

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('colour tokens meet WCAG AA (4.5:1) for text on the surfaces they are used on', () => {
  const surfaces = ['void', 'surface', 'surface-2'];
  const text = ['fg', 'muted', 'neon', 'magenta', 'acid', 'danger'];
  for (const s of surfaces) {
    for (const t of text) {
      it(`${t} on ${s}`, () => {
        expect(contrast(token(t), token(s))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('dark text on the neon primary button', () => {
    expect(contrast(token('void'), token('neon'))).toBeGreaterThanOrEqual(4.5);
  });
  it('matches the palette in the product brief', () => {
    expect(token('void').toLowerCase()).toBe('#080a12');
    expect(token('surface').toLowerCase()).toBe('#101522');
    expect(token('neon').toLowerCase()).toBe('#00f5ff');
    expect(token('magenta').toLowerCase()).toBe('#ff2bd6');
    expect(token('acid').toLowerCase()).toBe('#b7ff3c');
    expect(token('fg').toLowerCase()).toBe('#f2f5ff');
    expect(token('muted').toLowerCase()).toBe('#8994aa');
    expect(token('danger').toLowerCase()).toBe('#ff4d6d');
  });
});
