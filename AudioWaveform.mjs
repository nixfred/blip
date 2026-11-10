// audio-waveform.ts
var AUDIO_WAVEFORM_BARS = 64;
var AUDIO_SAMPLE_RATE = 24000;
var AUDIO_ANALYSIS_SECONDS = 600;
function normalizeWaveform(value) {
  if (!Array.isArray(value) || value.length > 96)
    return [];
  return value.map((v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
}
function fitWaveform(value, width) {
  const input = normalizeWaveform(value);
  if (!input.length || !Number.isFinite(width) || width <= 0)
    return [];
  const count = Math.min(input.length, Math.max(1, Math.floor(width / 4)));
  const output = [];
  for (let i = 0;i < count; i++) {
    let peak = 0;
    for (let j = Math.floor(i * input.length / count);j < Math.floor((i + 1) * input.length / count); j++)
      peak = Math.max(peak, input[j]);
    output.push(peak);
  }
  return output;
}
function waveformFromPcm16(bytes, count = AUDIO_WAVEFORM_BARS) {
  const samples = Math.floor(bytes.length / 2);
  if (!samples || bytes.length > AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 || !Number.isInteger(count) || count < 1 || count > 96)
    return [];
  count = Math.min(count, samples);
  const bins = [];
  let largest = 0;
  for (let bin = 0;bin < count; bin++) {
    const first = Math.floor(bin * samples / count), last = Math.floor((bin + 1) * samples / count);
    let sum = 0;
    for (let i = first;i < last; i++) {
      const unsigned = bytes[2 * i] | bytes[2 * i + 1] << 8;
      const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / (last - first));
    bins.push(rms);
    largest = Math.max(largest, rms);
  }
  return largest === 0 ? bins : bins.map((v) => Math.round(Math.sqrt(v / largest) * 1000) / 1000);
}
function durationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    return "0:00";
  const seconds = Math.floor(Math.min(milliseconds, 86400000) / 1000);
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return String(minutes) + ":" + (remainder < 10 ? "0" : "") + String(remainder);
}
function playbackFraction(positionMs, durationMs) {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0)
    return 0;
  return Math.max(0, Math.min(1, positionMs / durationMs));
}
function seekPosition(fraction, durationMs) {
  if (!Number.isFinite(fraction) || !Number.isFinite(durationMs) || durationMs <= 0)
    return 0;
  return Math.round(Math.max(0, Math.min(1, fraction)) * durationMs);
}
export {
  AUDIO_ANALYSIS_SECONDS,
  AUDIO_SAMPLE_RATE,
  AUDIO_WAVEFORM_BARS,
  durationLabel,
  fitWaveform,
  normalizeWaveform,
  playbackFraction,
  seekPosition,
  waveformFromPcm16
};
