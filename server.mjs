import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTENCES, VOICES, SAMPLE_RATE } from './sentences.mjs';
import {
  KITTEN_DEFAULT_VOICE,
  KITTEN_DEFAULT_TEXT,
  KITTEN_MODELS,
  KOKORO_MODELS,
  KOKORO_SPEED,
  KOKORO_VOICES,
  SUPERTONIC_MODELS,
  SUPERTONIC_SPEED,
  SUPERTONIC_STEPS,
  SUPERTONIC_VOICES,
  KITTEN_SAMPLE_RATE,
  KITTEN_SPEED,
  KITTEN_THREAD_OPTIONS,
  KITTEN_VOICES,
  WPM_TARGET,
  clampKittenSpeed,
  clampKokoroSpeed,
  clampSpeedFor,
  speedLimitsFor,
  clampSupertonicSpeed,
  clampSupertonicSteps,
  normalizeKittenThreads,
  resolveKittenModel,
  resolveKittenVoice,
  resolveSupertonicVoice,
} from './kitten-config.mjs';
import {
  audioStats,
  installKittenPythonCompat,
  installKittenNodeThreadedLoader,
  playbackGainForPeak,
  prepareKittenNodeRuntime,
  registerKittenModels,
  withKittenCacheHome,
} from './kitten-runtime.mjs';
import { loadSupertonicModel } from './supertonic-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const KITTEN_CACHE_DIR = path.join(__dirname, '.cache', 'kitten-tts');
const SUPERTONIC_CACHE_DIR = path.join(__dirname, '.cache', 'supertonic-3');
const KITTEN_WPM_MODEL_ID = 'nano-fp32';
const kittenModelCache = new Map();
const kittenModelLoads = new Map();
const supertonicModelCache = new Map();
const supertonicModelLoads = new Map();

// ── MIME types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ── Lazy model singleton ────────────────────────────────────────────
let model = null;
let modelLoading = null;

async function getModel() {
  if (model) return model;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    console.log('Loading Kokoro model (first run downloads ~330MB)...');
    const m = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        dtype: 'fp32',
        device: 'cpu',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.progress != null) {
            process.stdout.write(`\rDownloading${p.file ? ' ' + p.file : ''}... ${p.progress.toFixed(0)}%`);
          } else if (p.status === 'done') {
            process.stdout.write('\n');
          }
        },
      },
    );
    // Warm up with default voice
    await m.generate('test', { voice: 'am_adam' });
    console.log('Model ready.');
    model = m;
    modelLoading = null;
    return m;
  })();

  return modelLoading;
}

function rmsEnergy(audio) {
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / audio.length);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

// Word-weighted speaking rate: total words / total audio seconds. Averaging the
// per-sentence WPMs instead would over-weight short cues, whose rate is dragged
// down by fixed lead-in/trailing silence.
function wordWeightedWpm(results) {
  if (!results.length) return 0;
  const words = results.reduce((s, r) => s + r.wordCount, 0);
  const seconds = results.reduce((s, r) => s + r.audioDurationSec, 0);
  if (!seconds) return 0;
  return parseFloat(((words / seconds) * 60).toFixed(1));
}

