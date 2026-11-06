#!/usr/bin/env python3
"""Exercise shipping audio play-intent handlers with a fake attachment fetcher."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
source = (repo / 'BlipView.qml').read_text()

def function(name):
    start = source.index('  function ' + name + '(')
    begin = source.index('{', start)
    depth = 0
    for end in range(begin, len(source)):
        if source[end] == '{': depth += 1
        elif source[end] == '}':
            depth -= 1
            if depth == 0: return source[start:end + 1]
    raise ValueError(name)

qml = '''import QtQuick
import QtTest
Item {
  id: root
  property bool surfaceOpen: true
  property bool inThread: true
  property var active: ({chat:"synthetic-a"})
  property var attFiles: ({})
  property var attMetrics: ({})
  property string playingAudio: ""
  property bool audioPlaying: false
  property int audioResetToken: 0
  property string pendingAudioId: ""
  property string pendingAudioChat: ""
  property string note: ""
  property var requests: []
  function enqueueFetch(att, action, auto) { requests = requests.concat([{id:att.id,action:action,auto:auto}]) }
  @FUNCTIONS@
  TestCase {
    name: "AudioSession"
    function init() {
      root.stopAudio(); root.requests = []; root.attFiles = ({}); root.attMetrics = ({});
      root.surfaceOpen = true; root.inThread = true; root.active = ({chat:"synthetic-a"});
    }
    function complete(id, ok) {
      if(ok) { var files=Object.assign({},root.attFiles); files[id]="file:///synthetic/voice.ogg"; root.attFiles=files; var metrics=Object.assign({},root.attMetrics); metrics[id]=({audio:{playable:true}}); root.attMetrics=metrics }
      root.settleAudioFetch(id,ok)
    }
    function test_fetch_then_play_and_pause_resume_without_refetch() {
      root.toggleAudio({id:"a"}); compare(root.requests.length,1); compare(root.requests[0].action,"audio-play");
      verify(!root.audioPlaying); complete("a",true); verify(root.audioPlaying); compare(root.playingAudio,"a");
      root.toggleAudio({id:"a"}); verify(!root.audioPlaying);
      root.toggleAudio({id:"a"}); verify(root.audioPlaying); compare(root.requests.length,1);
    }
    function test_switching_chat_drops_late_completion() {
      root.toggleAudio({id:"a"}); root.active=({chat:"synthetic-b"}); complete("a",true);
      verify(!root.audioPlaying); compare(root.playingAudio,""); compare(root.pendingAudioId,"");
    }
    function test_closing_during_fetch_never_plays() {
      root.toggleAudio({id:"a"}); root.surfaceOpen=false; root.stopAudio(); complete("a",true);
      verify(!root.audioPlaying); compare(root.pendingAudioChat,"");
    }
    function test_other_attachment_completion_does_not_consume_intent() {
      root.toggleAudio({id:"a"}); complete("b",true); verify(!root.audioPlaying); compare(root.pendingAudioId,"a");
      complete("a",true); verify(root.audioPlaying);
    }
    function test_second_click_cancels_pending_play() {
      root.toggleAudio({id:"a"}); root.toggleAudio({id:"a"}); complete("a",true); verify(!root.audioPlaying);
    }
    function test_switching_audio_stops_old_and_ignores_old_fetch() {
      root.toggleAudio({id:"a"}); root.toggleAudio({id:"b"}); complete("a",true); verify(!root.audioPlaying);
      complete("b",true); verify(root.audioPlaying); compare(root.playingAudio,"b");
      var token=root.audioResetToken; root.toggleAudio({id:"c"}); verify(!root.audioPlaying); verify(root.audioResetToken>token);
    }
    function test_failure_settles_intent_and_retry_fetches_again() {
      root.toggleAudio({id:"a"}); complete("a",false); verify(!root.audioPlaying); compare(root.pendingAudioId,"");
      root.toggleAudio({id:"a"}); compare(root.requests.length,2);
    }
    function test_decoder_failure_clears_source_and_allows_same_url_retry() {
      root.toggleAudio({id:"a"}); complete("a",true); root.failAudio("a");
      verify(!root.audioPlaying); compare(root.attFiles.a,"");
      root.toggleAudio({id:"a"}); complete("a",true); verify(root.audioPlaying);
    }
    function test_unrecognized_audio_never_gets_play_intent() {
      root.toggleAudio({id:"a"}); root.attFiles=({a:"file:///synthetic/disguised-playlist"});
      root.attMetrics=({a:{audio:{playable:false}}}); root.settleAudioFetch("a",true);
      verify(!root.audioPlaying); compare(root.playingAudio,"");
    }
    function test_missing_id_or_closed_surface_cannot_request_play() {
      root.toggleAudio({id:""}); root.surfaceOpen=false; root.toggleAudio({id:"a"}); compare(root.requests.length,0);
    }
  }
}
'''.replace('@FUNCTIONS@', '\n'.join(function(name) for name in ['toggleAudio','settleAudioFetch','failAudio','stopAudio']))
runner = shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-audio-session-') as tmp:
    path=Path(tmp); (path/'tst_audio.qml').write_text(qml)
    env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QUICK_BACKEND':'software','QT_QPA_PLATFORMTHEME':'generic'}
    result=subprocess.run([runner,'-input',tmp],env=env)
    raise SystemExit(result.returncode)
