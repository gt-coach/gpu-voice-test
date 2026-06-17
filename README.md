# GPU Voice Compatibility Test

A browser-based diagnostic tool that checks whether your GPU can correctly run the Kokoro TTS voice engine used by [GT Coach](https://gtcoach.app).

**Live page: https://gt-coach.github.io/gpu-voice-test**

## What it does

Some GPUs (notably AMD RDNA 3.5 integrated GPUs) produce corrupted audio when running TTS models via WebGPU. This tool:

1. Generates a test phrase using your GPU (WebGPU)
2. Generates the same phrase using your CPU (WASM) as a reference
3. Compares the two outputs using cross-correlation
4. Reports whether your GPU produces correct audio

## Requirements

- Chrome or Edge (WebGPU support required)
- ~330MB model download on first run (cached afterwards)
- ~30–60 seconds to complete the test

## CLI Test (Node.js / CPU)

Tests Kokoro TTS using native CPU inference via onnxruntime-node. Use this on machines without a browser (servers, SSH).

### Setup

```bash
pnpm install
```

### Run

```bash
pnpm test:cpu
```

This will:
- Download the Kokoro model (~330MB, cached after first run)
- Generate a test phrase on CPU
- Save output.wav for manual listening
- Report RTF (speed) and RMS (audio quality)

### Requirements

- Node.js 18+
- ~330MB disk space for model cache
- Works on macOS (arm64/x64), Windows (x64), Linux (x64/arm64)

## KittenTTS Benchmark

This branch includes a local benchmark for KittenTTS Micro 40M, Nano 15M fp32, and Nano 15M int8.

```bash
pnpm install
pnpm serve
```

Open `http://localhost:3000/kitten-benchmark.html` to generate and compare playable samples.

For repeatable CLI results:

```bash
pnpm bench:kitten
```

The CLI writes JSON/CSV reports to `kitten-results/` and WAV samples to `kitten-samples/`.
