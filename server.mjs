import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTENCES, VOICES, SAMPLE_RATE } from './sentences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

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

// ── API: single generation ──────────────────────────────────────────
async function handleGenerate(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const text = url.searchParams.get('text');
  const voice = url.searchParams.get('voice') || 'am_adam';

  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "text" query parameter' }));
    return;
  }

  try {
    const m = await getModel();
    const start = performance.now();
    const result = await m.generate(text, { voice });
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

    const total = VOICES.length * SENTENCES.length;
    let done = 0;
    const results = [];

    for (const voice of VOICES) {
      // Warm up each voice
      send('progress', { status: `Warming up ${voice.label}...`, done, total });
      await m.generate('test', { voice: voice.id });

      for (const sentence of SENTENCES) {
        if (req.destroyed) return; // Client disconnected

        send('progress', {
          status: `${voice.label}: "${sentence.text.slice(0, 40)}..."`,
          done,
          total,
        });

        const result = await m.generate(sentence.text, { voice: voice.id });
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

  if (url.pathname === '/api/generate') return handleGenerate(req, res);
  if (url.pathname === '/api/wpm') return handleWpm(req, res);

  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`  Voice test:     http://localhost:${PORT}/index.html`);
  console.log(`  WPM benchmark:  http://localhost:${PORT}/wpm-benchmark.html`);
  console.log();
  console.log('Model will load on first API request.');
});