function buildWpmSummary(results) {
  const voiceIds = [...new Set(results.map((r) => r.voice))];
  const cascades = ['cue', 'compact', 'full'];

  return {
    byVoice: Object.fromEntries(
      voiceIds.map((id) => {
        const voiceResults = results.filter((r) => r.voice === id);
        const perCascade = {};
        for (const cascade of cascades) {
          const cResults = voiceResults.filter((r) => r.cascade === cascade);
          if (cResults.length) perCascade[cascade] = wordWeightedWpm(cResults);
        }
        return [id, {
          label: voiceResults[0].voiceLabel,
          overall: wordWeightedWpm(voiceResults),
          ...perCascade,
        }];
      }),
    ),
    byCascade: Object.fromEntries(
      cascades
        .map((c) => [c, results.filter((r) => r.cascade === c)])
        .filter(([, rs]) => rs.length)
        .map(([c, rs]) => [c, wordWeightedWpm(rs)]),
    ),
    overall: wordWeightedWpm(results),
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowed) {
  res.writeHead(405, {
    'Content-Type': 'application/json',
    'Allow': allowed,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: `Method not allowed. Use ${allowed}.` }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function modelCacheKey(modelId, threads) {
  return `${modelId}::threads=${threads}`;
}

function publicKittenModel(entry, currentLoadMs = 0, cacheHit = true) {
  return {
    id: entry.modelInfo.id,
    modelId: entry.modelInfo.modelId,
    label: entry.modelInfo.label,
    size: entry.modelInfo.size,
    role: entry.modelInfo.role,
    note: entry.modelInfo.note,
    threads: entry.threads,
    voices: entry.voices,
    runtime: entry.runtime,
    runtimeRequested: entry.runtimeRequested,
    executionProviders: entry.executionProviders,
    threading: entry.threading,
    loadMs: Math.round(currentLoadMs),
    modelLoadMs: Math.round(entry.loadMs),
    cached: cacheHit,
    loadedAt: entry.loadedAt,
  };
}

function publicSupertonicModel(entry, currentLoadMs = 0, cacheHit = true) {
  return {
    id: entry.modelInfo.id,
    modelId: entry.modelInfo.modelId,
    label: entry.modelInfo.label,
    size: entry.modelInfo.size,
    role: entry.modelInfo.role,
    note: entry.modelInfo.note,
    threads: entry.threads,
    voices: entry.voices,
    runtime: entry.runtime,
    executionProviders: entry.executionProviders,
    threading: entry.threading,
    loadMs: Math.round(currentLoadMs),
    modelLoadMs: Math.round(entry.loadMs),
    cached: cacheHit,
    loadedAt: entry.loadedAt,
  };
}

async function getKittenModel(modelId = KITTEN_MODELS[0].id, numThreads = 2) {
  const modelInfo = resolveKittenModel(modelId);
  const threads = normalizeKittenThreads(numThreads);
  const key = modelCacheKey(modelInfo.modelId, threads);

  if (kittenModelCache.has(key)) {
    const entry = kittenModelCache.get(key);
    return { entry, cacheHit: true, currentLoadMs: 0 };
  }

  if (kittenModelLoads.has(key)) {
    const entry = await kittenModelLoads.get(key);
    return { entry, cacheHit: false, currentLoadMs: entry.loadMs };
  }

  const loadPromise = (async () => {
    fs.mkdirSync(KITTEN_CACHE_DIR, { recursive: true });
    const { KittenTTS, MODELS, downloadModel, loadNpz } = await import('kitten-tts-js');
    registerKittenModels(MODELS, KITTEN_MODELS);
    installKittenNodeThreadedLoader(KittenTTS, { downloadModel, loadNpz });
    installKittenPythonCompat(KittenTTS);
    await prepareKittenNodeRuntime();
    const options = {
      runtime: 'cpu',
      cacheDir: KITTEN_CACHE_DIR,
    };
    if (threads !== 'auto') {
      options.numThreads = threads;
    }

    const start = performance.now();
    const model = await withKittenCacheHome(__dirname, () => KittenTTS.from_pretrained(modelInfo.modelId, options));
    const loadMs = performance.now() - start;
    const voices = typeof model.list_voices === 'function'
      ? model.list_voices()
      : KITTEN_VOICES.map((voice) => voice.id);

    const entry = {
      model,
      modelInfo,
      threads,
      voices,
      loadMs,
      loadedAt: new Date().toISOString(),
      runtime: model.runtime || 'cpu',
      runtimeRequested: model.runtimeRequested || 'cpu',
      executionProviders: model.executionProviders || [],
      threading: model.threading || null,
    };
    kittenModelCache.set(key, entry);
    return entry;
  })();

  kittenModelLoads.set(key, loadPromise);
  try {
    const entry = await loadPromise;
    return { entry, cacheHit: false, currentLoadMs: entry.loadMs };
  } finally {
    kittenModelLoads.delete(key);
  }
}

async function getSupertonicModel(numThreads = 'auto') {
  const modelInfo = SUPERTONIC_MODELS[0];
  const threads = normalizeKittenThreads(numThreads);
  const key = modelCacheKey(modelInfo.modelId, threads);

  if (supertonicModelCache.has(key)) {
    const entry = supertonicModelCache.get(key);
    return { entry, cacheHit: true, currentLoadMs: 0 };
  }

  if (supertonicModelLoads.has(key)) {
    const entry = await supertonicModelLoads.get(key);
    return { entry, cacheHit: false, currentLoadMs: entry.loadMs };
  }

  const loadPromise = (async () => {
    const start = performance.now();
    const model = await loadSupertonicModel({
      cacheDir: SUPERTONIC_CACHE_DIR,
      numThreads: threads,
      voices: SUPERTONIC_VOICES,
    });
    const loadMs = performance.now() - start;
    const entry = {
      model,
      modelInfo,
      threads,
      voices: SUPERTONIC_VOICES.map((voice) => voice.id),
      loadMs,
      loadedAt: new Date().toISOString(),
      runtime: model.runtime || 'cpu',
      executionProviders: model.executionProviders || [],
      threading: model.threading || null,
    };
    supertonicModelCache.set(key, entry);
    return entry;
  })();

  supertonicModelLoads.set(key, loadPromise);
  try {
    const entry = await loadPromise;
    return { entry, cacheHit: false, currentLoadMs: entry.loadMs };
  } finally {
    supertonicModelLoads.delete(key);
  }
}

function audioDataToBase64(audioData) {
  const buf = Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength);
  return buf.toString('base64');
}

async function handleKittenConfig(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET');
    return;
  }

  writeJson(res, 200, {
    models: [
      ...KITTEN_MODELS.map((model) => ({ ...model, family: 'kitten' })),
      ...KOKORO_MODELS,
      ...SUPERTONIC_MODELS,
    ],
    voices: KITTEN_VOICES,
    familyControls: {
      kitten: {
        label: 'KittenTTS',
        voices: KITTEN_VOICES,
        defaultVoice: KITTEN_DEFAULT_VOICE,
        speed: KITTEN_SPEED,
        clean: true,
        threads: KITTEN_THREAD_OPTIONS,
        defaultThreads: 'auto',
        threadLabel: 'ORT intra-op threads',
        threadNote: 'Applied to Kitten Node CPU sessions only. Auto leaves ONNX Runtime in its default CPU-thread mode.',
      },
      kokoro: {
        label: 'Kokoro',
        voices: KOKORO_VOICES,
        defaultVoice: 'am_adam',
        speed: KOKORO_SPEED,
      },
      supertonic: {
        label: 'Supertonic 3',
        voices: SUPERTONIC_VOICES,
        defaultVoice: 'M1',
        speed: SUPERTONIC_SPEED,
        threads: KITTEN_THREAD_OPTIONS,
        defaultThreads: 'auto',
        threadLabel: 'ORT intra-op threads',
        threadNote: 'Applied to Supertonic Node CPU sessions only. Auto leaves ONNX Runtime in its default CPU-thread mode.',
        steps: SUPERTONIC_STEPS,
        stepLabel: 'Total steps',
        stepNote: 'Higher usually improves quality but is slower. Supertonic default is 8.',
      },
    },
    sampleRate: KITTEN_SAMPLE_RATE,
    speed: KITTEN_SPEED,
    threads: KITTEN_THREAD_OPTIONS,
    defaultText: KITTEN_DEFAULT_TEXT,
    defaultVoice: KITTEN_DEFAULT_VOICE,
    messages: SENTENCES.map((sentence, index) => ({
      id: `${sentence.cascade}-${index + 1}`,
      ...sentence,
    })),
  });
}

async function handleSupertonicGenerate(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const text = String(body.text || KITTEN_DEFAULT_TEXT).trim();
    if (!text) {
      writeJson(res, 400, { error: 'Missing "text" field' });
      return;
    }

    const voice = resolveSupertonicVoice(body.voice);
    const speed = clampSupertonicSpeed(body.speed);
    const totalSteps = clampSupertonicSteps(body.totalSteps);
    const { entry, cacheHit, currentLoadMs } = await getSupertonicModel(body.numThreads);

    const start = performance.now();
    const audio = await entry.model.generate(text, {
      voice,
      lang: 'en',
      speed,
      totalSteps,
    });
    const genTimeMs = performance.now() - start;
    const data = audio.wav instanceof Float32Array ? audio.wav : new Float32Array(audio.wav);
    const sampleRate = entry.model.sampleRate || 44100;
    const audioDurationSec = audio.duration?.[0] || data.length / sampleRate;
    const rtf = audioDurationSec / (genTimeMs / 1000);
    const stats = audioStats(data);
    const playbackGain = playbackGainForPeak(stats.peak);

    writeJson(res, 200, {
      model: publicSupertonicModel(entry, currentLoadMs, cacheHit),
      text,
      voice,
      speed,
      totalSteps,
      lang: 'en',
      audio: audioDataToBase64(data),
      sampleRate,
      samples: data.length,
      audioDurationSec: round(audioDurationSec, 3),
      genTimeMs: Math.round(genTimeMs),
      rtf: round(rtf, 2),
      min: round(stats.min, 6),
      max: round(stats.max, 6),
      peak: round(stats.peak, 6),
      rms: round(stats.rms, 6),
      clipCount: stats.clipCount,
      clipPercent: round(stats.clipPercent, 4),
      nanCount: stats.nanCount,
      playbackGain: round(playbackGain, 6),
    });
  } catch (e) {
    writeJson(res, 500, { error: e.message });
  }
}

