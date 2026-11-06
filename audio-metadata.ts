/** Audio-only metadata/envelope extraction. All PCM remains in memory. */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { AUDIO_ANALYSIS_SECONDS, AUDIO_SAMPLE_RATE, waveformFromPcm16 } from "./audio-waveform";

export interface AudioMetadata { durationMs: number; waveform: number[]; unavailable: boolean; playable: boolean }
const MAX_INPUT = 100 * 1024 * 1024;

/** Explicit demuxers prevent disguised playlists from loading referenced
 * resources. The cached CAF may already be Ogg after the existing rewrap. */
export function audioDemuxer(header: Uint8Array): string {
  const text = (a: number, b: number) => String.fromCharCode(...header.subarray(a, b));
  if (header.length < 12) return "";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "wav";
  if (text(0, 4) === "OggS") return "ogg";
  if (text(0, 4) === "caff") return "caf";
  if (text(0, 4) === "fLaC") return "flac";
  if (text(4, 8) === "ftyp") return "mov";
  if (text(0, 3) === "ID3" || (header[0] === 255 && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 6) !== 0)) return "mp3";
  if (header[0] === 255 && (header[1]! & 0xf6) === 0xf0) return "aac";
  return "";
}

export function analyzeAudio(path: string, runner = spawnSync): AudioMetadata {
  const empty: AudioMetadata = { durationMs: 0, waveform: [], unavailable: true, playable: false };
  let fallback = empty;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_INPUT) return empty;
    const header = Buffer.alloc(16); const length = readSync(fd, header, 0, header.length, 0);
    const format = audioDemuxer(header.subarray(0, length));
    if (!format) return empty;
    const input = ["-protocol_whitelist", "file,pipe", "-f", format, "-i", path];
    const probe = runner("ffprobe", ["-v", "error", ...input, "-select_streams", "a:0",
      "-show_entries", "format=duration:stream=codec_type", "-of", "json"],
      { timeout: 10000, maxBuffer: 16384 });
    if (probe.status !== 0) return empty;
    const data = JSON.parse(String(probe.stdout));
    if (!Array.isArray(data.streams) || !data.streams.some((s: any) => s.codec_type === "audio")) return empty;
    fallback = { ...empty, playable: true };
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return { ...empty, playable: true };
    const durationMs = Math.round(seconds * 1000);
    fallback = { durationMs, waveform: [], unavailable: true, playable: true };
    // A waveform must describe the complete recording. Don't display a
    // truncated ten-minute envelope against a longer recording's timeline.
    if (seconds > AUDIO_ANALYSIS_SECONDS) return { durationMs, waveform: [], unavailable: true, playable: true };
    const result = runner("ffmpeg", ["-nostdin", "-v", "error", "-threads", "1", ...input,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(AUDIO_ANALYSIS_SECONDS),
      "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
      { timeout: 15000, maxBuffer: AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 + 16384 });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return { durationMs, waveform: [], unavailable: true, playable: true };
    const decodedSeconds = result.stdout.length / (2 * AUDIO_SAMPLE_RATE);
    if (Math.abs(decodedSeconds - seconds) > Math.max(0.25, seconds * 0.02))
      return { durationMs, waveform: [], unavailable: true, playable: true };
    const waveform = waveformFromPcm16(result.stdout);
    return { durationMs, waveform, unavailable: waveform.length === 0, playable: true };
  } catch { return fallback; }
  finally { if (fd !== undefined) closeSync(fd); }
}
