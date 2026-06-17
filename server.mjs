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
  KITTEN_SAMPLE_RATE,
  KITTEN_SPEED,
  KITTEN_THREAD_OPTIONS,
  KITTEN_VOICES,
  clampKittenSpeed,
  normalizeKittenThreads,
  resolveKittenModel,
  resolveKittenVoice,
} from './kitten-config.mjs';
import {
  audioStats,
  installKittenPythonCompat,
  playbackGainForPeak,
  prepareKittenNodeRuntime,
  registerKittenModels,
  withKittenCacheHome,
} from './kitten-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const KITTEN_CACHE_DIR = path.join(__dirname, '.cache', 'kitten-tts');
const kittenModelCache = new Map();
const kittenModelLoads = new Map();

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
    const { KittenTTS, MODELS } = await import('kitten-tts-js');
    registerKittenModels(MODELS, KITTEN_MODELS);
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
    ],
    voices: KITTEN_VOICES,
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
  const speed = Math.max(0.5, Math.min(2.0, parseFloat(url.searchParams.get('speed') || '1')));

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
  const speed = Math.max(0.5, Math.min(2.0, parseFloat(url.searchParams.get('speed') || '1')));

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

    // ── Compute summary ───────────────────────────────────────────
    const byVoice = {};
    const byCascade = {};

    for (const r of results) {
      if (!byVoice[r.voice]) byVoice[r.voice] = { label: r.voiceLabel, wpms: [] };
      byVoice[r.voice].wpms.push(r.wpm);

      if (!byCascade[r.cascade]) byCascade[r.cascade] = [];
      byCascade[r.cascade].push(r.wpm);
    }

    const avg = (arr) => parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1));

    const summary = {
      byVoice: Object.fromEntries(
        Object.entries(byVoice).map(([id, v]) => {
          const voiceResults = results.filter((r) => r.voice === id);
          const cascades = {};
          for (const cascade of ['cue', 'compact', 'full']) {
            const cResults = voiceResults.filter((r) => r.cascade === cascade);
            if (cResults.length) cascades[cascade] = avg(cResults.map((r) => r.wpm));
          }
          return [id, { label: v.label, overall: avg(v.wpms), ...cascades }];
        }),
      ),
      byCascade: Object.fromEntries(
        Object.entries(byCascade).map(([c, wpms]) => [c, avg(wpms)]),
      ),
      overall: avg(results.map((r) => r.wpm)),
    };

    send('summary', summary);
    send('done', { total: results.length });
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
  if (url.pathname === '/api/generate') return handleGenerate(req, res);
  if (url.pathname === '/api/wpm') return handleWpm(req, res);

  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`  Voice test:     http://localhost:${PORT}/index.html`);
  console.log(`  WPM benchmark:  http://localhost:${PORT}/wpm-benchmark.html`);
  console.log(`  Kitten bench:   http://localhost:${PORT}/kitten-benchmark.html`);
  console.log();
  console.log('Model will load on first API request.');
});
