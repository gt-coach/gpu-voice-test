#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}"
NAME="${NAME:-kokoro-bench}"
PORT="${PORT:-8880}"

# Start with 4, then try 8 if Docker Desktop has enough CPU allocated.
CPUS="${CPUS:-4}"
MEMORY="${MEMORY:-6g}"

# GT Coach-ish defaults.
VOICE="${VOICE:-bf_emma}"
FORMAT="${FORMAT:-mp3}" # mp3 | opus | wav | pcm etc.
MODEL="${MODEL:-kokoro}"
SPEED="${SPEED:-1.08}"

# Real-time benchmark by default. Set TIME_SCALE=5 or 10 to compress time.
TIME_SCALE="${TIME_SCALE:-1}"

# Each active GT Coach session gets roughly one coach line every 30s.
# That approximates 2-4 spoken events per lap for ~90-120s laps.
LINE_INTERVAL_SEC="${LINE_INTERVAL_SEC:-30}"

# Duration per paced scenario. 180s gives useful data without being painful.
SCENARIO_SECONDS="${SCENARIO_SECONDS:-180}"

TIMEOUT_MS="${TIMEOUT_MS:-12000}"
RESULTS_DIR="${RESULTS_DIR:-./kokoro-bench-results}"

START_CONTAINER="${START_CONTAINER:-1}"
KEEP_CONTAINER="${KEEP_CONTAINER:-0}"

KOKORO_BASE_URL="${KOKORO_BASE_URL:-http://127.0.0.1:${PORT}}"

# Optional test knobs. Defaults keep the GT Coach-ish workload from the plan.
SEQUENTIAL_REQUESTS="${SEQUENTIAL_REQUESTS:-20}"
BURST_WAVES="${BURST_WAVES:-5}"
BURST_GAP_SEC="${BURST_GAP_SEC:-12}"

BENCH_TMP_DIR=""
CONTAINER_STARTED="0"

