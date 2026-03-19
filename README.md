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
