import os from "node:os";
import fs from "node:fs";
import { KokoroTTS } from "kokoro-js";

const SAMPLE_RATE = 24000;
const VOICE = "am_adam";
const BENCHMARK_TEXT =
  "Brake earlier into turn 3, you are losing time on entry";

// ── System info ──────────────────────────────────────────────────────
console.log("=== Kokoro TTS CPU Test ===");
console.log(`Platform: ${os.platform()} ${os.arch()}`);
console.log(`CPU:      ${os.cpus()[0].model}`);
console.log(`Node:     ${process.version}`);
console.log();

// ── Load model ───────────────────────────────────────────────────────
console.log("Loading model... (first run downloads ~330MB)");
const loadStart = performance.now();
const model = await KokoroTTS.from_pretrained(
  "onnx-community/Kokoro-82M-v1.0-ONNX",
  {
    dtype: "fp32",
    device: "cpu",
    progress_callback: (progress) => {
      if (progress.status === "progress" && progress.progress != null) {
        process.stdout.write(
          `\r  ${progress.file}: ${progress.progress.toFixed(0)}%`
        );
      } else if (progress.status === "done") {
        process.stdout.write("\n");
      }
    },
  }
);
const loadTime = performance.now() - loadStart;
console.log(`Model loaded in ${Math.round(loadTime)}ms`);
console.log();

// ── Warm-up ──────────────────────────────────────────────────────────
const warmupStart = performance.now();
await model.generate("test", { voice: VOICE });
const warmupTime = performance.now() - warmupStart;
console.log(`Warm-up: ${Math.round(warmupTime)}ms`);

// ── Benchmark ────────────────────────────────────────────────────────
console.log(`Generating: "${BENCHMARK_TEXT}"`);
console.log();

const genStart = performance.now();
const result = await model.generate(BENCHMARK_TEXT, { voice: VOICE });
const genTime = (performance.now() - genStart) / 1000; // seconds

const audio = result.audio;
const samples = audio.length;
const audioDuration = samples / SAMPLE_RATE;
const rtf = audioDuration / genTime;

// RMS energy
let sumSq = 0;
for (let i = 0; i < samples; i++) {
  sumSq += audio[i] * audio[i];
}
const rms = Math.sqrt(sumSq / samples);

console.log("Results:");
console.log(`  Generation: ${Math.round(genTime * 1000)}ms`);
console.log(
  `  Audio:      ${audioDuration.toFixed(2)}s (${samples.toLocaleString()} samples @ ${SAMPLE_RATE / 1000}kHz)`
);
console.log(`  RTF:        ${rtf.toFixed(2)}x (real-time factor)`);
console.log(`  RMS:        ${rms.toFixed(3)}`);
console.log();

// ── Save WAV ─────────────────────────────────────────────────────────
writeWav("output.wav", audio, SAMPLE_RATE);
console.log("Saved: output.wav");
console.log();

// ── Verdict ──────────────────────────────────────────────────────────
if (rtf < 1.0) {
  console.log("❌ FAIL — too slow (RTF < 1.0)");
  process.exit(1);
} else if (rms >= 1.0) {
  console.log("❌ FAIL — corrupted audio (RMS >= 1.0)");
  process.exit(1);
} else {
  console.log("✅ PASS — audio is clean and faster than real-time");
}

// ── WAV writer ───────────────────────────────────────────────────────
function writeWav(path, float32, sampleRate) {
  const numSamples = float32.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert float32 [-1, 1] to int16
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  fs.writeFileSync(path, buffer);
}