cleanup() {
  if [[ -n "${BENCH_TMP_DIR:-}" ]]; then
    rm -rf "$BENCH_TMP_DIR"
  fi

  if [[ "$KEEP_CONTAINER" != "1" && "$CONTAINER_STARTED" == "1" ]]; then
    echo ""
    echo "==> Cleaning up container"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need node
need curl

if [[ "$START_CONTAINER" == "1" ]]; then
  need docker
fi

mkdir -p "$RESULTS_DIR"

if [[ "$START_CONTAINER" == "1" ]]; then
  echo "==> Removing existing container, if any..."
  docker rm -f "$NAME" >/dev/null 2>&1 || true

  echo "==> Starting Kokoro-FastAPI"
  echo "    image=$IMAGE"
  echo "    cpus=$CPUS memory=$MEMORY port=$PORT"

  docker run -d \
    --name "$NAME" \
    --pull missing \
    --cpus "$CPUS" \
    --memory "$MEMORY" \
    --memory-swap "$MEMORY" \
    -p "127.0.0.1:${PORT}:8880" \
    "$IMAGE" >/dev/null
  CONTAINER_STARTED="1"
fi

echo "==> Waiting for Kokoro health endpoint..."
for i in {1..90}; do
  if curl -fsS "${KOKORO_BASE_URL}/health" >/dev/null 2>&1; then
    echo "==> Kokoro is healthy"
    break
  fi

  if [[ "$i" == "90" ]]; then
    echo "Kokoro did not become healthy. Last container logs:" >&2
    if [[ "$START_CONTAINER" == "1" ]]; then
      docker logs --tail 80 "$NAME" >&2 || true
    fi
    exit 1
  fi

  sleep 2
done

BENCH_TMP_DIR="$(mktemp -d -t kokoro-bench)"
BENCH_JS="${BENCH_TMP_DIR}/bench.mjs"

cat > "$BENCH_JS" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";

const env = process.env;

const KOKORO_BASE_URL = env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880";
const ENDPOINT = toSpeechEndpoint(KOKORO_BASE_URL);

const MODEL = env.MODEL ?? "kokoro";
const VOICE = env.VOICE ?? "bf_emma";
const FORMAT = env.FORMAT ?? "mp3";
const SPEED = Number(env.SPEED ?? "1.08");

const TIME_SCALE = Number(env.TIME_SCALE ?? "1");
const LINE_INTERVAL_SEC = Number(env.LINE_INTERVAL_SEC ?? "30");
const SCENARIO_SECONDS = Number(env.SCENARIO_SECONDS ?? "180");
const TIMEOUT_MS = Number(env.TIMEOUT_MS ?? "12000");
const RESULTS_DIR = env.RESULTS_DIR ?? "./kokoro-bench-results";

const TARGET_P95_MS = Number(env.TARGET_P95_MS ?? "2500");
const TARGET_ERROR_PCT = Number(env.TARGET_ERROR_PCT ?? "1");
const SEQUENTIAL_REQUESTS = Number(env.SEQUENTIAL_REQUESTS ?? "20");
const BURST_WAVES = Number(env.BURST_WAVES ?? "5");
const BURST_GAP_SEC = Number(env.BURST_GAP_SEC ?? "12");

const runId = new Date().toISOString().replace(/[:.]/g, "-");

const scenarios = [
  {
    name: "latency-sequential-20",
    mode: "sequential",
    requests: SEQUENTIAL_REQUESTS,
    targetP95Ms: 1500,
  },
  {
    name: "current-typical-1-active-session",
    mode: "paced",
    vus: 1,
    simDurationSec: SCENARIO_SECONDS,
    lineIntervalSec: LINE_INTERVAL_SEC,
    targetP95Ms: 2000,
  },
  {
    name: "current-busy-2-active-sessions",
    mode: "paced",
    vus: 2,
    simDurationSec: SCENARIO_SECONDS,
    lineIntervalSec: LINE_INTERVAL_SEC,
    targetP95Ms: 2500,
  },
  {
    name: "paid-launch-4-active-sessions",
    mode: "paced",
    vus: 4,
    simDurationSec: SCENARIO_SECONDS,
    lineIntervalSec: LINE_INTERVAL_SEC,
    targetP95Ms: 3000,
  },
  {
    name: "stress-8-active-sessions",
    mode: "paced",
    vus: 8,
    simDurationSec: Math.max(90, Math.floor(SCENARIO_SECONDS * 0.75)),
    lineIntervalSec: LINE_INTERVAL_SEC,
    targetP95Ms: 4000,
  },
  {
    name: "burst-4-simultaneous-lines",
    mode: "burst",
    concurrency: 4,
    waves: BURST_WAVES,
    gapSec: BURST_GAP_SEC,
    targetP95Ms: 3000,
  },
  {
    name: "burst-8-simultaneous-lines",
    mode: "burst",
    concurrency: 8,
    waves: BURST_WAVES,
    gapSec: BURST_GAP_SEC,
    targetP95Ms: null,
  },
];

const raw = [];
const summaries = [];

console.log("");
console.log("Kokoro GT Coach local benchmark");
console.log("--------------------------------");
console.log(`endpoint:      ${ENDPOINT}`);
console.log(`voice:         ${VOICE}`);
console.log(`format:        ${FORMAT}`);
console.log(`speed:         ${SPEED}`);
console.log(`time scale:    ${TIME_SCALE}x`);
console.log(`line interval: ${LINE_INTERVAL_SEC}s simulated`);
console.log("target p95:    scenario-specific");
console.log("");

for (const scenario of scenarios) {
  console.log(`==> Scenario: ${scenario.name}`);

  const started = performance.now();
  let results;

  if (scenario.mode === "sequential") {
    results = await runSequential(scenario);
  } else if (scenario.mode === "paced") {
    results = await runPaced(scenario);
  } else if (scenario.mode === "burst") {
    results = await runBurst(scenario);
  } else {
    throw new Error(`Unknown scenario mode: ${scenario.mode}`);
  }

  const ended = performance.now();
  const summary = summarizeScenario(scenario, results, (ended - started) / 1000);

  summaries.push(summary);
  raw.push(...results);

  printSummary(summary);
  console.log("");
}

mkdirSync(RESULTS_DIR, { recursive: true });

const meta = {
  runId,
  createdAt: new Date().toISOString(),
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemGb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
  },
  endpoint: ENDPOINT,
  model: MODEL,
  voice: VOICE,
  format: FORMAT,
  speed: SPEED,
  timeScale: TIME_SCALE,
  lineIntervalSec: LINE_INTERVAL_SEC,
  defaultTargetP95Ms: TARGET_P95_MS,
  targetErrorPct: TARGET_ERROR_PCT,
  sequentialRequests: SEQUENTIAL_REQUESTS,
  burstWaves: BURST_WAVES,
  burstGapSec: BURST_GAP_SEC,
};

