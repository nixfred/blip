#!/usr/bin/env python3
"""Decode synthetic sticker media through the shipping fetcher and QML item.

Requires Bun, ffmpeg/ffprobe, and Qt 6 QtQuick/QtTest. No Mac, network, real
Messages rows, or live app is used. --capture writes a synthetic preview.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zlib


ROOT = Path(__file__).resolve().parents[1]


def png(width, height, raw, channels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    scan = b"".join(b"\0" + raw[y * width * channels:(y + 1) * width * channels] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6 if channels == 4 else 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scan)) + chunk(b"IEND", b""))


def run(command, **kwargs):
    subprocess.run(command, check=True, timeout=45, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path)
    args = parser.parse_args()
    runner = shutil.which("qmltestrunner") or next((str(p) for p in (
        Path("/usr/lib/qt6/bin/qmltestrunner"), Path("/usr/lib/qt6/libexec/qmltestrunner")) if p.is_file()), None)
    if not runner:
        raise SystemExit("Qt 6 qmltestrunner not found")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe are required for the synthetic codec test")
    with tempfile.TemporaryDirectory(prefix="blip-sticker-ui-") as directory:
        folder = Path(directory)
        width = height = 64
        mask = bytes(128 if (x - 32) ** 2 + (y - 32) ** 2 < 24 ** 2 else 0
                     for y in range(height) for x in range(width))
        red = b"".join(bytes((240, 80, 100, a)) for a in mask)
        blue = b"".join(bytes((60, 160, 250, a)) for a in mask)
        (folder / "still.png").write_bytes(png(width, height, red, 4))
        (folder / "mask.png").write_bytes(png(width, height, mask, 1))
        run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "64x64",
             "-framerate", "5", "-i", "pipe:0", "-plays", "0", "-f", "apng", str(folder / "animated.png")], input=red + blue)
        # Four independently addressable tracks model HEICS's still pair
        # and animated color/alpha pair, without importing someone's sticker.
        run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1",
             "-loop", "1", "-framerate", "5", "-i", str(folder / "mask.png"), "-t", "1",
             "-map", "0:v", "-map", "1:v", "-map", "0:v", "-map", "1:v", "-c:v", "png",
             str(folder / "four-track.mov")])
        prepare = folder / "prepare.ts"
        prepare.write_text('''import { readFileSync, writeFileSync } from "node:fs";
import { stickerAnimationPreview, stickerSequencePreview } from @MODULE@;
const dir = process.argv[2];
const apng = stickerAnimationPreview(readFileSync(dir + "/animated.png"));
if (!apng.converted || apng.unavailable) throw Error("APNG conversion failed");
writeFileSync(dir + "/animated.webp", apng.bytes);
const sequence = stickerSequencePreview(readFileSync(dir + "/four-track.mov"), "image/heic-sequence", undefined, dir);
if (!sequence || sequence.unavailable || sequence.renderMime !== "image/webp") throw Error("sequence conversion failed");
writeFileSync(dir + "/sequence.webp", sequence.bytes);
'''.replace("@MODULE@", json.dumps(str(ROOT / "fetch.ts"))))
        run(["bun", str(prepare), str(folder)], env={**os.environ, "XDG_CACHE_HOME": str(folder / "cache")})
        shutil.copy(ROOT / "StickerImage.qml", folder)
        shutil.copy(ROOT / "Stickers.mjs", folder)
        capture = "" if args.capture is None else str(args.capture.resolve())
        if capture:
            args.capture.resolve().parent.mkdir(parents=True, exist_ok=True)
        (folder / "tst_sticker.qml").write_text('''import QtQuick
import QtTest
import "Stickers.mjs" as Stickers
Item {
  id: root
  width: 580; height: 220
  Rectangle { anchors.fill: parent; color: "#202127" }
  StickerImage {
    id: still; x: 20; y: 30; width: 160; height: 160
    source: "still.png"
    attachment: ({sticker:{label:"Synthetic translucent circle"}})
  }
  StickerImage {
    id: apng; x: 210; y: 30; width: 160; height: 160
    source: "animated.webp"; animated: true
  }
  StickerImage {
    id: sequence; x: 400; y: 30; width: 160; height: 160
    source: "sequence.webp"; animated: true
  }
  TestCase {
    name: "StickerRendering"
    when: windowShown
    function initTestCase() {
      tryCompare(still, "ready", true)
      tryCompare(apng, "ready", true)
      tryCompare(sequence, "ready", true)
    }
    function test_alpha_survives_static_and_animated_paths() {
      for (var item of [still, apng, sequence]) {
        var captured = grabImage(item)
        // grabImage includes the parent's opaque background. Transparent
        // corners must show that background, never black or an image matte.
        compare(captured.red(1, 1), 32)
        compare(captured.green(1, 1), 33)
        compare(captured.blue(1, 1), 39)
      }
      var staticImage = grabImage(still)
      // The center is 50% red over the background, not opaque source red.
      verify(staticImage.red(80, 80) > 130 && staticImage.red(80, 80) < 145)
    }
    function test_frames_advance_for_both_animation_formats() {
      compare(apng.frameCount, 2)
      compare(sequence.frameCount, 5)
      for (var item of [apng, sequence]) {
        var first = item.currentFrame
        tryVerify(function() { return item.currentFrame !== first }, 2000)
      }
    }
    function test_pause_releases_animation_work() {
      apng.playing = false
      wait(250)
      var first = apng.currentFrame
      wait(400)
      compare(apng.currentFrame, first)
      apng.playing = true
    }
    function test_geometry_module_loads_in_qml() {
      var g = Stickers.stickerGeometry({x:1,y:0,scale:1,rotation:0.5}, 180, 80, 64, 64)
      verify(g.placed)
      verify(g.width > 0 && isFinite(g.rotation))
      compare(Stickers.placedStickers([{part:0,placement:{x:0.5,y:0.5,scale:1,rotation:0}}]).length, 1)
    }
    function cleanupTestCase() {
      var path = @CAPTURE@
      if (path !== "") grabImage(root).save(path)
    }
  }
}
'''.replace("@CAPTURE@", json.dumps(capture)))
        result = subprocess.run([runner, "-input", str(folder), "-platform", "offscreen"], timeout=30,
                                env={**os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QPA_PLATFORMTHEME": "generic",
                                     "QT_QUICK_BACKEND": "software"})
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
