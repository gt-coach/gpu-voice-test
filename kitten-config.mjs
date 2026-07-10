export const KITTEN_SAMPLE_RATE = 24000;

export const KITTEN_DEFAULT_TEXT = 'Corner 14, brake one beat earlier. You are losing time on entry.';
export const KITTEN_DEFAULT_VOICE = 'Bruno';

export const KITTEN_MODELS = [
  {
    id: 'mini',
    modelId: 'KittenML/kitten-tts-mini-0.8',
    label: 'Mini 80M',
    size: '~80 MB',
    role: 'Best quality reference',
  },
  {
    id: 'micro',
    modelId: 'KittenML/kitten-tts-micro-0.8',
    label: 'Micro 40M',
    size: '~41 MB',
    role: 'Default candidate',
  },
  {
    id: 'nano-fp32',
    modelId: 'KittenML/kitten-tts-nano-0.8-fp32',
    label: 'Nano 15M fp32',
    size: '~56 MB',
    role: 'Low-end fallback',
  },
  {
    id: 'nano-int8',
    modelId: 'KittenML/kitten-tts-nano-0.8-int8',
    label: 'Nano 15M int8',
    size: '~25 MB',
    role: 'Emergency low-end candidate',
    note: 'Upstream docs mention some reported issues with this int8 model.',
  },
];

export const KOKORO_MODELS = [
  {
    id: 'kokoro-webgpu',
    family: 'kokoro',
    backend: 'webgpu',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    label: 'Kokoro 82M WebGPU',
    size: '~330 MB',
    role: 'GT Coach enhanced voice GPU path',
    voice: 'am_adam',
  },
  {
    id: 'kokoro-wasm',
    family: 'kokoro',
    backend: 'wasm',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    label: 'Kokoro 82M WASM',
    size: '~330 MB',
    role: 'GT Coach browser CPU reference',
    voice: 'am_adam',
  },
  {
    id: 'kokoro-node-cpu',
    family: 'kokoro',
    backend: 'node-cpu',
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    label: 'Kokoro 82M Node CPU',
    size: '~330 MB',
    role: 'GT Coach local server CPU path',
    voice: 'am_adam',
  },
];

export const SUPERTONIC_MODELS = [
  {
    id: 'supertonic-node-cpu',
    family: 'supertonic',
    backend: 'node-cpu',
    modelId: 'Supertone/supertonic-3',
    label: 'Supertonic 3 Node CPU',
    size: '~415 MB',
    role: 'Multilingual candidate',
    note: 'Code MIT; model OpenRAIL. English-only benchmark path for now.',
  },
];

export const KITTEN_VOICES = [
  { id: 'Bella', label: 'Bella', gender: 'Female' },
  { id: 'Jasper', label: 'Jasper', gender: 'Male' },
  { id: 'Luna', label: 'Luna', gender: 'Female' },
  { id: 'Bruno', label: 'Bruno', gender: 'Male' },
  { id: 'Rosie', label: 'Rosie', gender: 'Female' },
  { id: 'Hugo', label: 'Hugo', gender: 'Male' },
  { id: 'Kiki', label: 'Kiki', gender: 'Female' },
  { id: 'Leo', label: 'Leo', gender: 'Male' },
];

export const KOKORO_VOICES = [
  { id: 'am_adam', label: 'Adam', gender: 'Male' },
  { id: 'am_michael', label: 'Michael', gender: 'Male' },
  { id: 'af_heart', label: 'Heart', gender: 'Female' },
  { id: 'af_bella', label: 'Bella', gender: 'Female' },
  { id: 'af_nova', label: 'Nova', gender: 'Female' },
];

export const SUPERTONIC_VOICES = [
  { id: 'M1', label: 'M1', gender: 'Male' },
  { id: 'M2', label: 'M2', gender: 'Male' },
  { id: 'M3', label: 'M3', gender: 'Male' },
  { id: 'M4', label: 'M4', gender: 'Male' },
  { id: 'M5', label: 'M5', gender: 'Male' },
  { id: 'F1', label: 'F1', gender: 'Female' },
  { id: 'F2', label: 'F2', gender: 'Female' },
  { id: 'F3', label: 'F3', gender: 'Female' },
  { id: 'F4', label: 'F4', gender: 'Female' },
  { id: 'F5', label: 'F5', gender: 'Female' },
];

export const KITTEN_THREAD_OPTIONS = [
  { value: '1', label: '1 thread' },
  { value: '2', label: '2 threads' },
  { value: '4', label: '4 threads' },
  { value: 'auto', label: 'Auto' },
];

// Ceiling raised past 2.0 so the slowest Kitten voices can reach the WPM target:
// Bella only reaches 163 WPM at 2.0x and needs ~2.1x for 170.
export const KITTEN_SPEED = {
  min: 0.5,
  max: 2.5,
  step: 0.1,
  default: 1,
};

export const KOKORO_SPEED = {
  min: 0.5,
  max: 2.5,
  step: 0.1,
  default: 1.3,
};

export const WPM_TARGET = 170;

export const SUPERTONIC_SPEED = {
  min: 0.7,
  max: 2,
  step: 0.05,
  default: 1.05,
};

export const SUPERTONIC_STEPS = {
  min: 5,
  max: 12,
  step: 1,
  default: 8,
};

export function resolveKittenModel(value) {
  const found = KITTEN_MODELS.find((model) => model.id === value || model.modelId === value);
  if (!found) {
    throw new Error(`Unsupported KittenTTS model: ${value}`);
  }
  return found;
}

export function resolveKittenVoice(value) {
  const voice = value || KITTEN_DEFAULT_VOICE;
  const found = KITTEN_VOICES.find((item) => item.id === voice);
  if (!found) {
    throw new Error(`Unsupported KittenTTS voice: ${voice}`);
  }
  return found.id;
}

export function resolveSupertonicVoice(value) {
  const voice = value || 'M1';
  const found = SUPERTONIC_VOICES.find((item) => item.id === voice);
  if (!found) {
    throw new Error(`Unsupported Supertonic voice style: ${voice}`);
  }
  return found.id;
}

export function clampKittenSpeed(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return KITTEN_SPEED.default;
  return Math.max(KITTEN_SPEED.min, Math.min(KITTEN_SPEED.max, parsed));
}

export function clampKokoroSpeed(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(KOKORO_SPEED.min, Math.min(KOKORO_SPEED.max, parsed));
}

export function speedLimitsFor(family) {
  return family === 'kokoro' ? KOKORO_SPEED : KITTEN_SPEED;
}

export function clampSpeedFor(family, value) {
  return family === 'kokoro' ? clampKokoroSpeed(value) : clampKittenSpeed(value);
}

export function clampSupertonicSpeed(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return SUPERTONIC_SPEED.default;
  return Math.max(SUPERTONIC_SPEED.min, Math.min(SUPERTONIC_SPEED.max, parsed));
}

export function clampSupertonicSteps(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return SUPERTONIC_STEPS.default;
  return Math.max(SUPERTONIC_STEPS.min, Math.min(SUPERTONIC_STEPS.max, parsed));
}

export function normalizeKittenThreads(value) {
  if (value === 'auto') return 'auto';
  const parsed = Number.parseInt(value ?? '2', 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(16, parsed));
}