async function handleKittenLoad(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { entry, cacheHit, currentLoadMs } = await getKittenModel(body.modelId, body.numThreads);
    writeJson(res, 200, {
      model: publicKittenModel(entry, currentLoadMs, cacheHit),
    });
  } catch (e) {
    writeJson(res, 500, { error: e.message });
  }
}

async function handleKittenGenerate(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const text = String(body.text || KITTEN_DEFAULT_TEXT).trim();
    if (!text) {
      writeJson(res, 400, { error: 'Missing "text" field' });
      return;
    }

    const voice = resolveKittenVoice(body.voice);
    const speed = clampKittenSpeed(body.speed);
    const clean = body.clean !== false;
    const { entry, cacheHit, currentLoadMs } = await getKittenModel(body.modelId, body.numThreads);

    const start = performance.now();
    const audio = await entry.model.generate(text, { voice, speed, clean });
    const genTimeMs = performance.now() - start;
    const data = audio.data instanceof Float32Array ? audio.data : new Float32Array(audio.data);
    const sampleRate = audio.sampling_rate || KITTEN_SAMPLE_RATE;
    const audioDurationSec = audio.duration || data.length / sampleRate;
    const rtf = audioDurationSec / (genTimeMs / 1000);
    const stats = audioStats(data);
    const playbackGain = playbackGainForPeak(stats.peak);

    writeJson(res, 200, {
      model: publicKittenModel(entry, currentLoadMs, cacheHit),
      text,
      voice,
      speed,
      clean,
      audio: audioDataToBase64(data),
      sampleRate,
      samples: data.length,
      audioDurationSec: round(audioDurationSec, 3),
      genTimeMs: Math.round(genTimeMs),
      rtf: round(rtf, 2),
      min: round(stats.min, 6),
      max: round(stats.max, 6),
      peak: round(stats.peak, 6),
      rms: round(stats.rms, 6),
      clipCount: stats.clipCount,
      clipPercent: round(stats.clipPercent, 4),
      nanCount: stats.nanCount,
      playbackGain: round(playbackGain, 6),
    });
  } catch (e) {
    writeJson(res, 500, { error: e.message });
  }
}

