#!/usr/bin/env python3
"""Exercise the shipping reaction picker with synthetic data in isolated QtTest.

No Blip host, bridge, message database, network, or real desktop keys are used.
Optionally save a PNG with --screenshot PATH for visual inspection.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


HARNESS = '''import QtQuick
import QtQuick.Controls
import QtTest
import "."
Rectangle {
    id: root
    width: 380; height: 680
    color: "#202126"
    ReactionPicker {
        id: picker
        width: 314
        palette.window: "#292a30"
        palette.windowText: "#f4f4f5"
        palette.text: "#f4f4f5"
        palette.base: "#202126"
        palette.highlight: "#0a84ff"
        font.pixelSize: 13
    }
    MessageMenu {
        id: menu
        tapbacksShown: true
        canQuote: true
        canCopy: true
        palette: picker.palette
        font: picker.font
    }
    SignalSpy { id: choice; target: picker; signalName: "chosen" }
    SignalSpy { id: glyph; target: picker; signalName: "emojiChosen" }
    TestCase {
        name: "ReactionPicker"
        when: windowShown
        function init() {
            menu.close()
            picker.visible = true
            picker.showClassics = true
            picker.busy = false
            picker.currentKind = ""
            picker.reset(true)
            picker.forceActiveFocus()
            choice.clear(); glyph.clear()
        }
        function test_classic_number_keys_and_busy_gate() {
            var kinds = ["love", "like", "dislike", "laugh", "emphasize", "question"]
            for (var n = 0; n < 6; n++) {
                picker.forceActiveFocus(); keyClick(Qt.Key_1 + n)
                compare(choice.signalArguments[n][0], kinds[n])
            }
            compare(choice.count, 6)
            picker.busy = true
            picker.forceActiveFocus(); keyClick(Qt.Key_1)
            compare(choice.count, 6)
        }
        function test_more_focus_search_and_exact_choice() {
            picker.cursor = 6
            picker.forceActiveFocus(); keyClick(Qt.Key_Return)
            verify(picker.expanded)
            var search = findChild(picker, "reactionEmojiSearch")
            var grid = findChild(picker, "reactionEmojiGrid")
            tryVerify(function() { return search.activeFocus })
            search.text = "👩🏽‍💻"
            tryCompare(grid, "count", 1)
            search.forceActiveFocus(); keyClick(Qt.Key_Return)
            compare(choice.signalArguments[0][0], "emoji:👩🏽‍💻")
            compare(glyph.signalArguments[0][0], "👩🏽‍💻")
        }
        function test_grid_navigation_and_choice() {
            picker.expanded = true
            var search = findChild(picker, "reactionEmojiSearch")
            var grid = findChild(picker, "reactionEmojiGrid")
            search.text = "rocket"
            search.forceActiveFocus()
            tryCompare(grid, "count", 1)
            search.forceActiveFocus(); keyClick(Qt.Key_Down)
            verify(grid.activeFocus)
            grid.forceActiveFocus(); keyClick(Qt.Key_Return)
            compare(glyph.count, 1)
            compare(glyph.signalArguments[0][0], "🚀")
        }
        function test_composer_has_catalogue_without_classic_strip() {
            picker.showClassics = false
            picker.reset(false)
            verify(picker.expanded)
            var search = findChild(picker, "reactionEmojiSearch")
            var grid = findChild(picker, "reactionEmojiGrid")
            search.text = "rocket"
            tryCompare(grid, "count", 1)
            search.forceActiveFocus()
            search.forceActiveFocus(); keyClick(Qt.Key_Return)
            compare(glyph.count, 1)
            compare(glyph.signalArguments[0][0], "🚀")
        }
        function test_menu_expansion_remains_in_window() {
            picker.visible = false
            menu.popup(root, 20, 620)
            tryVerify(function() { return menu.visible })
            var inner = findChild(menu, "blipReactionPicker")
            verify(inner !== null)
            inner.cursor = 6
            inner.forceActiveFocus()
            inner.forceActiveFocus(); keyClick(Qt.Key_Return)
            tryVerify(function() { return inner.expanded })
            wait(80)
            verify(menu.height > 400)
            // Popup's visual item is fitted independently of requested x/y.
            var visual = menu.contentItem.mapToItem(root, 0, 0)
            verify(visual.y >= 0)
            verify(visual.y + menu.contentItem.height <= root.height + 1)
            @SCREENSHOT@
        }
    }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    runner = os.environ.get("QMLTESTRUNNER") or shutil.which("qmltestrunner")
    if not runner:
        runner = next((str(p) for p in (Path("/usr/lib/qt6/bin/qmltestrunner"), Path("/usr/lib/qt/bin/qmltestrunner")) if p.exists()), None)
    if not runner:
        parser.error("Qt 6 qmltestrunner is required")
    screenshot = ""
    if args.screenshot:
        path = args.screenshot.resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        screenshot = "menu.contentItem.grabToImage(function(result) { result.saveToFile(" + json.dumps(str(path)) + ") }); wait(120)"
    with tempfile.TemporaryDirectory(prefix="blip-reaction-ui-") as directory:
        dest = Path(directory)
        for name in ("ReactionPicker.qml", "MessageMenu.qml", "TapbackActions.mjs"):
            shutil.copyfile(repo / name, dest / name)
        (dest / "tst_reactions.qml").write_text(HARNESS.replace("@SCREENSHOT@", screenshot))
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_CONTROLS_STYLE="Basic", QT_QPA_PLATFORMTHEME="")
        return subprocess.run([runner, "-input", directory, "-o", "-,txt"], env=env, timeout=30).returncode


if __name__ == "__main__":
    raise SystemExit(main())
