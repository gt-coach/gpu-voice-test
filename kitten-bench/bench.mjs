import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { KittenTTS, MODELS as KITTEN_JS_MODELS, downloadModel, encodeWav, loadNpz } from 'kitten-tts-js';
import { SENTENCES } from '../sentences.mjs';
import {
  KITTEN_MODELS,
  KITTEN_SAMPLE_RATE,
  KITTEN_DEFAULT_VOICE,
  clampKittenSpeed,
  normalizeKittenThreads,
  resolveKittenModel,
  resolveKittenVoice,
} from '../kitten-config.mjs';
import {
  audioStats,
  applyGain,
  installKittenNodeThreadedLoader,
  installKittenPythonCompat,
  playbackGainForPeak,
  prepareKittenNodeRuntime,
  registerKittenModels,
  withKittenCacheHome,
} from '../kitten-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name, fallback) {
  return !['0', 'false', 'no', 'off'].includes(arg(name, String(fallback)).toLowerCase());
}

function intArg(name, fallback) {
  const parsed = Number.parseInt(arg(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(name, fallback) {
  return arg(name, fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function writeCsv(filePath, rows) {
  const columns = [
    'model',
    'modelId',
    'voice',
    'tier',
    'threadsRequested',
    'threadsApplied',
    'wordCount',
    'genTimeMs',
    'audioDurationSec',
    'rtf',
    'rms',
    'peak',
    'clipCount',
    'clipPercent',
    'nanCount',
    'playbackGain',
    'samples',
    'samplePath',
    'error',
    'text',
  ];
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function summarize(rows) {
  const successful = rows.filter((row) => !row.error);
  const byModel = {};
  for (const row of successful) {
    byModel[row.model] ??= [];
    byModel[row.model].push(row);
  }

  return Object.fromEntries(Object.entries(byModel).map(([model, modelRows]) => {
    const avg = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return [model, {
      samples: modelRows.length,
      avgGenTimeMs: round(avg(modelRows.map((row) => row.genTimeMs)), 1),
      avgAudioDurationSec: round(avg(modelRows.map((row) => row.audioDurationSec)), 3),
      avgRtf: round(avg(modelRows.map((row) => row.rtf)), 2),
      avgRms: round(avg(modelRows.map((row) => row.rms)), 6),
      avgPeak: round(avg(modelRows.map((row) => row.peak)), 6),
      clippedSamples: modelRows.reduce((sum, row) => sum + row.clipCount, 0),
    }];
  }));
}

const opts = {
  models: listArg('models', 'mini,micro,nano-fp32,nano-int8'),
  voices: listArg('voices', `${KITTEN_DEFAULT_VOICE},Leo,Jasper`),
  tiers: new Set(listArg('tiers', 'cue,compact,full')),
  speed: clampKittenSpeed(arg('speed', '1')),
  clean: boolArg('clean', true),
  threads: normalizeKittenThreads(arg('threads', '2')),
  limit: intArg('limit', 0),
  saveSamples: boolArg('saveSamples', true),
  maxSamples: intArg('maxSamples', 24),
  cacheDir: path.resolve(rootDir, arg('cacheDir', '.cache/kitten-tts')),
  resultsDir: path.resolve(rootDir, arg('resultsDir', 'kitten-results')),
  samplesDir: path.resolve(rootDir, arg('samplesDir', 'kitten-samples')),
};

const models = opts.models.map(resolveKittenModel);
const voices = opts.voices.map(resolveKittenVoice);
const messages = SENTENCES
  .filter((sentence) => opts.tiers.has(sentence.cascade))
  .slice(0, opts.limit > 0 ? opts.limit : undefined);

registerKittenModels(KITTEN_JS_MODELS, KITTEN_MODELS);
installKittenNodeThreadedLoader(KittenTTS, { downloadModel, loadNpz });
installKittenPythonCompat(KittenTTS);

if (messages.length === 0) {
  throw new Error('No benchmark messages selected');
}

fs.mkdirSync(opts.cacheDir, { recursive: true });
fs.mkdirSync(opts.resultsDir, { recursive: true });
fs.mkdirSync(opts.samplesDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const rows = [];
let sampleCount = 0;

for (const modelInfo of models) {
  console.log(`\nLoading ${modelInfo.label} (${modelInfo.modelId})`);
  const modelOptions = {
    runtime: 'cpu',
    cacheDir: opts.cacheDir,
  };
  if (opts.threads !== 'auto') modelOptions.numThreads = opts.threads;

  const loadStart = performance.now();
  await prepareKittenNodeRuntime();
  const model = await withKittenCacheHome(rootDir, () => KittenTTS.from_pretrained(modelInfo.modelId, modelOptions));
  const loadMs = performance.now() - loadStart;
  const threading = model.threading || { requested: opts.threads, applied: 'runtime-default' };
  console.log(`Loaded in ${Math.round(loadMs)}ms (${threading.applied === 'auto' ? 'ORT auto' : `${threading.applied} intra`} threads)`);

  for (const voice of voices) {
    for (const message of messages) {
      const row = {
        model: modelInfo.label,
        modelId: modelInfo.modelId,
        voice,
        tier: message.cascade,
        threadsRequested: threading.requested,
        threadsApplied: threading.applied,
        wordCount: message.wordCount,
        text: message.text,
        loadMs: Math.round(loadMs),
      };

      try {
        const genStart = performance.now();
        const audio = await model.generate(message.text, {
          voice,
          speed: opts.speed,
          clean: opts.clean,
        });
        const genTimeMs = performance.now() - genStart;
        const data = audio.data instanceof Float32Array ? audio.data : new Float32Array(audio.data);
        const sampleRate = audio.sampling_rate || KITTEN_SAMPLE_RATE;
        const audioDurationSec = audio.duration || data.length / sampleRate;
        const rtf = audioDurationSec / (genTimeMs / 1000);
        const stats = audioStats(data);
        const playbackGain = playbackGainForPeak(stats.peak);

        Object.assign(row, {
          genTimeMs: Math.round(genTimeMs),
          audioDurationSec: round(audioDurationSec, 3),
          rtf: round(rtf, 2),
          rms: round(stats.rms, 6),
          peak: round(stats.peak, 6),
          clipCount: stats.clipCount,
          clipPercent: round(stats.clipPercent, 4),
          nanCount: stats.nanCount,
          playbackGain: round(playbackGain, 6),
          samples: data.length,
          samplePath: '',
          error: '',
        });

        if (opts.saveSamples && sampleCount < opts.maxSamples) {
          const filename = `${timestamp}-${modelInfo.id}-${voice}-${message.cascade}-${sampleCount + 1}.wav`;
          const filePath = path.join(opts.samplesDir, filename);
          const playbackData = applyGain(data, playbackGain);
          fs.writeFileSync(filePath, Buffer.from(encodeWav(playbackData, sampleRate)));
          row.samplePath = path.relative(rootDir, filePath);
          sampleCount++;
        }

        console.log(`${modelInfo.label} ${voice} ${message.cascade}: ${row.rtf}x RTF, ${row.genTimeMs}ms`);
      } catch (error) {
        row.error = error.message;
        console.error(`${modelInfo.label} ${voice} ${message.cascade}: ${error.message}`);
      }

      rows.push(row);
    }
  }
}

const summary = {
  timestamp,
  options: opts,
  modelSummary: summarize(rows),
  rows,
};

const jsonPath = path.join(opts.resultsDir, `kitten-benchmark-${timestamp}.json`);
const csvPath = path.join(opts.resultsDir, `kitten-benchmark-${timestamp}.csv`);
fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeCsv(csvPath, rows);

console.log('\nSummary');
console.table(summary.modelSummary);
console.log(`JSON: ${path.relative(rootDir, jsonPath)}`);
console.log(`CSV:  ${path.relative(rootDir, csvPath)}`);
if (sampleCount > 0) {
  console.log(`WAV samples: ${path.relative(rootDir, opts.samplesDir)}`);
}