// ── API: single generation ──────────────────────────────────────────
async function handleGenerate(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const text = url.searchParams.get('text');
  const voice = url.searchParams.get('voice') || 'am_adam';
  const speed = clampKokoroSpeed(url.searchParams.get('speed') || '1');

  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "text" query parameter' }));
    return;
  }

  try {
    const m = await getModel();
    const start = performance.now();
    const result = await m.generate(text, { voice, speed });
    const genTimeMs = performance.now() - start;

    const audio = result.audio;
    const audioDurationSec = audio.length / SAMPLE_RATE;
    const rtf = audioDurationSec / (genTimeMs / 1000);
    const rms = rmsEnergy(audio);

    // Encode Float32Array as base64
    const buf = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    const audioBase64 = buf.toString('base64');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      audio: audioBase64,
      samples: audio.length,
      audioDurationSec,
      genTimeMs: Math.round(genTimeMs),
      rtf: parseFloat(rtf.toFixed(2)),
      rms: parseFloat(rms.toFixed(6)),
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API: WPM benchmark (SSE) ────────────────────────────────────────
async function handleWpm(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const speed = clampKokoroSpeed(url.searchParams.get('speed') || '1');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const m = await getModel();

    send('progress', { status: `Speed: ${speed.toFixed(1)}x`, done: 0, total: 0 });

    const total = VOICES.length * SENTENCES.length;
    let done = 0;
    const results = [];

    for (const voice of VOICES) {
      // Warm up each voice
      send('progress', { status: `Warming up ${voice.label}...`, done, total });
      await m.generate('test', { voice: voice.id, speed });

      for (const sentence of SENTENCES) {
        if (req.destroyed) return; // Client disconnected

        send('progress', {
          status: `${voice.label}: "${sentence.text.slice(0, 40)}..."`,
          done,
          total,
        });

        const result = await m.generate(sentence.text, { voice: voice.id, speed });
        const audioDurationSec = result.audio.length / SAMPLE_RATE;
        const wpm = (sentence.wordCount / audioDurationSec) * 60;

        const entry = {
          model: 'kokoro',
          voice: voice.id,
          voiceLabel: voice.label,
          text: sentence.text,
          cascade: sentence.cascade,
          wordCount: sentence.wordCount,
          audioDurationSec: parseFloat(audioDurationSec.toFixed(3)),
          wpm: parseFloat(wpm.toFixed(1)),
        };

        results.push(entry);
        done++;
        send('result', entry);
      }
    }

    send('summary', buildWpmSummary(results));
    send('done', { total: results.length });
  } catch (e) {
    send('error', { message: e.message });
  }

  res.end();
}

