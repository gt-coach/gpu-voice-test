import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const threadCount = String(workerData.threads ?? 1);
const require = createRequire(import.meta.url);

process.env.OMP_NUM_THREADS ??= threadCount;
process.env.OPENBLAS_NUM_THREADS ??= threadCount;
process.env.MKL_NUM_THREADS ??= threadCount;
process.env.VECLIB_MAXIMUM_THREADS ??= threadCount;
process.env.NUMEXPR_NUM_THREADS ??= threadCount;
process.env.ORT_NUM_THREADS ??= threadCount;

async function configureTransformers() {
  if (!workerData.cacheDir) return;

  try {
    const kokoroEntry = require.resolve('kokoro-js');
    const kokoroRoot = path.resolve(path.dirname(kokoroEntry), '..');
    const transformersEntry = path.join(
      kokoroRoot,
      '..',
      '@huggingface',
      'transformers',
      'dist',
      'transformers.node.mjs',
    );
    const { env } = await import(pathToFileURL(transformersEntry).href);
    env.cacheDir = workerData.cacheDir;
  } catch (error) {
    parentPort.postMessage({
      type: 'warning',
      message: `Unable to configure Transformers.js cache: ${errorText(error)}`,
    });
  }
}

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function getAudioData(audio) {
  if (!audio) return null;

  let data =
    audio.audio ??
    audio.data ??
    audio.samples ??
    null;

  if (!data && ArrayBuffer.isView(audio)) {
    data = audio;
  }

  if (Array.isArray(data) && data.length > 0 && ArrayBuffer.isView(data[0])) {
    data = data[0];
  }

  return ArrayBuffer.isView(data) ? data : null;
}

function getAudioStats(audio) {
  const sampleRate =
    audio?.sampling_rate ??
    audio?.sample_rate ??
    audio?.sampleRate ??
    24000;

  const data = getAudioData(audio);
  const sampleCount = typeof data?.length === 'number' ? data.length : 0;

  return {
    sampleRate,
    sampleCount,
    audioSec: sampleCount > 0 ? sampleCount / sampleRate : 0,
  };
}

function writeWav(filePath, float32, sampleRate) {
  const numSamples = float32.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i] ?? 0));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * bytesPerSample);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

async function main() {
  try {
    await configureTransformers();

    const { KokoroTTS } = await import('kokoro-js');
    const loadStartedAt = performance.now();
    let lastProgressFile = null;
    let lastProgressPct = -1;

    const tts = await KokoroTTS.from_pretrained(workerData.modelId, {
      dtype: workerData.dtype,
      device: workerData.device,
      progress_callback: (progress) => {
        if (workerData.workerId !== 0) return;
        if (progress.status === 'progress' && progress.progress != null) {
          const rounded = Math.floor(progress.progress);
          const file = progress.file ?? null;
          const fileChanged = file !== lastProgressFile;
          const shouldReport =
            fileChanged ||
            rounded === 100 ||
            rounded >= lastProgressPct + 5;

          if (!shouldReport) return;

          lastProgressFile = file;
          lastProgressPct = rounded;

          parentPort.postMessage({
            type: 'load_progress',
            file,
            progress: rounded,
          });
        }
      },
    });

    const loadMs = performance.now() - loadStartedAt;

    parentPort.postMessage({
      type: 'ready',
      workerId: workerData.workerId,
      loadMs,
    });

    parentPort.on('message', async (job) => {
      if (job.type !== 'generate') return;

      const startedAt = performance.now();

      try {
        const audio = await tts.generate(job.text, {
          voice: job.voice,
          speed: job.speed,
        });

        const stats = getAudioStats(audio);
        const data = getAudioData(audio);

        if (job.savePath && data && stats.sampleRate > 0) {
          writeWav(job.savePath, data, stats.sampleRate);
        }

        parentPort.postMessage({
          type: 'result',
          ok: true,
          job,
          genMs: performance.now() - startedAt,
          ...stats,
        });
      } catch (error) {
        parentPort.postMessage({
          type: 'result',
          ok: false,
          job,
          genMs: performance.now() - startedAt,
          error: errorText(error),
          sampleRate: 0,
          sampleCount: 0,
          audioSec: 0,
        });
      }
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'ready_error',
      workerId: workerData.workerId,
      error: errorText(error),
    });
  }
}

main();
