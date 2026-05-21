import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SENTENCES, VOICES } from '../sentences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workerPath = path.join(__dirname, 'worker.mjs');
const workerPids = new Set();

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name, fallback) {
  const value = arg(name, String(fallback));
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function intArg(name, fallback) {
  const parsed = Number.parseInt(arg(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function threadsArg(name, fallback = 'auto') {
  const value = arg(name, fallback).toLowerCase();
  if (value === 'auto' || value === 'default') return 'auto';

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatArg(name, fallback) {
  const parsed = Number.parseFloat(arg(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(name, fallback) {
  return arg(name, fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const index = Math.min(clean.length - 1, Math.ceil((p / 100) * clean.length) - 1);
  return clean[index];
}

function mean(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return 0;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function rssMbForPid(pid) {
  if (!pid) return 0;

  try {
    if (os.platform() === 'linux') {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      return match ? Number.parseInt(match[1], 10) / 1024 : 0;
    }

    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rssKb = Number.parseInt(output.trim(), 10);
    return Number.isFinite(rssKb) ? rssKb / 1024 : 0;
  } catch {
    return 0;
  }
}

function aggregateRssMb() {
  const parentRssMb = process.memoryUsage().rss / 1024 / 1024;
  const workersRssMb = [...workerPids].reduce((sum, pid) => sum + rssMbForPid(pid), 0);
  return parentRssMb + workersRssMb;
}

function makeRng(seed = 42) {
  let state = seed >>> 0;
  return function rng() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function parseTierWeights(raw) {
  const defaults = { cue: 3, compact: 6, full: 1 };
  if (!raw) return defaults;

  const parsed = { ...defaults };
  for (const part of raw.split(',')) {
    const [tier, value] = part.split(':').map((item) => item.trim());
    const number = Number.parseFloat(value);
    if (tier && Number.isFinite(number) && number > 0) {
      parsed[tier] = number;
    }
  }
  return parsed;
}

const CURRENT_USAGE = {
  wau: 75,
  lapsPerUserWeek: 33,
  messagesPerLap: 5,
  lapSec: 90,
};

const DEADLINES_MS = {
  cue: 1500,
  compact: 2500,
  full: 4500,
};

const tierWeights = parseTierWeights(arg('tierWeights', 'cue:3,compact:6,full:1'));
const defaultVoices = VOICES.map((voice) => voice.id).join(',');

const opts = {
  modelId: arg('modelId', 'onnx-community/Kokoro-82M-v1.0-ONNX'),
  dtype: arg('dtype', 'q8'),
  device: arg('device', 'cpu'),
  workers: intArg('workers', 1),
  threads: threadsArg('threads', 'auto'),
  voices: listArg('voices', defaultVoices),
  users: listArg('users', '1,2,3,4,6,8').map(Number).filter(Number.isFinite),
  burstSizes: listArg('bursts', '1,2,4,8').map(Number).filter(Number.isFinite),
  stageSec: intArg('stageSec', 120),
  drainSec: intArg('drainSec', 60),
  maxPending: intArg('maxPending', 30),
  maxLatePct: floatArg('maxLatePct', 10),
  speed: floatArg('speed', 1.1),
  seed: intArg('seed', 42),
  micro: boolArg('micro', true),
  tierWeights,
  cacheDir: path.resolve(rootDir, arg('cacheDir', '.cache')),
  resultsDir: path.resolve(rootDir, arg('resultsDir', 'results')),
  samplesDir: path.resolve(rootDir, arg('samplesDir', 'samples')),
};

const messages = SENTENCES.map((sentence) => ({
  ...sentence,
  tier: sentence.cascade,
  chars: sentence.text.length,
  weight: opts.tierWeights[sentence.cascade] ?? 1,
  deadlineMs: DEADLINES_MS[sentence.cascade] ?? 3000,
}));

if (opts.workers < 1) {
  throw new Error('--workers must be at least 1');
}

if (opts.threads !== 'auto' && opts.threads < 1) {
  throw new Error('--threads must be auto or at least 1');
}

if (opts.voices.length === 0) {
  throw new Error('--voices must contain at least one voice id');
}

if (messages.length === 0) {
  throw new Error('No benchmark sentences found');
}

function pickMessage(rng) {
  const total = messages.reduce((sum, message) => sum + message.weight, 0);
  let x = rng() * total;

  for (const message of messages) {
    x -= message.weight;
    if (x <= 0) return message;
  }

  return messages[messages.length - 1];
}

function firstMessageForTier(tier) {
  return messages.find((message) => message.tier === tier) ?? messages[0];
}

function averageWeightedChars() {
  const totalWeight = messages.reduce((sum, message) => sum + message.weight, 0);
  return messages.reduce((sum, message) => sum + message.chars * message.weight, 0) / totalWeight;
}

function formatTable(rows) {
  console.table(rows);
}

class Pool {
  constructor() {
    this.items = [];
    this.queue = [];
    this.results = [];
    this.resolvers = new Map();
    this.nextJobId = 1;
    this.failed = false;
  }

  async init() {
    fs.mkdirSync(opts.resultsDir, { recursive: true });
    fs.mkdirSync(opts.samplesDir, { recursive: true });
    fs.mkdirSync(opts.cacheDir, { recursive: true });

    for (let i = 0; i < opts.workers; i++) {
      const item = {
        id: i,
        busy: false,
        worker: null,
        readyPromise: null,
        activeJob: null,
      };

      item.readyPromise = new Promise((resolve, reject) => {
        item.worker = fork(workerPath, [], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: {
            ...process.env,
            KOKORO_WORKER_DATA: JSON.stringify({
              workerId: i,
              modelId: opts.modelId,
              dtype: opts.dtype,
              device: opts.device,
              threads: opts.threads,
              cacheDir: opts.cacheDir,
            }),
          },
        });
        workerPids.add(item.worker.pid);

        item.worker.on('message', (message) => {
          if (message.type === 'warning') {
            console.warn(message.message);
            return;
          }

          if (message.type === 'ready') {
            resolve(message);
            return;
          }

          if (message.type === 'ready_error') {
            reject(new Error(message.error));
            return;
          }

          if (message.type === 'load_progress' && message.progress != null) {
            process.stdout.write(
              `\rLoading model${message.file ? ` ${message.file}` : ''}: ${message.progress.toFixed(0)}%`,
            );
            return;
          }

          if (message.type === 'result') {
            this.handleResult(item, message);
          }
        });

        item.worker.on('error', (error) => {
          this.failItem(item, error);
          reject(error);
        });

        item.worker.on('exit', (code) => {
          workerPids.delete(item.worker.pid);
          if (code !== 0 && !this.failed) {
            this.failItem(item, new Error(`Worker ${item.id} exited with code ${code}`));
          }
        });
      });

      this.items.push(item);
    }

    const ready = await Promise.all(this.items.map((item) => item.readyPromise));

    process.stdout.write('\n');
    console.log('Workers ready:');
    formatTable(
      ready.map((row) => ({
        worker: row.workerId,
        loadMs: round(row.loadMs, 0),
      })),
    );
  }

  pendingCount() {
    return this.queue.length + this.items.filter((item) => item.busy).length;
  }

  submit(partialJob) {
    const id = `job-${this.nextJobId++}`;
    const enqueuedAt = performance.now();
    const job = {
      ...partialJob,
      id,
      type: 'generate',
      enqueuedAt,
      speed: opts.speed,
    };

    if (this.failed) {
      const rejected = this.rejectedResult(job, 'pool_failed');
      this.results.push(rejected);
      return Promise.resolve(rejected);
    }

    if (this.pendingCount() >= opts.maxPending) {
      const rejected = this.rejectedResult(job, 'queue_full');
      this.results.push(rejected);
      return Promise.resolve(rejected);
    }

    return new Promise((resolve) => {
      this.resolvers.set(id, resolve);
      this.queue.push(job);
      this.pump();
    });
  }

  rejectedResult(job, error) {
    return {
      id: job.id,
      rejected: true,
      ok: false,
      tier: job.tier,
      voice: job.voice,
      chars: job.text.length,
      deadlineMs: job.deadlineMs,
      latencyMs: 0,
      queueMs: 0,
      genMs: 0,
      audioSec: 0,
      rtf: null,
      speedX: null,
      deadlineMiss: true,
      error,
    };
  }

  pump() {
    for (const item of this.items) {
      if (item.busy) continue;
      const job = this.queue.shift();
      if (!job) break;

      item.busy = true;
      item.activeJob = job;
      job.startedAt = performance.now();
      item.worker.send(job);
    }
  }

  handleResult(item, message) {
    const doneAt = performance.now();
    const job = message.job;

    item.busy = false;
    item.activeJob = null;

    const latencyMs = doneAt - job.enqueuedAt;
    const queueMs = job.startedAt - job.enqueuedAt;
    const rtf = message.audioSec > 0 ? (message.genMs / 1000) / message.audioSec : null;
    const speedX = message.genMs > 0 ? message.audioSec / (message.genMs / 1000) : null;

    const result = {
      id: job.id,
      rejected: false,
      ok: message.ok,
      tier: job.tier,
      voice: job.voice,
      chars: job.text.length,
      deadlineMs: job.deadlineMs,
      latencyMs,
      queueMs,
      genMs: message.genMs,
      audioSec: message.audioSec,
      rtf,
      speedX,
      deadlineMiss: !message.ok || latencyMs > job.deadlineMs,
      error: message.error ?? null,
    };

    this.results.push(result);

    const resolve = this.resolvers.get(job.id);
    if (resolve) {
      this.resolvers.delete(job.id);
      resolve(result);
    }

    this.pump();
  }

  failItem(item, error) {
    this.failed = true;

    if (item.activeJob) {
      const result = this.rejectedResult(item.activeJob, errorText(error));
      this.results.push(result);
      const resolve = this.resolvers.get(item.activeJob.id);
      if (resolve) {
        this.resolvers.delete(item.activeJob.id);
        resolve(result);
      }
      item.activeJob = null;
    }

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      const result = this.rejectedResult(job, errorText(error));
      this.results.push(result);
      const resolve = this.resolvers.get(job.id);
      if (resolve) {
        this.resolvers.delete(job.id);
        resolve(result);
      }
    }
  }

  async waitIdle(maxWaitMs) {
    const startedAt = performance.now();

    while (this.pendingCount() > 0) {
      if (performance.now() - startedAt > maxWaitMs) {
        return false;
      }

      await sleep(50);
    }

    return true;
  }

  async terminate() {
    await Promise.allSettled(
      this.items.map(
        (item) =>
          new Promise((resolve) => {
            if (!item.worker || item.worker.killed) {
              resolve();
              return;
            }

            item.worker.once('exit', resolve);
            item.worker.kill('SIGTERM');
          }),
      ),
    );
  }
}

function summarize(results, wallSec) {
  const generated = results.filter((result) => !result.rejected);
  const ok = generated.filter((result) => result.ok);
  const rejected = results.filter((result) => result.rejected);
  const late = results.filter((result) => result.deadlineMiss);

  const totalAudioSec = ok.reduce((sum, result) => sum + result.audioSec, 0);
  const totalChars = ok.reduce((sum, result) => sum + result.chars, 0);

  return {
    jobs: results.length,
    ok: ok.length,
    errors: generated.filter((result) => !result.ok).length,
    rejected: rejected.length,
    latePct: results.length > 0 ? (late.length / results.length) * 100 : 0,
    p50LatencyMs: percentile(generated.map((result) => result.latencyMs), 50),
    p95LatencyMs: percentile(generated.map((result) => result.latencyMs), 95),
    p95QueueMs: percentile(generated.map((result) => result.queueMs), 95),
    p95GenMs: percentile(generated.map((result) => result.genMs), 95),
    meanRtf: mean(ok.map((result) => result.rtf)),
    meanSpeedX: mean(ok.map((result) => result.speedX)),
    realtimeX: wallSec > 0 ? totalAudioSec / wallSec : 0,
    charsPerSec: wallSec > 0 ? totalChars / wallSec : 0,
    messagesPerMin: wallSec > 0 ? (ok.length / wallSec) * 60 : 0,
    rssMb: aggregateRssMb(),
    load1: os.loadavg()[0],
  };
}

function printConfig() {
  const allRemoteMessagesWeek =
    CURRENT_USAGE.wau *
    CURRENT_USAGE.lapsPerUserWeek *
    CURRENT_USAGE.messagesPerLap;

  const oneRemoteUserReqPerSec = CURRENT_USAGE.messagesPerLap / CURRENT_USAGE.lapSec;
  const avgChars = averageWeightedChars();

  console.log('GT Coach current-load basis:');
  formatTable([
    {
      wau: CURRENT_USAGE.wau,
      lapsPerUserWeek: CURRENT_USAGE.lapsPerUserWeek,
      messagesPerLap: CURRENT_USAGE.messagesPerLap,
      allRemoteMessagesWeek,
      oneThirdFallbackMessagesWeek: round(allRemoteMessagesWeek / 3, 0),
      tenPctFallbackMessagesWeek: round(allRemoteMessagesWeek * 0.1, 0),
      oneRemoteUserReqPerSec: round(oneRemoteUserReqPerSec, 4),
      oneRemoteUserMessageEverySec: round(1 / oneRemoteUserReqPerSec, 1),
      weightedAvgChars: round(avgChars, 1),
    },
  ]);

  console.log('Benchmark config:');
  formatTable([
    {
      platform: `${os.platform()} ${os.arch()}`,
      cpuCount: os.cpus().length,
      modelId: opts.modelId,
      dtype: opts.dtype,
      device: opts.device,
      workers: opts.workers,
      threadsHint: opts.threads,
      voices: opts.voices.join(','),
      users: opts.users.join(','),
      burstSizes: opts.burstSizes.join(','),
      stageSec: opts.stageSec,
      drainSec: opts.drainSec,
      maxPending: opts.maxPending,
      maxLatePct: opts.maxLatePct,
      cacheDir: opts.cacheDir,
    },
  ]);
}

async function runMicro(pool) {
  if (!opts.micro) return [];

  console.log('Microbench: single-message latency and WAV samples');
  const startIndex = pool.results.length;
  const tiers = ['cue', 'compact', 'full'];

  for (const voice of opts.voices) {
    for (const tier of tiers) {
      const message = firstMessageForTier(tier);
      await pool.submit({
        text: message.text,
        tier: message.tier,
        voice,
        deadlineMs: 30000,
        savePath: path.join(opts.samplesDir, `${voice}-${tier}.wav`),
      });
    }
  }

  const results = pool.results.slice(startIndex);
  formatTable(
    results.map((result) => ({
      voice: result.voice,
      tier: result.tier,
      chars: result.chars,
      latencyMs: round(result.latencyMs, 0),
      genMs: round(result.genMs, 0),
      audioSec: round(result.audioSec, 2),
      rtf: round(result.rtf, 2),
      speedX: round(result.speedX, 2),
      ok: result.ok,
    })),
  );

  console.log(`Samples written to ${opts.samplesDir}`);
  return results;
}

async function runRateStage(pool, users, rng) {
  const startIndex = pool.results.length;
  const rps = users * CURRENT_USAGE.messagesPerLap / CURRENT_USAGE.lapSec;
  const intervalMs = 1000 / rps;

  console.log(`Rate stage: ${users} remote users, ${round(rps, 3)} req/s, ${opts.stageSec}s injection`);

  const startedAt = performance.now();
  let nextAt = startedAt;
  let sent = 0;

  while (performance.now() - startedAt < opts.stageSec * 1000) {
    const now = performance.now();

    while (nextAt <= now && nextAt - startedAt < opts.stageSec * 1000) {
      const message = pickMessage(rng);
      const voice = opts.voices[sent % opts.voices.length];

      pool.submit({
        text: message.text,
        tier: message.tier,
        voice,
        deadlineMs: message.deadlineMs,
      });

      sent++;
      nextAt += intervalMs;
    }

    await sleep(Math.max(5, Math.min(25, nextAt - performance.now())));
  }

  const drained = await pool.waitIdle(opts.drainSec * 1000);
  const doneAt = performance.now();
  const results = pool.results.slice(startIndex);
  const wallSec = (doneAt - startedAt) / 1000;
  const summary = summarize(results, wallSec);
  const sustainable =
    drained &&
    summary.errors === 0 &&
    summary.rejected === 0 &&
    summary.latePct <= opts.maxLatePct;

  const row = {
    users,
    targetRps: rps,
    sent,
    drained,
    sustainable,
    ...summary,
  };

  formatTable([
    {
      users,
      sent,
      ok: row.ok,
      errors: row.errors,
      rejected: row.rejected,
      latePct: round(row.latePct, 1),
      p95LatencyMs: round(row.p95LatencyMs, 0),
      p95QueueMs: round(row.p95QueueMs, 0),
      p95GenMs: round(row.p95GenMs, 0),
      meanRtf: round(row.meanRtf, 2),
      meanSpeedX: round(row.meanSpeedX, 2),
      realtimeX: round(row.realtimeX, 2),
      msgMin: round(row.messagesPerMin, 1),
      rssMb: round(row.rssMb, 0),
      sustainable: sustainable ? 'yes' : 'no',
    },
  ]);

  if (!drained) {
    console.log('Queue did not drain. Stopping further stages.');
  }

  return row;
}

async function runBurst(pool, size) {
  const startIndex = pool.results.length;
  const message = firstMessageForTier('compact');

  console.log(`Burst stage: ${size} simultaneous compact messages`);

  const startedAt = performance.now();

  for (let i = 0; i < size; i++) {
    pool.submit({
      text: message.text,
      tier: message.tier,
      voice: opts.voices[i % opts.voices.length],
      deadlineMs: message.deadlineMs,
    });
  }

  const drained = await pool.waitIdle(opts.drainSec * 1000);
  const doneAt = performance.now();
  const results = pool.results.slice(startIndex);
  const summary = summarize(results, (doneAt - startedAt) / 1000);

  formatTable([
    {
      burst: size,
      ok: summary.ok,
      errors: summary.errors,
      rejected: summary.rejected,
      latePct: round(summary.latePct, 1),
      p95LatencyMs: round(summary.p95LatencyMs, 0),
      p95QueueMs: round(summary.p95QueueMs, 0),
      p95GenMs: round(summary.p95GenMs, 0),
      meanRtf: round(summary.meanRtf, 2),
      drained,
      rssMb: round(summary.rssMb, 0),
    },
  ]);

  return {
    burst: size,
    drained,
    ...summary,
  };
}

async function main() {
  printConfig();

  const pool = new Pool();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = {
    runId,
    createdAt: new Date().toISOString(),
    options: {
      ...opts,
      resultsDir: opts.resultsDir,
      samplesDir: opts.samplesDir,
    },
    assumptions: CURRENT_USAGE,
    sentenceStats: {
      count: messages.length,
      weightedAvgChars: averageWeightedChars(),
      tierWeights: opts.tierWeights,
      deadlinesMs: DEADLINES_MS,
    },
    system: {
      arch: os.arch(),
      platform: os.platform(),
      cpus: os.cpus().map((cpu) => cpu.model),
      cpuCount: os.cpus().length,
      totalMemGb: os.totalmem() / 1024 / 1024 / 1024,
      node: process.version,
    },
    micro: [],
    rateStages: [],
    bursts: [],
  };

  try {
    await pool.init();
    output.micro = await runMicro(pool);

    const rng = makeRng(opts.seed);
    for (const users of opts.users) {
      const row = await runRateStage(pool, users, rng);
      output.rateStages.push(row);

      if (!row.drained) break;
    }

    for (const burst of opts.burstSizes) {
      const row = await runBurst(pool, burst);
      output.bursts.push(row);

      if (!row.drained) break;
    }

    const sustainableUsers = output.rateStages
      .filter((stage) => stage.sustainable)
      .map((stage) => stage.users);

    const maxSustainableUsers =
      sustainableUsers.length > 0 ? Math.max(...sustainableUsers) : 0;

    output.maxSustainableUsers = maxSustainableUsers;

    console.log('Final verdict:');
    console.log(`Max sustainable simulated remote users: ${maxSustainableUsers}`);
    console.log(`Pass criteria: drained=true, errors=0, rejected=0, latePct <= ${opts.maxLatePct}%`);

    const outputPath = path.join(opts.resultsDir, `kokoro-cpu-${runId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`Wrote JSON result: ${outputPath}`);
  } finally {
    await pool.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
