import os from "node:os";
import { KokoroTTS } from "kokoro-js";

const SAMPLE_RATE = 24000;
const VOICE = "am_adam";
const BENCHMARK_TEXT =
  "Brake earlier into turn 3, you are losing time on entry";
const DTYPES = ["fp32", "fp16", "q8", "q4", "q4f16"];
const RUNS = 5;

console.log("=== Kokoro TTS Benchmark ===");
console.log(`Platform: ${os.platform()} ${os.arch()}`);
console.log(`CPU:      ${os.cpus()[0].model}`);
console.log(`Node:     ${process.version}`);
console.log(`Runs:     ${RUNS} per dtype`);
console.log(`Phrase:   "${BENCHMARK_TEXT}"`);
console.log();

const results = [];

for (const dtype of DTYPES) {
  process.stdout.write(`[${dtype}] Loading model...`);
  let model;
  try {
    const loadStart = performance.now();
    model = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      {
        dtype,
        device: "cpu",
        progress_callback: (progress) => {
          if (progress.status === "progress" && progress.progress != null) {
            process.stdout.write(
              `\r[${dtype}] Loading model... ${progress.progress.toFixed(0)}%`
            );
          }
        },
      }
    );
    const loadTime = performance.now() - loadStart;
    process.stdout.write(`\r[${dtype}] Model loaded in ${Math.round(loadTime)}ms\n`);
  } catch (e) {
    console.log(`\r[${dtype}] SKIPPED — ${e.message}`);
    results.push({ dtype, skipped: true });
    continue;
  }

  // Warm-up
  await model.generate("test", { voice: VOICE });

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const result = await model.generate(BENCHMARK_TEXT, { voice: VOICE });
    const genMs = performance.now() - start;
    const audio = result.audio;
    const audioDur = audio.length / SAMPLE_RATE;
    let sumSq = 0;
    for (let j = 0; j < audio.length; j++) sumSq += audio[j] * audio[j];
    const rms = Math.sqrt(sumSq / audio.length);
    runs.push({ genMs, audioDur, rms, samples: audio.length });
    process.stdout.write(`\r[${dtype}] Run ${i + 1}/${RUNS}: ${Math.round(genMs)}ms`);
  }
  console.log();

  const avgGenMs = runs.reduce((s, r) => s + r.genMs, 0) / RUNS;
  const avgAudioDur = runs.reduce((s, r) => s + r.audioDur, 0) / RUNS;
  const avgRms = runs.reduce((s, r) => s + r.rms, 0) / RUNS;
  const avgRtf = avgAudioDur / (avgGenMs / 1000);
  const minGenMs = Math.min(...runs.map((r) => r.genMs));
  const maxGenMs = Math.max(...runs.map((r) => r.genMs));

  results.push({
    dtype,
    skipped: false,
    avgGenMs,
    avgAudioDur,
    avgRtf,
    avgRms,
    minGenMs,
    maxGenMs,
  });
}

// ── Results table ────────────────────────────────────────────────────
console.log();
console.log("=== Results ===");
console.log();
console.log(
  "Dtype    │ Avg Gen (ms) │ Min/Max (ms) │   RTF   │  RMS   │ Status"
);
console.log(
  "─────────┼──────────────┼──────────────┼─────────┼────────┼────────"
);

let best = null;

for (const r of results) {
  if (r.skipped) {
    console.log(`${r.dtype.padEnd(8)} │     —        │      —       │    —    │   —    │ SKIPPED`);
    continue;
  }

  const pass = r.avgRtf >= 1.0 && r.avgRms < 1.0;
  const status = !pass
    ? r.avgRms >= 1.0
      ? "CORRUPT"
      : "SLOW"
    : "PASS";

  console.log(
    `${r.dtype.padEnd(8)} │ ${Math.round(r.avgGenMs).toString().padStart(8)}    │ ${Math.round(r.minGenMs).toString().padStart(5)}/${Math.round(r.maxGenMs).toString().padStart(5)} │ ${r.avgRtf.toFixed(2).padStart(6)}x │ ${r.avgRms.toFixed(3).padStart(6)} │ ${status}`
  );

  if (pass && (best === null || r.avgRtf > best.avgRtf)) {
    best = r;
  }
}

console.log();
if (best) {
  console.log(`✅ Best: ${best.dtype} — ${best.avgRtf.toFixed(2)}x RTF, RMS ${best.avgRms.toFixed(3)}`);
} else {
  console.log("❌ No dtype passed (RTF >= 1.0 and RMS < 1.0)");
}
