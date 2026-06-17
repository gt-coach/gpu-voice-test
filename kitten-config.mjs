export const KITTEN_SAMPLE_RATE = 24000;

export const KITTEN_DEFAULT_TEXT = 'Corner 14, brake one beat earlier. You are losing time on entry.';

export const KITTEN_MODELS = [
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

export const KITTEN_THREAD_OPTIONS = [
  { value: '1', label: '1 thread' },
  { value: '2', label: '2 threads' },
  { value: '4', label: '4 threads' },
  { value: 'auto', label: 'Auto' },
];

export const KITTEN_SPEED = {
  min: 0.5,
  max: 2,
  step: 0.1,
  default: 1,
};

export function resolveKittenModel(value) {
  const found = KITTEN_MODELS.find((model) => model.id === value || model.modelId === value);
  if (!found) {
    throw new Error(`Unsupported KittenTTS model: ${value}`);
  }
  return found;
}

export function resolveKittenVoice(value) {
  const voice = value || 'Leo';
  const found = KITTEN_VOICES.find((item) => item.id === voice);
  if (!found) {
    throw new Error(`Unsupported KittenTTS voice: ${voice}`);
  }
  return found.id;
}

export function clampKittenSpeed(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return KITTEN_SPEED.default;
  return Math.max(KITTEN_SPEED.min, Math.min(KITTEN_SPEED.max, parsed));
}

export function normalizeKittenThreads(value) {
  if (value === 'auto') return 'auto';
  const parsed = Number.parseInt(value ?? '2', 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(16, parsed));
}
