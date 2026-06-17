export function registerKittenModels(registry, models) {
  for (const model of models) {
    registry[model.modelId] ??= { label: model.label };
  }
}

export async function withKittenCacheHome(homeDir, fn) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await fn();
  } finally {
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

export async function prepareKittenNodeRuntime() {
  const ort = await import('onnxruntime-node');
  if (ort.env?.wasm) {
    ort.env.trace = false;
    ort.env.wasm = undefined;
  }
}

export function installKittenPythonCompat(KittenTTS) {
  const marker = Symbol.for('gtCoach.kittenTtsPythonCompat');
  if (KittenTTS.prototype[marker]) return;

  const originalGenerate = KittenTTS.prototype.generate;
  const originalPrepareInputs = KittenTTS.prototype._prepareInputs;

  KittenTTS.prototype.generate = async function generateWithPythonCleanOrder(text, opts = {}) {
    if (opts.clean === false) {
      return originalGenerate.call(this, text, opts);
    }

    const processedText = this._preprocessor.process(String(text ?? ''));
    return originalGenerate.call(this, processedText, { ...opts, clean: false });
  };

  KittenTTS.prototype._prepareInputs = async function prepareInputsWithPythonStyleRef(chunk, voiceName, speed, clean) {
    const prepared = await originalPrepareInputs.call(this, chunk, voiceName, speed, clean);
    const processedText = clean ? this._preprocessor.process(chunk) : chunk;
    const resolvedVoice = this.voiceAliases?.[voiceName] ?? voiceName;
    const voiceEntry = this._voices?.[resolvedVoice];

    if (!voiceEntry?.shape || !voiceEntry?.data) {
      return prepared;
    }

    const [numStyles, styleDim] = voiceEntry.shape;
    const refId = Math.min(Array.from(processedText).length, numStyles - 1);
    prepared.style = voiceEntry.data.slice(refId * styleDim, (refId + 1) * styleDim);
    prepared.styleDim = styleDim;
    return prepared;
  };

  Object.defineProperty(KittenTTS.prototype, marker, { value: true });
}

export function audioStats(audio) {
  if (!audio.length) {
    return {
      min: 0,
      max: 0,
      peak: 0,
      rms: 0,
      clipCount: 0,
      clipPercent: 0,
      nanCount: 0,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let clipCount = 0;
  let nanCount = 0;

  for (const sample of audio) {
    if (!Number.isFinite(sample)) {
      nanCount++;
      continue;
    }
    if (sample < min) min = sample;
    if (sample > max) max = sample;
    sum += sample * sample;
    if (Math.abs(sample) >= 1) clipCount++;
  }

  const peak = Math.max(Math.abs(min), Math.abs(max));
  return {
    min,
    max,
    peak,
    rms: Math.sqrt(sum / audio.length),
    clipCount,
    clipPercent: (clipCount / audio.length) * 100,
    nanCount,
  };
}

export function playbackGainForPeak(peak, targetPeak = 0.98) {
  if (!Number.isFinite(peak) || peak <= 1) return 1;
  return targetPeak / peak;
}

export function applyGain(audio, gain) {
  if (gain === 1) return audio;
  const scaled = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    scaled[i] = audio[i] * gain;
  }
  return scaled;
}
