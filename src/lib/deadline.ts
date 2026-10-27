/** Raised by `withDeadline` when the work did not finish in time. */
export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 1000)} s`);
    this.name = 'DeadlineError';
  }
}

/**
 * The work's result, or a DeadlineError after `ms`. The work itself is not cancelled (a browser call cannot be), so its
 * late result must be ignored by the caller.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(what, ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Two addresses of the same document: only the #fragment differs (an in-page jump is not a new page). */
export function sameDocument(a: string, b: string): boolean {
  const strip = (u: string) => u.split('#')[0] ?? u;
  return strip(a) === strip(b);
}
