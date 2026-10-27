import { describe, expect, it, vi } from 'vitest';
import { DeadlineError, sameDocument, withDeadline } from '@/lib/deadline';

describe('withDeadline (VDH-058)', () => {
  it('passes a timely result through and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('turns work that never finishes into a DeadlineError', async () => {
    vi.useFakeTimers();
    const never = new Promise<number>(() => undefined); // like executeScript waiting on a frame that never loads
    const p = withDeadline(never, 15_000, 'scanning every frame');
    vi.advanceTimersByTime(15_000);
    await expect(p).rejects.toBeInstanceOf(DeadlineError);
    await expect(p).rejects.toThrow(/scanning every frame/);
    vi.useRealTimers();
  });
  it('passes errors of the work through unchanged', async () => {
    await expect(withDeadline(Promise.reject(new Error('Cannot access')), 1000, 'x')).rejects.toThrow(
      'Cannot access',
    );
  });
});

describe('sameDocument (VDH-058)', () => {
  it('treats a #fragment change as the same page and anything else as a new one', () => {
    expect(sameDocument('https://a.example/watch?v=1', 'https://a.example/watch?v=1#t=30')).toBe(true);
    expect(sameDocument('https://a.example/watch?v=1', 'https://a.example/watch?v=1')).toBe(true);
    expect(sameDocument('https://a.example/watch?v=1', 'https://a.example/watch?v=2')).toBe(false);
    expect(sameDocument('https://a.example/a', 'https://b.example/a')).toBe(false);
  });
});
