import { describe, expect, it } from 'vitest';
import { heldSource } from '@/components/MediaCard';
import { reasonText } from '@/components/labels';
import { analyzeCandidates, type Fetcher } from '@/lib/analyze';
import { markMseResources, mseMissingReason } from '@/lib/hookData';
import { dataLabel } from '@/lib/dataUrl';
import type { HookReport } from '@/lib/hookData';

const ctx = { tabId: 1, pageUrl: 'https://player.example/e/abc', pageTitle: 'Some film', now: 1 };
const never: Fetcher = {
  head: async () => ({ ok: false, kind: 'http', status: 404 }),
  text: async () => ({ ok: false, kind: 'http', status: 404 }),
};
const mseCandidate = {
  url: dataLabel('application/x-vdh-mse', '56a1c32c'),
  method: 'dom-element' as const,
  held: { kind: 'mse' as const, id: '56a1c32c', bytes: 0 },
};

describe('MediaSource players the page hook did not watch (VDH-051)', () => {
  it('carry the page title, not the internal label, and say they are a player', async () => {
    const [r] = await analyzeCandidates([mseCandidate], ctx, never);
    expect(r?.title).toBe('Some film');
    expect(heldSource(r!)).toMatch(/player/);
    expect(heldSource(r!)).not.toMatch(/data:/);
  });
  it('say which piece is missing: the setting, the site, or a reload', () => {
    expect(mseMissingReason(false, true)).toBe('mse-needs-hook');
    expect(mseMissingReason(false, false)).toBe('mse-needs-hook');
    expect(mseMissingReason(true, false)).toBe('mse-needs-access');
    expect(mseMissingReason(true, true)).toBe('mse-needs-reload');
  });
  it('markMseResources uses the reason for frames without a hook report, and the report where there is one', async () => {
    const [r] = await analyzeCandidates([mseCandidate], ctx, never);
    const inFrame = { ...r!, frameId: 3 };
    const [noHook] = markMseResources([inFrame], new Map(), new Map([[3, 'mse-needs-access' as const]]));
    expect(noHook?.downloadability).toEqual({ status: 'unsupported', reason: 'mse-needs-access' });
    expect(reasonText(noHook!.downloadability)).toMatch(/allow this one and reload/);
    const report = {
      mediaSources: [{ url: 'blob:https://player.example/x', buffers: [{ mime: 'video/mp4', bytes: 10 }] }],
      emeKeySystems: [],
    } as unknown as HookReport;
    const [watched] = markMseResources(
      [inFrame],
      new Map([[3, report]]),
      new Map([[3, 'mse-needs-access' as const]]),
    );
    // the hook report wins; its own verdict depends on the buffers it saw
    expect(watched?.downloadability.reason).not.toBe('mse-needs-access');
  });
});
