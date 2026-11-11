/** Audio-only metadata/envelope extraction. All PCM remains in memory. */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, utimesSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AUDIO_ANALYSIS_SECONDS, AUDIO_SAMPLE_RATE, waveformFromPcm16 } from "./audio-waveform";

export interface AudioMetadata { durationMs: number; waveform: number[]; unavailable: boolean; playable: boolean; externalDemuxer?: string; playbackUrl?: string }
const PCM_OFFSET = 4096;
const MAX_INPUT = 100 * 1024 * 1024;

/** Explicit demuxers prevent disguised playlists from loading referenced
 * resources. The cached CAF may already be Ogg after the existing rewrap. */
export function audioDemuxer(header: Uint8Array): string {
  const text = (a: number, b: number) => String.fromCharCode(...header.subarray(a, b));
  if (header.length < 12) return "";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "wav";
  if (text(0, 4) === "OggS") return "ogg";
  if (text(0, 4) === "caff") return "caf";
  if (text(0, 6) === "#!AMR\n") return "amr";
  if (text(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(text(8, 12))) return "aiff";
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return "matroska";
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
    if (!st.isFile() || st.uid !== process.getuid() || st.size <= 0 || st.size > MAX_INPUT) return empty;
    const header = Buffer.alloc(16); const length = readSync(fd, header, 0, header.length, 0);
    const format = audioDemuxer(header.subarray(0, length));
    if (!format) return empty;
    empty.externalDemuxer = format;
    // Generated PCM WAV is the only file ever handed to Qt. The source
    // fingerprint invalidates both waveform and normalized audio together.
    const hash = createHash("sha256"), chunk = Buffer.alloc(65536);
    for (let offset = 0; offset < st.size;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, st.size - offset), offset);
      if (!n) return empty;
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    const playbackPath = join(dirname(path), `.pcm2-${hash.digest("hex")}.wav`);
    try {
      const cached = openSync(playbackPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const cs = fstatSync(cached);
        if (cs.isFile() && cs.uid === process.getuid() && cs.size > PCM_OFFSET && cs.size <= AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 + PCM_OFFSET) {
          const data = Buffer.alloc(cs.size);
          if (readSync(cached, data, 0, data.length, 0) === data.length && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 16) === "WAVEfmt ") {
            const now = new Date(); utimesSync(playbackPath, now, now);
            return {externalDemuxer: format, durationMs: Math.round((data.length - PCM_OFFSET) * 1000 / (2 * AUDIO_SAMPLE_RATE)), waveform: waveformFromPcm16(data.subarray(PCM_OFFSET)), unavailable:false, playable:true, playbackUrl:pathToFileURL(playbackPath).href};
          }
        }
      } finally { closeSync(cached); }
    } catch { /* no normalized cache entry */ }
    const input = ["-protocol_whitelist", "file,pipe", "-f", format, "-i", path];
    const probe = runner("ffprobe", ["-v", "error", ...input, "-select_streams", "a:0",
      "-show_entries", "format=duration:stream=codec_type", "-of", "json"],
      { timeout: 10000, maxBuffer: 16384 });
    if (probe.status !== 0) return empty;
    const data = JSON.parse(String(probe.stdout));
    if (!Array.isArray(data.streams) || !data.streams.some((s: any) => s.codec_type === "audio")) return empty;
    fallback = { ...empty, playable: false };
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return { ...empty, playable: false };
    const durationMs = Math.round(seconds * 1000);
    fallback = { ...empty, durationMs };
    // A waveform must describe the complete recording. Don't display a
    // truncated ten-minute envelope against a longer recording's timeline.
    if (seconds > AUDIO_ANALYSIS_SECONDS) return { ...empty, durationMs };
    const result = runner("ffmpeg", ["-nostdin", "-v", "error", "-threads", "1", ...input,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(AUDIO_ANALYSIS_SECONDS),
      "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
      { timeout: 15000, maxBuffer: AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 + 16384 });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return { ...empty, durationMs };
    const decodedSeconds = result.stdout.length / (2 * AUDIO_SAMPLE_RATE);
    if (Math.abs(decodedSeconds - seconds) > Math.max(0.25, seconds * 0.02))
      return { ...empty, durationMs };
    const waveform = waveformFromPcm16(result.stdout);
    if (!waveform.length) return empty;
    const wav = Buffer.alloc(PCM_OFFSET);
    wav.write("RIFF", 0); wav.writeUInt32LE(result.stdout.length + PCM_OFFSET - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(18, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(AUDIO_SAMPLE_RATE, 24); wav.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("JUNK", 38); wav.writeUInt32LE(PCM_OFFSET - 54, 42);
    wav.write("data", PCM_OFFSET - 8); wav.writeUInt32LE(result.stdout.length, PCM_OFFSET - 4);
    const tmp = playbackPath + `.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, Buffer.concat([wav, result.stdout]), {mode:0o600, flag:"wx"});
      renameSync(tmp, playbackPath);
    } finally { try { unlinkSync(tmp); } catch {} }
    return { durationMs, waveform, unavailable: false, playable: true, externalDemuxer: format, playbackUrl:pathToFileURL(playbackPath).href };
  } catch { return fallback; }
  finally { if (fd !== undefined) closeSync(fd); }
}
