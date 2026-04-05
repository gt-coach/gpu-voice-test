export const SAMPLE_RATE = 24000;

export const VOICES = [
  { id: 'af_heart', label: 'Heart (Female)' },
  { id: 'af_bella', label: 'Bella (Female)' },
  { id: 'af_nova', label: 'Nova (Female)' },
  { id: 'am_adam', label: 'Adam (Male)' },
  { id: 'am_michael', label: 'Michael (Male)' },
];

export const SENTENCES = [
  // ── Cue (~3-8 words) ───────────────────────────────────────────────
  { text: 'Corner 14: brake earlier. Late brake point.', cascade: 'cue' },
  { text: 'Corner 14: same rhythm.', cascade: 'cue' },
  { text: 'Corner 14: release brake sooner. Late brake release.', cascade: 'cue' },
  { text: 'Corner 14: wait before throttle. Early throttle pickup.', cascade: 'cue' },
  { text: 'Corner 14: square the exit then throttle. Low exit speed.', cascade: 'cue' },

  // ── Compact (~6-12 words) ──────────────────────────────────────────
  { text: 'Corner 14, brake earlier — it carries into Corner 15.', cascade: 'compact' },
  { text: 'Corner 14, release brake sooner — you released the brake too late, losing exit speed.', cascade: 'compact' },
  { text: "Corner 14, commit to braking later. You're losing exit speed.", cascade: 'compact' },
  { text: 'Corner 14 coming up. Keep it going.', cascade: 'compact' },
  { text: 'Corner 14 next. Same rhythm.', cascade: 'compact' },

  // ── Full (~15-30 words) ────────────────────────────────────────────
  { text: 'Corner 14, brake one beat earlier — the brake release shifted late at Corner 12, and by Corner 15 your apex speed is too high.', cascade: 'full' },
  { text: 'Corner 14, pick up the throttle earlier — you picked up throttle too late. That cost you half a second.', cascade: 'full' },
  { text: 'Corner 14, square the exit, then throttle — your exit speed was low. That cost you half a second.', cascade: 'full' },
  { text: 'Corners 14, 11, 12, and 13 coming up, brake one beat earlier at each — you lost half a second here last lap.', cascade: 'full' },
  { text: 'Approaching Corner 14. Keep it clean.', cascade: 'full' },
].map((s) => ({ ...s, wordCount: s.text.split(/\s+/).length }));
