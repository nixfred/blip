#!/usr/bin/env python3
"""Exercise shipping audio analysis/player using a muted synthetic WAV only."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path)
    args = parser.parse_args()
    runner = shutil.which("qmltestrunner") or next((str(p) for p in (
        Path("/usr/lib/qt6/bin/qmltestrunner"), Path("/usr/lib/qt6/libexec/qmltestrunner")) if p.is_file()), None)
    if not runner:
        raise SystemExit("Qt 6 qmltestrunner required")
    with tempfile.TemporaryDirectory(prefix="blip-audio-ui-") as directory:
        folder = Path(directory)
        samples = []
        for i in range(192000):
            amplitude = 0 if i < 12000 else (0.15, 0.8, 0.4, 0.65)[(i // 12000) % 4]
            samples.append(round(24000 * amplitude * math.sin(i * math.tau * 220 / 48000)))
        with wave.open(str(folder / "voice.wav"), "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000)
            output.writeframes(struct.pack("<" + "h" * len(samples), *samples))
        prepare = folder / "prepare.ts"
        prepare.write_text('import { analyzeAudio } from ' + json.dumps(str(ROOT / "audio-metadata.ts")) + ';\n'
                           'console.log(JSON.stringify(analyzeAudio(process.argv[2])));\n')
        result = subprocess.run(["bun", str(prepare), str(folder / "voice.wav")], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise SystemExit("Synthetic audio preparation failed: " + result.stderr[:4096])
        metadata = json.loads(result.stdout)
        assert not metadata["unavailable"] and metadata["durationMs"] == 4000
        assert len(metadata["waveform"]) == 64 and max(metadata["waveform"]) == 1
        for file in ["AudioMessage.qml", "AudioPlayback.qml", "AudioWaveform.mjs"]:
            shutil.copy(ROOT / file, folder)
        capture = "" if args.capture is None else str(args.capture.resolve())
        if capture:
            args.capture.resolve().parent.mkdir(parents=True, exist_ok=True)
        (folder / "tst_audio.qml").write_text('''import QtQuick
import QtTest
Item {
  id: root
  width: 350; height: 190
  property int ended: 0
  property int failures: 0
  property var rows: [1]
  Repeater { model: root.rows; delegate: AudioMessage { playback: engine; visible: false } }
  Rectangle { anchors.fill: parent; color: "#202127" }
  AudioPlayback {
    id: engine
    source: @PLAYBACK@; muted: true; playing: card.playing; resetToken: card.resetToken
    onPlaybackEnded: { root.ended++; card.playing = false }
    onPlaybackFailed: root.failures++
  }
  AudioMessage {
    id: card; playback: engine; x: 30; y: 28; width: 288
    source: "voice.wav"; muted: true
    waveform: @WAVEFORM@; durationMs: 4000
    onToggleRequested: playing = !playing
  }
  AudioMessage {
    x: 90; y: 112; width: 230; mine: true; muted: true
    waveform: @WAVEFORM@; durationMs: 37000
  }
  TestCase {
    name: "AudioMessagePlayback"
    when: windowShown
    function initTestCase() {
      tryCompare(card, "ready", true, 5000)
      compare(card.totalDurationMs, 4000)
      compare(root.failures, 0)
    }
    function test_01_play_pause_resume_and_reset() {
      card.playing = true
      tryVerify(function() { return card.positionMs > 100 }, 3000)
      card.playing = false
      wait(120)
      var position = card.positionMs
      wait(200)
      compare(card.positionMs, position)
      card.playing = true
      tryVerify(function() { return card.positionMs > position + 100 }, 3000)
      card.playing = false
      card.resetToken++
      tryCompare(card, "positionMs", 0)
      verify(!card.actuallyPlaying)
    }
    function test_02_seek_and_keyboard_focus() {
      var slider = findChild(card, "audioTimeline")
      verify(slider !== null)
      tryCompare(card, "seekable", true)
      mouseClick(slider, slider.width / 2, slider.height / 2)
      tryVerify(function() { return card.positionMs > 1000 && card.positionMs < 3000 })
      slider.forceActiveFocus()
      verify(card.controlsFocused)
      keyClick(Qt.Key_Left)
      tryCompare(card, "positionMs", 0)
    }
    function test_03_completion_and_replay() {
      var slider = findChild(card, "audioTimeline")
      mouseClick(slider, slider.width * 0.75, slider.height / 2)
      card.playing = true
      tryVerify(function() { return root.ended > 0 }, 5000)
      verify(!card.playing)
      card.playing = true
      tryVerify(function() { return card.positionMs > 0 && card.positionMs < 2000 }, 3000)
      card.playing = false
      card.resetToken++
      compare(root.failures, 0)
    }
    function test_04_delegate_rebuild_preserves_playback() {
      card.playing = true
      tryVerify(function() { return engine.position > 100 }, 3000)
      var before = engine.position
      root.rows = [2, 3]
      tryVerify(function() { return engine.position > before + 100 }, 3000)
      card.playing = false
      var slider = findChild(card, "audioTimeline")
      slider.forceActiveFocus()
      keyClick(Qt.Key_Escape)
    }
    function test_05_compact_layout_and_unavailable_waveform() {
      card.width = 160
      verify(card.bars.length <= 20)
      card.waveform = []
      compare(card.bars.length, 0)
      verify(card.totalDurationMs > 0)
      card.width = 288
      card.waveform = @WAVEFORM@
    }
    function cleanupTestCase() {
      card.playing = false
      card.resetToken++
      var path = @CAPTURE@
      if (path !== "") grabImage(root).save(path)
    }
  }
}
'''.replace("@PLAYBACK@", json.dumps(metadata["playbackUrl"])).replace("@WAVEFORM@", json.dumps(metadata["waveform"])).replace("@CAPTURE@", json.dumps(capture)))
        return subprocess.run([runner, "-input", str(folder), "-platform", "offscreen"], timeout=30,
            env={**os.environ, "QT_QPA_PLATFORM":"offscreen", "QT_QPA_PLATFORMTHEME":"generic",
                 "QT_QUICK_BACKEND":"software", "QT_MEDIA_BACKEND":"ffmpeg"}).returncode


if __name__ == "__main__":
    raise SystemExit(main())