// ── API: KittenTTS WPM benchmark (SSE) ──────────────────────────────
async function handleKittenWpm(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const speed = clampKittenSpeed(url.searchParams.get('speed'));
  const threads = normalizeKittenThreads(url.searchParams.get('numThreads') || 'auto');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    send('progress', { status: 'Loading Kitten nano fp32...', done: 0, total: 0 });
    const { entry } = await getKittenModel(KITTEN_WPM_MODEL_ID, threads);

    send('progress', { status: `Speed: ${speed.toFixed(1)}x`, done: 0, total: 0 });

    const total = KITTEN_VOICES.length * SENTENCES.length;
    let done = 0;
    const results = [];

    for (const voice of KITTEN_VOICES) {
      const voiceLabel = `${voice.label} (${voice.gender})`;

      send('progress', { status: `Warming up ${voiceLabel}...`, done, total });
      await entry.model.generate('test', { voice: voice.id, speed, clean: true });

      for (const sentence of SENTENCES) {
        if (req.destroyed) return; // Client disconnected

        send('progress', {
          status: `${voiceLabel}: "${sentence.text.slice(0, 40)}..."`,
          done,
          total,
        });

        const audio = await entry.model.generate(sentence.text, { voice: voice.id, speed, clean: true });
        const data = audio.data instanceof Float32Array ? audio.data : new Float32Array(audio.data);
        const sampleRate = audio.sampling_rate || KITTEN_SAMPLE_RATE;
        const audioDurationSec = audio.duration || data.length / sampleRate;
        const wpm = (sentence.wordCount / audioDurationSec) * 60;

        const result = {
          model: 'kitten',
          voice: voice.id,
          voiceLabel,
          text: sentence.text,
          cascade: sentence.cascade,
          wordCount: sentence.wordCount,
          audioDurationSec: parseFloat(audioDurationSec.toFixed(3)),
          wpm: parseFloat(wpm.toFixed(1)),
        };

        results.push(result);
        done++;
        send('result', result);
      }
    }

    send('summary', buildWpmSummary(results));
    send('done', { total: results.length });
  } catch (e) {
    send('error', { message: e.message });
  }

  res.end();
}

// ── Speed calibration ───────────────────────────────────────────────
// Both models are deterministic: the same (voice, speed, text) always yields the
// same duration. So WPM is a stable function of speed and a root-find converges
// rather than chasing noise; no repeat-and-average is needed.

const CALIBRATION_VOICES = {
  kokoro: VOICES.map((v) => ({ id: v.id, label: v.label })),
  kitten: KITTEN_VOICES.map((v) => ({ id: v.id, label: `${v.label} (${v.gender})` })),
};

