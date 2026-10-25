import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { CancelledError, PipelineError } from './errors';

let busy: Promise<unknown> = Promise.resolve();

export interface FfmpegRun {
  /** Input files; each is mounted read-only at /in/<file.name> without copying it into memory. */
  inputs: File[];
  /** Receives the in-container paths of the inputs, in order. */
  args: (paths: string[]) => string[];
  output: string;
  signal: AbortSignal;
  /** Media duration in seconds, used to turn FFmpeg's time counter into a fraction (undefined = unknown). */
  durationSec?: number;
  onProgress: (fraction: number | undefined) => void;
}

/** One FFmpeg run at a time: each instance holds tens of MB of wasm memory plus the output. */
export function runFfmpeg(run: FfmpegRun): Promise<Uint8Array> {
  const p = busy.then(() => execute(run));
  busy = p.catch(() => undefined);
  return p;
}

async function execute(run: FfmpegRun): Promise<Uint8Array> {
  if (run.signal.aborted) throw new CancelledError();
  const ffmpeg = new FFmpeg();
  const logTail: string[] = [];
  ffmpeg.on('log', ({ message }) => {
    logTail.push(message);
    if (logTail.length > 12) logTail.shift();
  });
  ffmpeg.on('progress', ({ time }) => {
    // `time` is microseconds of output produced. It is only meaningful when the input duration is known.
    if (run.durationSec && run.durationSec > 0 && time > 0) run.onProgress(Math.min(1, time / (run.durationSec * 1e6)));
    else run.onProgress(undefined);
  });
  const onAbort = () => ffmpeg.terminate();
  run.signal.addEventListener('abort', onAbort, { once: true });
  try {
    // The core is bundled in the extension (vendor/ffmpeg); nothing is fetched from the network.
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
    });
    await ffmpeg.createDir('/in');
    await ffmpeg.mount(FFFSType.WORKERFS, { files: run.inputs }, '/in');
    const code = await ffmpeg.exec(run.args(run.inputs.map((f) => `/in/${f.name}`)));
    if (run.signal.aborted) throw new CancelledError();
    if (code !== 0) {
      throw new PipelineError('ffmpeg', `FFmpeg exited with code ${code}: ${logTail.slice(-3).join(' | ').slice(0, 300)}`);
    }
    const data = await ffmpeg.readFile(run.output);
    if (typeof data === 'string') throw new PipelineError('ffmpeg', 'FFmpeg produced no binary output');
    return data;
  } catch (e) {
    if (run.signal.aborted) throw new CancelledError();
    throw e;
  } finally {
    run.signal.removeEventListener('abort', onAbort);
    ffmpeg.terminate();
  }
}
