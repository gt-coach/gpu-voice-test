# Kokoro CPU Load Benchmark

This is a tiny CPU-only benchmark for the GT Coach Kokoro fallback question:

> Can a small constrained machine generate enough Kokoro speech for weak-PC fallback and early remote users?

It reuses the existing `sentences.mjs` cue, compact, and full coaching samples. It does not start a production TTS service; it only measures queueing, latency, throughput, memory, and sample audio quality.

## What It Simulates

The default load model matches the current planning assumptions:

- 75 weekly active users
- 33 laps per active user per week
- 5 coach messages per lap
- 90 seconds per lap
- 1 remote user is about 0.056 requests per second

The benchmark runs:

- Microbench: one cue, one compact, and one full message per selected voice, saved as WAV samples.
- Rate stages: default `1,2,3,4,6,8` simulated remote users.
- Burst stages: default `1,2,4,8` simultaneous compact messages.

The verdict is `Max sustainable simulated remote users`.

`--threads=auto` is the default. In auto mode the benchmark does not set native thread environment variables, so Kokoro/ONNX can use its normal CPU threading behavior. Use `--threads=1` only when you intentionally want a strict thread-constrained comparison.

## Local Node Run

From the repo root:

```bash
node kokoro-cpu-bench/bench.mjs \
  --workers=1 \
  --dtype=q8 \
  --users=1,2,3,4 \
  --bursts=1,2,4 \
  --stageSec=120 \
  --drainSec=60
```

Or through the package script:

```bash
npm run bench:kokoro-cpu -- \
  --workers=1 \
  --dtype=q8 \
  --users=1,2,3,4 \
  --bursts=1,2,4 \
  --stageSec=120 \
  --drainSec=60
```

Results are written to `results/`. Sample WAVs are written to `samples/`. Model files are cached in `.cache/`; override that with `--cacheDir=/path/to/cache`.

For a quick smoke test:

```bash
node kokoro-cpu-bench/bench.mjs \
  --workers=1 \
  --dtype=q8 \
  --voices=af_heart \
  --users=1 \
  --bursts=1 \
  --stageSec=10 \
  --drainSec=30
```

## Docker Build

Build an ARM64 image on Apple Silicon:

```bash
docker buildx build \
  --platform linux/arm64 \
  -t kokoro-cpu-bench \
  -f kokoro-cpu-bench/Dockerfile \
  . \
  --load
```

Build an AMD64 image if needed:

```bash
docker buildx build \
  --platform linux/amd64 \
  -t kokoro-cpu-bench \
  -f kokoro-cpu-bench/Dockerfile \
  . \
  --load
```

## Simulate GCP Machine Sizes On Mac

Docker CPU limits are not a perfect substitute for GCP ARM/Axion performance, but they are useful for validating the harness and comparing worker shapes.

Simulate `n4a-standard-1` shape:

```bash
mkdir -p kokoro-results kokoro-samples kokoro-cache

docker run --rm \
  --platform linux/arm64 \
  --cpus=1 \
  --memory=4g \
  -v "$PWD/kokoro-results:/app/results" \
  -v "$PWD/kokoro-samples:/app/samples" \
  -v "$PWD/kokoro-cache:/app/.cache" \
  kokoro-cpu-bench \
  --workers=1 \
  --threads=auto \
  --dtype=q8 \
  --users=1,2,3,4 \
  --bursts=1,2,4 \
  --stageSec=120 \
  --drainSec=60
```

Simulate `n4a-standard-2` with two parallel Kokoro workers and default ONNX threading:

```bash
mkdir -p kokoro-results kokoro-samples kokoro-cache

docker run --rm \
  --platform linux/arm64 \
  --cpus=2 \
  --memory=8g \
  -v "$PWD/kokoro-results:/app/results" \
  -v "$PWD/kokoro-samples:/app/samples" \
  -v "$PWD/kokoro-cache:/app/.cache" \
  kokoro-cpu-bench \
  --workers=2 \
  --threads=auto \
  --dtype=q8 \
  --users=1,2,3,4,6,8 \
  --bursts=1,2,4,8 \
  --stageSec=120 \
  --drainSec=60
```

Simulate `n4a-standard-2` with one Kokoro worker and default ONNX threading:

```bash
mkdir -p kokoro-results kokoro-samples kokoro-cache

docker run --rm \
  --platform linux/arm64 \
  --cpus=2 \
  --memory=8g \
  -v "$PWD/kokoro-results:/app/results" \
  -v "$PWD/kokoro-samples:/app/samples" \
  -v "$PWD/kokoro-cache:/app/.cache" \
  kokoro-cpu-bench \
  --workers=1 \
  --threads=auto \
  --dtype=q8 \
  --users=1,2,3,4,6,8 \
  --bursts=1,2,4,8 \
  --stageSec=120 \
  --drainSec=60
```

Optional strict comparison: add `--threads=1` to set common native thread environment hints before Kokoro loads. Docker `--cpus` and the worker count are the constraints to trust most; `--threads=auto` is the realistic default.

## GCP Run Shape

On a short-lived Ubuntu 24.04 ARM64 `n4a-standard-1` or `n4a-standard-2` VM:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"
newgrp docker
```

Then build or pull the same image and run the matching command above without Docker Desktop-specific assumptions.

Recommended real candidate run:

```bash
docker run --rm \
  --cpus=2 \
  --memory=8g \
  -v "$PWD/kokoro-results:/app/results" \
  -v "$PWD/kokoro-samples:/app/samples" \
  -v "$PWD/kokoro-cache:/app/.cache" \
  kokoro-cpu-bench \
  --workers=2 \
  --threads=auto \
  --dtype=q8 \
  --users=1,2,3,4,6,8 \
  --bursts=1,2,4,8 \
  --stageSec=120 \
  --drainSec=60
```

## How To Read Results

Primary verdict:

```text
Max sustainable simulated remote users
```

Sustainable means:

- The queue drained before `--drainSec`.
- There were no generation errors.
- No jobs were rejected by `--maxPending`.
- `latePct <= --maxLatePct`, default 10 percent.

Important metrics:

- `latePct`: percentage of messages missing the cue, compact, or full deadline.
- `p95LatencyMs`: queue time plus generation time.
- `p95QueueMs`: saturation signal; this should not grow badly stage by stage.
- `p95GenMs`: raw Kokoro generation time.
- `meanRtf`: generation seconds divided by audio seconds. Lower is better; `<1.0` is faster than realtime.
- `meanSpeedX`: audio seconds divided by generation seconds. Higher is better.
- `realtimeX`: aggregate generated audio seconds per wall-clock second.
- `rssMb`: Node process memory use.

Listen to the WAVs in `samples/` or `kokoro-samples/` before making the product decision.

## Decision Rule

Do not pursue tiny self-hosted Kokoro just because the benchmark runs. For the current product, it becomes interesting only if the real GCP result is roughly:

```text
n4a-standard-2
workers=2
threads=auto
dtype=q8

max sustainable users >= 4
latePct <= 10%
p95LatencyMs not obviously bad
samples sound acceptable
```

If `n4a-standard-2` cannot sustain 3-4 users, managed fallback or a larger host is likely the better engineering tradeoff.
