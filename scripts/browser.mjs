// Resolves a Chromium executable for Playwright. CHROMIUM_PATH wins; otherwise a preinstalled
// /opt/pw-browsers build is used when present; otherwise Playwright's own download is used.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(base)) {
    const dir = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .pop();
    const exe = dir && join(base, dir, 'chrome-linux64', 'chrome');
    if (exe && existsSync(exe)) return exe;
  }
  return undefined;
}