const summaryPath = `${RESULTS_DIR}/summary-${runId}.csv`;
const rawPath = `${RESULTS_DIR}/raw-${runId}.csv`;
const jsonPath = `${RESULTS_DIR}/result-${runId}.json`;

writeFileSync(summaryPath, toCsv(summaries));
writeFileSync(rawPath, toCsv(raw));
writeFileSync(jsonPath, JSON.stringify({ meta, summaries, raw }, null, 2));

console.log("Final summary");
console.log("-------------");
printMarkdownTable(summaries);
console.log("");
console.log(`Wrote: ${summaryPath}`);
console.log(`Wrote: ${rawPath}`);
console.log(`Wrote: ${jsonPath}`);
console.log("");

const important = summaries.filter((s) =>
  [
    "current-busy-2-active-sessions",
    "paid-launch-4-active-sessions",
    "burst-4-simultaneous-lines",
  ].includes(s.scenario)
);

const failed = important.filter((s) => s.verdict !== "PASS");

if (failed.length === 0) {
  console.log("Verdict: OK for the current GT Coach envelope.");
  console.log("Next: test CPUS=8 and compare p95/p99 before thinking about GCP sizing.");
} else {
  console.log("Verdict: NOT safe enough yet for live GT Coach remote TTS.");
  console.log("Likely next steps: more CPU, bounded worker pool, lower concurrency, shorter text, or managed fallback.");
}