// Quick mode: two sentences per cascade. Faster to iterate on, but a different
// word mix than the full set, so it solves for a slightly different "170".
function calibrationSentences(mode) {
  if (mode !== 'quick') return SENTENCES;
  return ['cue', 'compact', 'full'].flatMap(
    (cascade) => SENTENCES.filter((s) => s.cascade === cascade).slice(0, 2),
  );
}

// 3 decimals, not 2. Achievable WPM is a step function of speed (the duration
// predictor rounds phoneme lengths to whole frames), and the steps are coarse:
// Kokoro Bella jumps 167.8 -> 183.6 WPM between 1.32x and 1.34x. At 2 decimals the
// solution at 1.325x (169.6) is simply not representable.
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

async function generateDurationSec(family, voiceId, text, speed) {
  if (family === 'kokoro') {
    const m = await getModel();
    const result = await m.generate(text, { voice: voiceId, speed });
    return result.audio.length / SAMPLE_RATE;
  }

  const { entry } = await getKittenModel(KITTEN_WPM_MODEL_ID, 'auto');
  const audio = await entry.model.generate(text, { voice: voiceId, speed, clean: true });
  const data = audio.data instanceof Float32Array ? audio.data : new Float32Array(audio.data);
  return audio.duration || data.length / (audio.sampling_rate || KITTEN_SAMPLE_RATE);
}

async function measureVoiceWpm(family, voiceId, speed, sentences) {
  let words = 0;
  let seconds = 0;
  for (const sentence of sentences) {
    seconds += await generateDurationSec(family, voiceId, sentence.text, speed);
    words += sentence.wordCount;
  }
  return parseFloat(((words / seconds) * 60).toFixed(1));
}

// Before the target is bracketed: proportional, then secant. WPM rises with speed
// roughly, though not exactly — Kokoro falls ~9% short of proportional at 2.0x.
function unbracketedGuess(points, target) {
  const b = points[points.length - 1];
  if (points.length === 1) return b.speed * (target / b.wpm);

  const a = points[points.length - 2];
  if (Math.abs(b.wpm - a.wpm) < 1e-6) return b.speed * (target / b.wpm);
  return b.speed + ((target - b.wpm) * (b.speed - a.speed)) / (b.wpm - a.wpm);
}

// Once bracketed, false position (Illinois): interpolate *inside* the bracket rather
// than halving it. Plain bisection would leap to the useless midpoint of a wide
// bracket — Leo, bracketed by [1.0, 1.803], wasted a pass at 1.402x measuring 129 WPM.
// The Illinois halving of the retained endpoint stops the one-sided stalling that
// plain regula falsi suffers on this convex curve.
async function calibrateVoice(family, voice, options, onPass, isAborted) {
  const { target, tolerance, maxPasses, sentences } = options;
  const limits = speedLimitsFor(family);
  const points = [];

  let a = null;  // { speed, f } with f < 0
  let b = null;  // { speed, f } with f > 0  (also the most recent point once bracketed)
  let speed = round3(clampSpeedFor(family, 1));
  let status = 'max-passes';

  for (let pass = 1; pass <= maxPasses; pass++) {
    if (isAborted()) return null;

    const wpm = await measureVoiceWpm(family, voice.id, speed, sentences);
    const f = wpm - target;
    points.push({ speed, wpm });
    onPass({ pass, speed, wpm, delta: parseFloat(f.toFixed(1)) });

    if (Math.abs(f) <= tolerance) {
      status = 'ok';
      break;
    }

    if (a && b) {
      // Illinois update: the new point always becomes b; a only moves when the
      // bracket flips, otherwise a's weight is halved to pull the next guess across.
      if (f * b.f < 0) a = b;
      else a = { ...a, f: a.f / 2 };
      b = { speed, f };
    } else if (f < 0) {
      a = { speed, f };
    } else {
      b = { speed, f };
    }

    const raw = a && b
      ? (a.speed * b.f - b.speed * a.f) / (b.f - a.f)
      : unbracketedGuess(points, target);
    const next = round3(clampSpeedFor(family, raw));

    // Repeating a speed we already measured means we can't move: either the clamp is
    // binding, or the bracket has collapsed onto a single step of the WPM staircase
    // that straddles the target — in which case no speed reaches it, and the closest
    // point is the true answer rather than a failure to search hard enough.
    if (points.some((p) => p.speed === next)) {
      if (next <= limits.min || next >= limits.max) status = 'clamped';
      else if (a && b && Math.abs(b.speed - a.speed) <= 0.002) status = 'quantized';
      else status = 'max-passes';
      break;
    }
    speed = next;
  }

  const best = points.reduce((x, y) => (Math.abs(y.wpm - target) < Math.abs(x.wpm - target) ? y : x));
  return { ...best, status, passes: points };
}

