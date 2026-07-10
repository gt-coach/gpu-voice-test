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

export function createOnnxCpuSessionOptions(numThreads, scope = 'onnxruntime-node session intraOpNumThreads') {
  const sessionOptions = {
    executionProviders: ['cpu'],
  };

  if (numThreads === 'auto' || numThreads == null) {
    return {
      sessionOptions,
      threading: {
        supported: true,
        requested: 'auto',
        applied: 'auto',
        scope: 'onnxruntime-node default CPU thread pools',
        sessionOptions,
      },
    };
  }

  const parsed = Number.parseInt(numThreads, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ONNX Runtime thread count: ${numThreads}`);
  }

  const threads = Math.min(16, parsed);
  const appliedOptions = {
    ...sessionOptions,
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
  };

  return {
    sessionOptions: appliedOptions,
    threading: {
      supported: true,
      requested: threads,
      applied: threads,
      scope,
      sessionOptions: appliedOptions,
    },
  };
}

export function createKittenSessionOptions(numThreads) {
  return createOnnxCpuSessionOptions(numThreads, 'onnxruntime-node session intraOpNumThreads');
}

export function installKittenNodeThreadedLoader(KittenTTS, { downloadModel, loadNpz }) {
  const marker = Symbol.for('gtCoach.kittenTtsNodeThreadedLoader');
  if (KittenTTS[marker]) return;

  const originalFromPretrained = KittenTTS.from_pretrained.bind(KittenTTS);

  KittenTTS.from_pretrained = async function fromPretrainedWithNodeThreading(modelId, opts = {}) {
    if (!downloadModel || !loadNpz || typeof process === 'undefined' || !process.versions?.node) {
      return originalFromPretrained(modelId, opts);
    }

    const { modelBuffer, voicesBuffer, config } = await downloadModel(modelId, opts);
    const ort = await import('onnxruntime-node');
    const { sessionOptions, threading } = createKittenSessionOptions(opts.numThreads);
    const session = await ort.InferenceSession.create(modelBuffer, sessionOptions);
    const voices = await loadNpz(voicesBuffer);
    const model = new KittenTTS(session, voices, config);

    model.runtime = 'cpu';
    model.runtimeRequested = opts.runtime || 'cpu';
    model.executionProviders = sessionOptions.executionProviders;
    model.threading = threading;
    return model;
  };

  Object.defineProperty(KittenTTS, marker, { value: true });
}

// The preprocessor's number regex is /(?<![a-zA-Z])-?[\d,]+(?:\.\d+)?/g. The comma sits
// in the character class to catch thousands separators like "1,000", but it also eats the
// comma in "Corner 14, brake earlier" — which loses its pause (3.89s spoken, vs 4.42s
// with the comma). Worse, `[\d,]+` matches a *lone* comma too, and parseInt('') is NaN,
// so number_to_words returns '' and the comma disappears entirely. A bare "earlier,"
// only survives because the (?<![a-zA-Z]) lookbehind sees the preceding letter.
//
// So we can't just detach the comma with a space — that exposes it to the same deletion.
// Swap it for a letters-only sentinel that the number pass can't match and the
// punctuation pass won't strip, then swap it back before phonemization.
//
// The sentinel is space-padded: glued directly to a following digit ("14<S>11") its
// trailing letter would trip the (?<![a-zA-Z]) lookbehind and leave that number
// unexpanded. The padding is undone when the comma is re-attached.
//
// Known limitation, inherited from the library: "Corner 14,111" (no space) still reads
// as one number, fourteen thousand one hundred eleven.
const COMMA_SENTINEL = 'zzcommazz';

export function protectCommasFromNumberExpansion(text) {
  return text.replace(/(\d),(?!\d{3}(?!\d))/g, `$1 ${COMMA_SENTINEL} `);
}

export function restoreProtectedCommas(text) {
  return text.replaceAll(COMMA_SENTINEL, ',').replace(/\s+([,.;:!?])/g, '$1');
}

export function preprocessKittenText(preprocessor, text) {
  const protectedText = protectCommasFromNumberExpansion(String(text ?? ''));
  return restoreProtectedCommas(preprocessor.process(protectedText));
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

    const processedText = preprocessKittenText(this._preprocessor, text);
    return originalGenerate.call(this, processedText, { ...opts, clean: false });
  };

  KittenTTS.prototype._prepareInputs = async function prepareInputsWithPythonStyleRef(chunk, voiceName, speed, clean) {
    const prepared = await originalPrepareInputs.call(this, chunk, voiceName, speed, clean);
    const processedText = clean ? preprocessKittenText(this._preprocessor, chunk) : chunk;
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