function toSpeechEndpoint(base) {
  const clean = base.replace(/\/+$/, "");
  if (clean.endsWith("/v1/audio/speech")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/audio/speech`;
  return `${clean}/v1/audio/speech`;
}

async function runSequential(scenario) {
  const results = [];
  for (let i = 0; i < scenario.requests; i++) {
    results.push(await requestTts({
      scenario: scenario.name,
      virtualUser: 0,
      requestInScenario: i,
      text: makeCoachPhrase(i),
    }));
  }
  return results;
}

async function runPaced(scenario) {
  const results = [];
  const wallDurationMs = (scenario.simDurationSec / TIME_SCALE) * 1000;
  const start = performance.now();
  const end = start + wallDurationMs;

  await Promise.all(
    Array.from({ length: scenario.vus }, (_, vu) => pacedVirtualUser({
      scenario,
      vu,
      end,
      results,
    })),
  );

  return results;
}

async function pacedVirtualUser({ scenario, vu, end, results }) {
  let i = 0;
  const intervalMs = (scenario.lineIntervalSec / TIME_SCALE) * 1000;
  const remainingMs = Math.max(0, end - performance.now());

  // Stagger users so we don't create an artificial synchronized stampede.
  let nextAt =
    performance.now() +
    Math.random() * Math.min(intervalMs, remainingMs / 2);

  while (performance.now() < end) {
    await sleep(Math.max(0, nextAt - performance.now()));

    if (performance.now() >= end) break;

    results.push(await requestTts({
      scenario: scenario.name,
      virtualUser: vu,
      requestInScenario: i,
      text: makeCoachPhrase(i + vu * 1000),
    }));

    i += 1;

    const jitter = 0.65 + Math.random() * 0.7;
    nextAt += intervalMs * jitter;
  }
}

async function runBurst(scenario) {
  const results = [];

  for (let wave = 0; wave < scenario.waves; wave++) {
    const waveResults = await Promise.all(
      Array.from({ length: scenario.concurrency }, (_, i) => requestTts({
        scenario: scenario.name,
        virtualUser: i,
        requestInScenario: wave,
        text: makeCoachPhrase(wave * 100 + i),
      })),
    );

    results.push(...waveResults);

    if (wave !== scenario.waves - 1) {
      await sleep((scenario.gapSec / TIME_SCALE) * 1000);
    }
  }

  return results;
}

async function requestTts({ scenario, virtualUser, requestInScenario, text }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let status = 0;
  let headersMs = null;
  let firstByteMs = null;
  let bytes = 0;
  let error = "";

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer not-needed",
      },
      body: JSON.stringify({
        model: MODEL,
        input: text,
        voice: VOICE,
        response_format: FORMAT,
        speed: SPEED,
      }),
      signal: controller.signal,
    });

    headersMs = performance.now() - startedAt;
    status = response.status;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
    }

    if (!response.body) {
      const ab = await response.arrayBuffer();
      bytes = ab.byteLength;
      firstByteMs = performance.now() - startedAt;
    } else {
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (firstByteMs === null) {
          firstByteMs = performance.now() - startedAt;
        }

        bytes += value.byteLength;
      }
    }

    return {
      ok: true,
      scenario,
      virtual_user: virtualUser,
      request_in_scenario: requestInScenario,
      status,
      chars: text.length,
      bytes,
      headers_ms: round(headersMs),
      first_byte_ms: round(firstByteMs ?? headersMs),
      total_ms: round(performance.now() - startedAt),
      error,
      text,
    };
  } catch (e) {
    error = e?.name === "AbortError"
      ? `timeout_after_${TIMEOUT_MS}ms`
      : String(e?.message ?? e);

    return {
      ok: false,
      scenario,
      virtual_user: virtualUser,
      request_in_scenario: requestInScenario,
      status,
      chars: text.length,
      bytes,
      headers_ms: round(headersMs ?? 0),
      first_byte_ms: round(firstByteMs ?? 0),
      total_ms: round(performance.now() - startedAt),
      error,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function makeCoachPhrase(seed) {
  const corner = 1 + ((seed * 7 + randInt(0, 5)) % 16);
  const speed = 75 + ((seed * 13 + randInt(0, 90)) % 210);
  const delta = (0.08 + ((seed * 17 + randInt(0, 70)) % 90) / 100).toFixed(2);
  const gear = 2 + ((seed * 5 + randInt(0, 4)) % 5);

  const templates = [
    `Corner ${corner}, brake a touch earlier, around ${speed} kph, then release smoothly before turn in.`,
    `Good exit from corner ${corner}. You gained ${delta} seconds by opening the steering before full throttle.`,
    `Corner ${corner}, you are carrying too much brake past the apex. Release earlier and let the car rotate.`,
    `Next lap for corner ${corner}, stay in gear ${gear} and squeeze the throttle once the car is straight.`,
    `You lost ${delta} seconds on corner ${corner}. Prioritise the exit and avoid pinching the car at apex.`,
    `Corner ${corner}, use more road on entry, then commit to throttle earlier once you can unwind the wheel.`,
    `Nice improvement through corner ${corner}. Keep that brake timing and focus on a cleaner throttle pickup.`,
    `For corner ${corner}, delay the downshift to gear ${gear} slightly and avoid unsettling the car on entry.`,
    `Corner ${corner}, your minimum speed is too low. Carry a little more speed and trust the rotation.`,
    `Next lap, focus on corner ${corner}. Brake once, release cleanly, then get back to power without hesitation.`,
  ];

  return templates[seed % templates.length];
}

function summarizeScenario(scenario, results, wallSeconds) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const totalMs = ok.map((r) => r.total_ms).sort((a, b) => a - b);
  const firstByteMs = ok.map((r) => r.first_byte_ms).sort((a, b) => a - b);

  const requests = results.length;
  const errors = failed.length;
  const errorPct = requests === 0 ? 0 : (errors / requests) * 100;
  const p95 = percentile(totalMs, 0.95);
  const targetP95Ms = scenario.targetP95Ms === undefined
    ? TARGET_P95_MS
    : scenario.targetP95Ms;
  const verdict = targetP95Ms === null
    ? "INFO"
    : errorPct <= TARGET_ERROR_PCT && p95 <= targetP95Ms
      ? "PASS"
      : "FAIL";

  return {
    scenario: scenario.name,
    mode: scenario.mode,
    vus: scenario.vus ?? "",
    burst_concurrency: scenario.concurrency ?? "",
    time_scale: TIME_SCALE,
    simulated_seconds: scenario.simDurationSec ?? "",
    wall_seconds: round(wallSeconds),
    requests,
    ok: ok.length,
    errors,
    error_pct: round(errorPct),
    target_p95_ms: targetP95Ms ?? "",
    rps: round(requests / Math.max(0.001, wallSeconds)),
    chars_total: sum(ok.map((r) => r.chars)),
    bytes_total: sum(ok.map((r) => r.bytes)),
    avg_ms: round(avg(totalMs)),
    p50_ms: round(percentile(totalMs, 0.50)),
    p90_ms: round(percentile(totalMs, 0.90)),
    p95_ms: round(p95),
    p99_ms: round(percentile(totalMs, 0.99)),
    max_ms: round(totalMs.at(-1) ?? 0),
    first_byte_p50_ms: round(percentile(firstByteMs, 0.50)),
    first_byte_p95_ms: round(percentile(firstByteMs, 0.95)),
    verdict,
  };
}

function printSummary(s) {
  console.log(
    [
      `requests=${s.requests}`,
      `errors=${s.errors} (${s.error_pct}%)`,
      `rps=${s.rps}`,
      `p50=${s.p50_ms}ms`,
      `p95=${s.p95_ms}ms`,
      `p99=${s.p99_ms}ms`,
      `max=${s.max_ms}ms`,
      `verdict=${s.verdict}`,
    ].join(" | "),
  );
}

function printMarkdownTable(rows) {
  const cols = [
    "scenario",
    "requests",
    "errors",
    "rps",
    "target_p95_ms",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "max_ms",
    "verdict",
  ];

  console.log(`| ${cols.join(" | ")} |`);
  console.log(`| ${cols.map(() => "---").join(" | ")} |`);

  for (const row of rows) {
    console.log(`| ${cols.map((c) => row[c]).join(" | ")} |`);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function avg(values) {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values) {
  return values.reduce((acc, v) => acc + Number(v || 0), 0);
}

function round(n) {
  return Number(Number(n || 0).toFixed(2));
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(row[col])).join(","));
  }

  return lines.join("\n");
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[,"\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}
NODE

echo "==> Running benchmark"
KOKORO_BASE_URL="$KOKORO_BASE_URL" \
MODEL="$MODEL" \
VOICE="$VOICE" \
FORMAT="$FORMAT" \
SPEED="$SPEED" \
TIME_SCALE="$TIME_SCALE" \
LINE_INTERVAL_SEC="$LINE_INTERVAL_SEC" \
SCENARIO_SECONDS="$SCENARIO_SECONDS" \
TIMEOUT_MS="$TIMEOUT_MS" \
RESULTS_DIR="$RESULTS_DIR" \
SEQUENTIAL_REQUESTS="$SEQUENTIAL_REQUESTS" \
BURST_WAVES="$BURST_WAVES" \
BURST_GAP_SEC="$BURST_GAP_SEC" \
node "$BENCH_JS"

if [[ "$START_CONTAINER" == "1" ]]; then
  echo ""
  echo "==> Docker stats snapshot"
  docker stats --no-stream "$NAME" || true
fi