async function handleCalibrate(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = Math.max(30, Math.min(400, parseFloat(url.searchParams.get('target') || String(WPM_TARGET))));
  const tolerance = Math.max(0.1, Math.min(20, parseFloat(url.searchParams.get('tolerance') || '1')));
  const maxPasses = Math.max(1, Math.min(12, parseInt(url.searchParams.get('maxPasses') || '9', 10)));
  const scope = url.searchParams.get('scope') || 'both';
  const mode = url.searchParams.get('mode') || 'full';
  const voiceFilter = url.searchParams.get('voices');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const isAborted = () => req.destroyed;

  try {
    const sentences = calibrationSentences(mode);
    const families = scope === 'both' ? ['kokoro', 'kitten'] : [scope];
    const wanted = voiceFilter ? new Set(voiceFilter.split(',')) : null;

    const jobs = families.flatMap((family) =>
      CALIBRATION_VOICES[family]
        .filter((voice) => !wanted || wanted.has(voice.id))
        .map((voice) => ({ family, voice })),
    );

    if (!jobs.length) throw new Error('No voices matched the requested scope');

    send('progress', {
      status: `Calibrating ${jobs.length} voices to ${target} WPM (${sentences.length} sentences each)`,
      done: 0,
      total: jobs.length,
    });

    const speeds = { kokoro: {}, kitten: {} };
    let done = 0;

    for (const { family, voice } of jobs) {
      if (isAborted()) return;

      const onPass = (pass) => {
        send('pass', { model: family, voice: voice.id, voiceLabel: voice.label, maxPasses, ...pass });
        send('progress', {
          status: `${voice.label} · pass ${pass.pass}/${maxPasses} · ${pass.speed}x → ${pass.wpm.toFixed(1)} WPM`,
          done,
          total: jobs.length,
          model: family,
        });
      };

      const result = await calibrateVoice(family, voice, { target, tolerance, maxPasses, sentences }, onPass, isAborted);
      if (!result) return; // client disconnected mid-search

      done++;
      speeds[family][voice.id] = { speed: result.speed, wpm: result.wpm, status: result.status };
      send('voice', {
        model: family,
        voice: voice.id,
        voiceLabel: voice.label,
        speed: result.speed,
        wpm: result.wpm,
        status: result.status,
        passCount: result.passes.length,
      });
      send('progress', { status: `${voice.label} → ${result.speed}x`, done, total: jobs.length, model: family });
    }

    send('done', { target, tolerance, mode, sentences: sentences.length, speeds });
  } catch (e) {
    send('error', { message: e.message });
  }

  res.end();
}

// ── Static file server ──────────────────────────────────────────────
function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.join(__dirname, safePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(__dirname + path.sep) && filePath !== path.join(__dirname, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + safePath);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Router ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/kitten/config') return handleKittenConfig(req, res);
  if (url.pathname === '/api/kitten/load') return handleKittenLoad(req, res);
  if (url.pathname === '/api/kitten/generate') return handleKittenGenerate(req, res);
  if (url.pathname === '/api/kitten/wpm') return handleKittenWpm(req, res);
  if (url.pathname === '/api/calibrate') return handleCalibrate(req, res);
  if (url.pathname === '/api/supertonic/generate') return handleSupertonicGenerate(req, res);
  if (url.pathname === '/api/generate') return handleGenerate(req, res);
  if (url.pathname === '/api/wpm') return handleWpm(req, res);

  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`  Voice test:     http://localhost:${PORT}/index.html`);
  console.log(`  WPM benchmark:  http://localhost:${PORT}/wpm-benchmark.html`);
  console.log(`  TTS benchmark:  http://localhost:${PORT}/kitten-benchmark.html`);
  console.log();
  console.log('Model will load on first API request.');
});
