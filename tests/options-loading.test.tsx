import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from '@/options/OptionsApp';
import { SETTINGS_KEY } from '@/lib/settings';
import { installFakeChrome, type FakeChrome } from './helpers/fake-chrome';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fake: FakeChrome;
let host: HTMLDivElement;
beforeEach(() => {
  fake = installFakeChrome();
  const c = globalThis as unknown as { chrome: Record<string, unknown> };
  c.chrome['permissions'] = {
    contains: vi.fn(async () => false),
    onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  (c.chrome['runtime'] as Record<string, unknown>)['getManifest'] = () => ({ version: '1.2.3' });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => host.remove());

describe('Settings page while the stored settings load (VDH-057)', () => {
  it('shows no field until the stored settings are read, then shows the stored values', async () => {
    fake.storage.local.data[SETTINGS_KEY] = { schemaVersion: 1, defaultMode: 'audio-only' };
    let release: () => void = () => undefined;
    const real = fake.storage.local.get.bind(fake.storage.local);
    // Hold the read open, as a slow machine does right after a reload.
    fake.storage.local.get = (keys) => new Promise((r) => (release = () => r(real(keys))));
    const root = createRoot(host);
    await act(async () => root.render(<OptionsApp />));
    // Before: the page showed "video-audio" (the default) here, and a test or a user could read or edit it.
    expect(host.querySelectorAll('select')).toHaveLength(0);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    const mode = host.querySelector('select') as HTMLSelectElement;
    expect(mode.value).toBe('audio-only');
    await act(async () => root.unmount());
  });
});
