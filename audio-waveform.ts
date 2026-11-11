/** Pure presentation math shared by Bun and QML. Samples represent decoded
 * audio; unavailable audio uses an empty waveform, never decorative data. */
export const AUDIO_WAVEFORM_BARS = 64;
export const AUDIO_SAMPLE_RATE = 24000;
export const AUDIO_ANALYSIS_SECONDS = 600;

export function normalizeWaveform(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 96) return [];
  return value.map(v => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
}

export function fitWaveform(value: unknown, width: number): number[] {
  const input = normalizeWaveform(value);
  if (!input.length || !Number.isFinite(width) || width <= 0) return [];
  const count = Math.min(input.length, Math.max(1, Math.floor(width / 4)));
  const output: number[] = [];
  for (let i = 0; i < count; i++) {
    let peak = 0;
    for (let j = Math.floor(i * input.length / count); j < Math.floor((i + 1) * input.length / count); j++)
      peak = Math.max(peak, input[j]!);
    output.push(peak);
  }
  return output;
}

/** Bounded little-endian signed 16-bit PCM, RMS per equal-time bucket.
 * Normalize within the recording, then compress amplitude for small bars. */
export function waveformFromPcm16(bytes: Uint8Array, count = AUDIO_WAVEFORM_BARS): number[] {
  const samples = Math.floor(bytes.length / 2);
  if (!samples || bytes.length > AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2
      || !Number.isInteger(count) || count < 1 || count > 96) return [];
  count = Math.min(count, samples);
  const bins: number[] = [];
  let largest = 0;
  for (let bin = 0; bin < count; bin++) {
    const first = Math.floor(bin * samples / count), last = Math.floor((bin + 1) * samples / count);
    let sum = 0;
    for (let i = first; i < last; i++) {
      const unsigned = bytes[2 * i]! | (bytes[2 * i + 1]! << 8);
      const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / (last - first));
    bins.push(rms); largest = Math.max(largest, rms);
  }
  return largest === 0 ? bins : bins.map(v => Math.round(Math.sqrt(v / largest) * 1000) / 1000);
}

export function durationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0:00";
  const seconds = Math.floor(Math.min(milliseconds, 86400000) / 1000);
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return String(minutes) + ":" + (remainder < 10 ? "0" : "") + String(remainder);
}

export function playbackFraction(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, positionMs / durationMs));
}

export function seekPosition(fraction: number, durationMs: number): number {
  if (!Number.isFinite(fraction) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, fraction)) * durationMs);
}
