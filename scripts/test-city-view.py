#!/usr/bin/env python3
"""Exercise the shipping conversation header with synthetic bridge data only.

Requires Quickshell, Bun, and the installed Omarchy QML modules. All UI runs
offscreen with a private HOME/runtime; no desktop or real Mac is accessed.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


REPO = Path(__file__).resolve().parent.parent
OMARCHY_SHELL = Path("/usr/share/omarchy/shell")

CONTACTS = '''#!/usr/bin/env bun
if (process.argv.slice(2).join(" ") !== "--json shared-city") process.exit(64);
const request = JSON.parse(await Bun.stdin.text());
const unavailable = process.env.BLIP_CITY_VIEW_UNAVAILABLE === "1";
const city = !unavailable && request.handle === "+15550100011" ? "Portland, OR" : null;
const age = Number(process.env.BLIP_CITY_VIEW_AGE_MINUTES || 0);
console.log(JSON.stringify({ok:true,handle:request.handle,city,
  reason:city ? "available" : "location-unavailable",
  ...(city ? {observedAt:new Date(Date.now()-age*60000).toISOString(),
    expiresAt:new Date(Date.now()+300000).toISOString()} : {})}));
'''

SHELL = '''import QtQuick
import Quickshell
import qs.Commons
ShellRoot {
  id: test
  property bool failed: false
  function fail(reason, status) {
    failed = true
    console.error("CITY_VIEW_FAIL " + reason + " " + JSON.stringify(status))
    Qt.quit()
  }
  QtObject {
    id: host
    property var threads: [{chat:"+15550100011",handle:"+15550100011",
      name:"Jamie Rivera",service:"iMessage",unread:0,pinned:false,
      participants:[],last_ts:new Date().toISOString(),last_text:"Synthetic preview"}]
    property bool online: true
    property bool healthy: true
    property int unread: 0
    property string lastError: ""
    property var draftCache: ({})
    property var avatarCache: ({})
    property string binDir: Quickshell.env("HOME") + "/bin"
    property string readPush: "off"
    property bool tapbacks: false
    property int readActions: 0
    signal tapbackExited(string chat, bool ok)
    function refresh() {}
    function markAllRead() { readActions++ }
    function markThreadRead() { readActions++ }
    function markThreadUnread() { readActions++ }
    function conversationAct() {}
    function showApp() {}
    function takeTapbackFailure() { return "" }
  }
  FloatingWindow {
    visible: false
    implicitWidth: 1040
    implicitHeight: 720
    BlipView {
      id: view
      anchors.fill: parent
      hostWidget: host
      surfaceOpen: true
      readActive: false
      splitView: Quickshell.env("BLIP_CITY_VIEW_MODE") === "app"
      themeFont: Style.font.family
    }
  }
  Component.onCompleted: Qt.callLater(function() { view.openThread(host.threads[0]) })
  Timer {
    interval: 25
    repeat: true
    running: true
    onTriggered: {
      var status = view.cityStatus()
      var unavailable = Quickshell.env("BLIP_CITY_VIEW_UNAVAILABLE") === "1"
      if (unavailable ? !status.headerShowsLocationState : !status.headerUsesCity) return
      if (!status.surfaceOpen || !status.inThread || status.group
          || !status.lookup.active || !status.lookup.ready
          || status.lookup.policy.reason !== (unavailable ? "location-unavailable" : "available")
          || status.lookup.policy.visible === unavailable || host.readActions !== 0) {
        test.fail("invalid header state", status)
        return
      }
      console.log("CITY_VIEW_PASS " + (unavailable ? "unavailable" : view.splitView ? "app" : "panel"))
      Qt.quit()
    }
  }
  Timer {
    interval: 12000
    running: true
    onTriggered: test.fail("timeout", view.cityStatus())
  }
}
'''


def main():
    for tool in ("quickshell", "bun"):
        if not shutil.which(tool):
            raise SystemExit(f"Required tool not found: {tool}")
    if not OMARCHY_SHELL.is_dir():
        raise SystemExit("Installed Omarchy shell modules are required")
    with tempfile.TemporaryDirectory(prefix="blip-city-view-") as scratch:
        folder = Path(scratch)
        shell = folder / "shell"
        home = folder / "home"
        runtime = folder / "run"
        shutil.copytree(OMARCHY_SHELL, shell)
        for pattern in ("*.qml", "*.ts", "*.mjs"):
            for source in REPO.glob(pattern):
                shutil.copy2(source, shell / source.name)
        shutil.copytree(REPO / "icons", shell / "icons")
        shutil.copy2(REPO / "manifest.json", shell / "manifest.json")
        shutil.copy2(REPO / "otp-desktop.py", shell / "otp-desktop.py")
        for relative in ("bin", ".config/blip", ".cache", ".local/share", ".local/state"):
            (home / relative).mkdir(parents=True, exist_ok=True)
        runtime.mkdir(mode=0o700)
        (home / ".config/blip/bridge.conf").write_text(
            "shared_city=on\nlink_previews=off\npush_read=off\n")
        (home / "bin/contacts").write_text(CONTACTS)
        (home / "bin/imsg").write_text(
            '#!/usr/bin/env bash\nexec bun "$BLIP_CITY_FAKE_IMSG" "$@"\n')
        for tool in ("ssh", "imsg-send", "imsg-read", "imsg-react", "contact-save"):
            (home / "bin" / tool).write_text("#!/usr/bin/env bash\nexit 64\n")
        for tool in (home / "bin").iterdir():
            tool.chmod(0o755)
        (shell / "shell.qml").write_text(SHELL)
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
                   XDG_CACHE_HOME=str(home / ".cache"), XDG_DATA_HOME=str(home / ".local/share"),
                   XDG_STATE_HOME=str(home / ".local/state"), XDG_RUNTIME_DIR=str(runtime),
                   QT_QPA_PLATFORM="offscreen", QT_QPA_PLATFORMTHEME="generic",
                   QT_QUICK_CONTROLS_STYLE="Basic", QT_STYLE_OVERRIDE="Fusion",
                   BLIP_CITY_FAKE_IMSG=str(REPO / "scripts/demo/fake-imsg"))
        env["PATH"] = str(home / "bin") + os.pathsep + env.get("PATH", "")
        for key in ("WAYLAND_DISPLAY", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE",
                    "BLIP_BRIDGE_CONF", "BLIP_MAC_HOST"):
            env.pop(key, None)
        for mode, age in (("panel", "0"), ("app", "67"), ("unavailable", "0")):
            current = dict(env, BLIP_CITY_VIEW_MODE=mode, BLIP_CITY_VIEW_AGE_MINUTES=age,
                           BLIP_CITY_VIEW_UNAVAILABLE="1" if mode == "unavailable" else "0")
            result = subprocess.run(["quickshell", "-n", "-p", str(shell)], env=current,
                                    capture_output=True, text=True, timeout=20)
            output = result.stdout + result.stderr
            marker = "CITY_VIEW_PASS " + mode
            if result.returncode or marker not in output or "CITY_VIEW_FAIL" in output:
                raise SystemExit(output)
            print(f"BlipView {mode}: shipping location header and active surface passed")


if __name__ == "__main__":
    main()
