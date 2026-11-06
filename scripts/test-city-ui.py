#!/usr/bin/env python3
"""Exercise the shipping city component against synthetic asynchronous replies."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='blip-city-ui-') as scratch:
    folder = Path(scratch)
    for name in ('SharedCity.qml', 'City.mjs'):
        shutil.copy2(REPO / name, folder / name)
    (folder / 'city.ts').write_text('''
const request = JSON.parse(await Bun.stdin.text());
const startedAt = Date.now();
if (request.chat === "+15550100022") await Bun.sleep(600);
const city = request.chat === "+15550100011" ? "Portland, OR"
  : request.chat === "+15550100022" ? "Boston, MA" : "Paris, France";
console.log(JSON.stringify({ok:true,chat:request.chat,city,startedAt,
  observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()}));
''')
    (folder / 'shell.qml').write_text('''
import QtQuick
import Quickshell
ShellRoot {
  id: test
  property int stage: 0
  property double stageAt: Date.now()
  property double reopenedAt: 0
  function check(ok, reason) {
    if (!ok) { console.error("CITY_UI_FAIL " + reason); Qt.quit(); }
    return ok
  }
  FloatingWindow { visible: true; implicitWidth: 1; implicitHeight: 1; SharedCity { id: lookup; chat: "+15550100011"; active: true } }
  Timer {
    interval: 25; repeat: true; running: true
    onTriggered: {
      if (test.stage === 0 && lookup.city === "Portland, OR") {
        var expired = JSON.parse(JSON.stringify(lookup.record))
        expired.expiresAt = new Date(Date.now() - 1).toISOString()
        lookup.record = expired
        lookup.clock = Date.now()
        if (!test.check(lookup.city === "", "expiry")) return
        lookup.chat = "+15550100022"
        if (!test.check(lookup.city === "", "conversation switch")) return
        test.stage = 1; test.stageAt = Date.now()
      } else if (test.stage === 1 && Date.now() - test.stageAt > 200) {
        lookup.active = false
        if (!test.check(lookup.city === "" && lookup.record === null, "close")) return
        test.reopenedAt = Date.now()
        lookup.active = true
        test.stage = 2
      } else if (test.stage === 2 && lookup.city !== "") {
        if (!test.check(lookup.city === "Boston, MA", "wrong city")) return
        if (!test.check(lookup.record.startedAt >= test.reopenedAt, "late same-chat reply")) return
        lookup.chat = "+15550100033"
        if (!test.check(lookup.city === "", "old city during new lookup")) return
        test.stage = 3
      } else if (test.stage === 3 && lookup.city === "Paris, France") {
        lookup.active = false
        if (!test.check(lookup.city === "" && lookup.record === null, "final close")) return
        console.log("CITY_UI_PASS")
        Qt.quit()
      }
    }
  }
  Timer { interval: 8000; running: true; onTriggered: { console.error("CITY_UI_FAIL timeout", test.stage); Qt.quit() } }
}
''')
    env = dict(os.environ, QT_QPA_PLATFORM='offscreen')
    result = subprocess.run(['quickshell', '-n', '-p', str(folder)], env=env,
                            capture_output=True, text=True, timeout=15)
    output = result.stdout + result.stderr
    if result.returncode or 'CITY_UI_PASS' not in output or 'CITY_UI_FAIL' in output:
        raise SystemExit(output)
    print('SharedCity QML: expiry, switching, close/reopen and late reply checks passed')
