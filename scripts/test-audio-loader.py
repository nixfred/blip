#!/usr/bin/env python3
"""Exercise the shipping optional player loader with a missing module."""
from pathlib import Path
import tempfile, subprocess, os
source=Path(__file__).resolve().parents[1].joinpath('BlipView.qml').read_text()
at=source.index('  Loader {\n    id: audioPlayback')
begin=source.index('{',at);depth=0
for end in range(begin,len(source)):
    if source[end]=='{':depth+=1
    elif source[end]=='}':
        depth-=1
        if depth==0:break
loader=source[at:end+1]
qml='''import QtQuick
import QtTest
Item {
 id: root
 property string playingAudio: "a"
 property var attFiles: ({a:"file:///synthetic/voice.ogg"})
 property var attMetrics: ({a:{audio:{playable:true,externalDemuxer:"ogg"}}})
 property bool audioPlaying: true
 property bool audioMuted: true
 property int audioResetToken: 0
 property string note: ""
 property bool fallback: false
 function stopAudio() { playingAudio="" }
 function playExternalAudio(format,path) { fallback=format==="ogg" && path===attFiles.a; stopAudio() }
 @LOADER@
 TestCase { name: "OptionalAudioLoader"
 function test_missing_module_falls_back_on_first_play() { tryCompare(root,"fallback",true); compare(root.playingAudio,"") }
 }
}'''.replace('@LOADER@',loader)
with tempfile.TemporaryDirectory(prefix='blip-audio-loader-') as tmp:
    Path(tmp,'AudioPlayback.qml').write_text('import QtQuick\nimport MissingMultimedia\nItem {}')
    Path(tmp,'tst_loader.qml').write_text(qml)
    raise SystemExit(subprocess.run(['/usr/lib/qt6/bin/qmltestrunner','-input',tmp],env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QUICK_BACKEND':'software','QT_QPA_PLATFORMTHEME':'generic'}).returncode)
