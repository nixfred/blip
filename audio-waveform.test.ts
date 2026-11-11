import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { AUDIO_ANALYSIS_SECONDS, AUDIO_SAMPLE_RATE, durationLabel, fitWaveform, normalizeWaveform,
  playbackFraction, seekPosition, waveformFromPcm16 } from "./audio-waveform";
import { analyzeAudio, audioDemuxer } from "./audio-metadata";

function pcm(samples: number[]): Buffer {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
  return bytes;
}
function wavHeader(): Buffer {
  const h = Buffer.alloc(44); h.write("RIFF"); h.write("WAVE", 8); return h;
}

describe("measured audio presentation", () => {
  test("silence stays flat; changes in the source produce corresponding envelope", () => {
    expect(waveformFromPcm16(pcm([0,0,0,0]), 2)).toEqual([0,0]);
    expect(waveformFromPcm16(pcm([100,-100,1600,-1600,0,0,400,-400]), 4)).toEqual([0.25,1,0,0.5]);
    expect(waveformFromPcm16(pcm([-32768,32767]), 2)[0]).toBe(1);
    expect(waveformFromPcm16(new Uint8Array())).toEqual([]);
    expect(waveformFromPcm16(pcm([100]), 200)).toEqual([]);
    expect(waveformFromPcm16(new Uint8Array(AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 + 1))).toEqual([]);
  });
  test("malformed or oversize UI data is bounded, and narrow waveforms retain peaks", () => {
    expect(normalizeWaveform([NaN,Infinity,-1,0.5,2,"1"])).toEqual([0,0,0,0.5,1,0]);
    expect(normalizeWaveform(Array(97).fill(1))).toEqual([]);
    expect(normalizeWaveform({length:AUDIO_SAMPLE_RATE * 2.50})).toEqual([]);
    expect(fitWaveform([0,0.8,0.2,1,0.4,0.7], 12)).toEqual([0.8,1,0.7]);
    expect(fitWaveform([1], 1)).toEqual([1]);
    expect(fitWaveform([1], NaN)).toEqual([]);
  });
  test("duration and seeking clamp invalid positions", () => {
    expect(durationLabel(0)).toBe("0:00"); expect(durationLabel(65300)).toBe("1:05");
    expect(durationLabel(NaN)).toBe("0:00"); expect(durationLabel(-1)).toBe("0:00");
    expect(playbackFraction(20,10)).toBe(1); expect(playbackFraction(-1,10)).toBe(0);
    expect(playbackFraction(1,0)).toBe(0); expect(playbackFraction(NaN,1)).toBe(0);
    expect(seekPosition(0.25,1000)).toBe(250); expect(seekPosition(5,1000)).toBe(1000);
  });
});

