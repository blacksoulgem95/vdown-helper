import { describe, expect, it } from 'vitest';
import { typed } from '@/offscreen/jobs';

describe('typed (VDH-055)', () => {
  it('gives a staged file the MIME type of what it holds, without copying it', async () => {
    const onDisk = new Blob([new Uint8Array([0x47, 1, 2, 3])]); // like an OPFS file: no type
    expect(onDisk.type).toBe('');
    const ts = typed(onDisk, 'ts');
    expect(ts.type).toBe('video/mp2t');
    expect(new Uint8Array(await ts.arrayBuffer())).toEqual(new Uint8Array([0x47, 1, 2, 3]));
    expect(typed(onDisk, 'mp4').type).toBe('video/mp4');
    expect(typed(onDisk, 'zip').type).toBe('application/zip');
    expect(typed(onDisk, 'flv').type).toBe('application/octet-stream'); // never empty: an empty type lets Chrome guess
    const already = new Blob([], { type: 'video/mp2t' });
    expect(typed(already, 'ts')).toBe(already);
  });
});
