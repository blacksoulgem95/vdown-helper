// Renders public/logo.svg to PNG icons using the Playwright Chromium. Run manually: node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumExecutable } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const svg = readFileSync(resolve(root, 'public/logo.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ['--headless=new'] });
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
  );
  const png = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  writeFileSync(resolve(root, `public/icons/icon-${size}.png`), png);
  await page.close();
}
await browser.close();
console.log('icons written');