describe("bounded private audio analysis", () => {
  test("demuxer selection rejects disguised playlists and checks actual bytes", () => {
    expect(audioDemuxer(wavHeader())).toBe("wav");
    expect(audioDemuxer(Buffer.from("#EXTM3U\nfile:///private"))).toBe("");
    expect(audioDemuxer(Buffer.from("<svg>external resource"))).toBe("");
    for (const [magic, format] of [["OggS","ogg"],["caff","caf"],["fLaC","flac"],["ID3","mp3"]]) {
      const h = Buffer.alloc(16); h.write(magic!); expect(audioDemuxer(h)).toBe(format);
    }
  });
  test("the real duration and complete PCM envelope survive, with fixed caps and explicit demuxer", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-audio-test-"));
    const path = join(dir,"sample.wav"); writeFileSync(path,wavHeader(),{mode:0o600});
    try {
      const calls: string[] = [];
      const runner = ((cmd: string, args: string[], opts: any) => {
        calls.push(cmd); expect(args).toContain("file,pipe"); expect(args).toContain("wav");
        expect(args).not.toContain("http"); expect(opts.timeout).toBeLessThanOrEqual(15000);
        if (cmd === "ffprobe") return { status:0, stdout: JSON.stringify({streams:[{codec_type:"audio"}],format:{duration:"2.5"}}) };
        expect(args).toContain("-nostdin");
        expect(args[args.indexOf("-t") + 1]).toBe(String(AUDIO_ANALYSIS_SECONDS));
        expect(opts.maxBuffer).toBeLessThanOrEqual(AUDIO_SAMPLE_RATE * AUDIO_ANALYSIS_SECONDS * 2 + 16384);
        return { status:0, stdout:pcm(Array.from({length:AUDIO_SAMPLE_RATE * 2.5}, (_,i) => i < 1000 ? 0 : 300)) };
      }) as never;
      const result = analyzeAudio(path,runner);
      expect(result.durationMs).toBe(2500); expect(result.unavailable).toBe(false);
      expect(result.playable).toBe(true);
      expect(result.waveform.length).toBe(64); expect(result.waveform[0]).toBe(0);
      expect(calls).toEqual(["ffprobe","ffmpeg"]);
      expect(result.playbackUrl).not.toBe("file://" + path);
      const cached = analyzeAudio(path, (() => { throw Error("cache must avoid analysis"); }) as never);
      expect(cached.playable).toBe(true); expect(cached.waveform).toEqual(result.waveform);
      const link = join(dir,"link.wav"); symlinkSync(path,link);
      expect(analyzeAudio(link,runner).unavailable).toBe(true); expect(calls.length).toBe(2);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test("long recordings retain duration without a misleading truncated waveform; failures remain playable", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-audio-test-"));
    const path = join(dir,"sample.wav"); writeFileSync(path,wavHeader());
    try {
      for (const seconds of [601, NaN, -1]) {
        let calls = 0;
        const r = analyzeAudio(path, (() => { calls++; return {status:0,stdout:JSON.stringify({streams:[{codec_type:"audio"}],format:{duration:seconds}})}; }) as never);
        expect(calls).toBe(1); expect(r.waveform).toEqual([]); expect(r.unavailable).toBe(true);
        expect(r.durationMs).toBe(seconds===601 ? 601000 : 0);
        expect(r.externalDemuxer).toBe("wav");
      }
      const timedOut = analyzeAudio(path, ((cmd: string) => cmd === "ffprobe"
        ? {status:0,stdout:'{"streams":[{"codec_type":"audio"}],"format":{"duration":"2"}}'} : {status:null,stdout:Buffer.alloc(0),error:Error("ETIMEDOUT")}) as never);
      expect(timedOut.durationMs).toBe(2000); expect(timedOut.unavailable).toBe(true);
      expect(timedOut.playable).toBe(false);
      const missing = analyzeAudio(path, ((cmd: string) => {
        if (cmd === "ffprobe") return {status:0,stdout:'{"streams":[{"codec_type":"audio"}],"format":{"duration":"2"}}'};
        throw Error("ENOENT");
      }) as never);
      expect(missing.durationMs).toBe(2000); expect(missing.playable).toBe(false);
      const noAudio = analyzeAudio(path, (() => ({status:0,stdout:'{"streams":[{"codec_type":"video"}],"format":{"duration":"2"}}'})) as never);
      expect(noAudio.playable).toBe(false);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});

test("a lying duration never produces playable normalized audio", () => {
  const dir=mkdtempSync(join(tmpdir(),"blip-audio-duration-")); const path=join(dir,"voice.wav");
  writeFileSync(path,wavHeader());
  try {
    const r=analyzeAudio(path,((cmd:string)=>cmd === "ffprobe"
      ? {status:0, stdout:JSON.stringify({streams:[{codec_type:"audio"}],format:{duration:"10"}})}
      : {status:0,stdout:pcm(Array(AUDIO_SAMPLE_RATE).fill(100))}) as never);
    expect(r.playable).toBe(false); expect(r.playbackUrl).toBeUndefined();
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test("normalized sender PCM cannot override WAV format probing", () => {
  const dir = mkdtempSync(join(tmpdir(), "blip-audio-probe-"));
  try {
    const ts = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=32x32:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.5", "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpegts", "pipe:1"]);
    expect(ts.status).toBe(0);
    const payload = Buffer.alloc(Math.ceil(ts.stdout.length / 2) * 2); ts.stdout.copy(payload);
    const input = join(dir, "voice.wav"); writeFileSync(input, wavHeader());
    const r = analyzeAudio(input, ((cmd: string) => cmd === "ffprobe"
      ? {status:0, stdout:JSON.stringify({streams:[{codec_type:"audio"}],format:{duration:payload.length / (2 * AUDIO_SAMPLE_RATE)}})}
      : {status:0, stdout:payload}) as never);
    expect(r.playable).toBe(true);
    const guessed = spawnSync("ffprobe", ["-v","error","-show_entries","format=format_name:stream=codec_type","-of","json",fileURLToPath(r.playbackUrl!)]);
    expect(guessed.status).toBe(0);
    const meta = JSON.parse(String(guessed.stdout));
    expect(meta.format.format_name).toBe("wav");
    expect(meta.streams.map((s:any)=>s.codec_type)).toEqual(["audio"]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("a cache hit hands Qt the WAV Blip generated, never the received file, and runs nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "blip-audio-cachehit-"));
  try {
    const input = join(dir, "voice.wav"); writeFileSync(input, wavHeader());
    const samples = pcm(Array(AUDIO_SAMPLE_RATE).fill(100));
    const first = analyzeAudio(input, ((cmd: string) => cmd === "ffprobe"
      ? {status:0, stdout:JSON.stringify({streams:[{codec_type:"audio"}],format:{duration:"1"}})}
      : {status:0, stdout:samples}) as never);
    expect(first.playable).toBe(true);
    const calls: string[] = [];
    const again = analyzeAudio(input, ((cmd: string) => { calls.push(cmd); return {status:1, stdout:""}; }) as never);
    expect(calls).toEqual([]);
    expect(again.playable).toBe(true);
    expect(again.playbackUrl).toBe(first.playbackUrl);
    const served = fileURLToPath(again.playbackUrl!);
    expect(served).not.toBe(input);
    expect(basename(served).startsWith(".pcm2-")).toBe(true);
    expect(again.durationMs).toBe(1000);
    expect(again.waveform).toEqual(first.waveform);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
