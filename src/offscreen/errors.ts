import type { JobErrorCode } from '@/types/download';

/** Error carrying a stable code the background maps to a localised message. Messages never contain URLs. */
export class PipelineError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export function asPipelineError(e: unknown): PipelineError | CancelledError {
  if (e instanceof PipelineError || e instanceof CancelledError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') return new CancelledError();
  if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NotAllowedError')) {
    return new PipelineError('out-of-memory', 'The browser ran out of storage space for this download');
  }
  if (e instanceof RangeError || (e instanceof Error && /memory|allocation/i.test(e.message))) {
    return new PipelineError('out-of-memory', 'The browser ran out of memory for this operation');
  }
  return new PipelineError('unknown', e instanceof Error ? e.message : 'Unexpected error');
}
