import QtQuick
import QtQuick.Controls
import Quickshell.Io

TextArea {
  id: input
  objectName: "blipMessageInput"
  Accessible.role: Accessible.EditableText
  Accessible.name: "Message"
  Accessible.description: "Message draft. Enter sends; Shift+Enter inserts a new line."
  Accessible.editable: !readOnly
  Accessible.multiLine: true
  textFormat: TextEdit.PlainText
  selectByMouse: true
  property color spellingColor: "#e06c75"
  property var misspelled: []
  property int spellingRevision: 0
  property int checkedRevision: -1
  readonly property string spellingHelper: decodeURIComponent(Qt.resolvedUrl("spellcheck.ts").toString().replace(/^file:\/\//, ""))
  // Compare rendered lines so soft wraps behave like explicit newlines.
  function moveAtBoundary(key, modifiers) {
    if (modifiers !== Qt.NoModifier) return false
    if (key !== Qt.Key_Up && key !== Qt.Key_Down) return false
    var target = key === Qt.Key_Up ? 0 : text.length
    if (Math.abs(cursorRectangle.y - positionToRectangle(target).y) >= 1) return false
    cursorPosition = target
    return true
  }
  function checkSpelling() {
    if (checker.running || text.length > 8192 || text.length === 0 || readOnly) return
    checkedRevision = spellingRevision
    checker.command = ["bun", spellingHelper]
    checker.stdinEnabled = true
    checker.running = true
    checker.write(text)
    checker.stdinEnabled = false
  }
  onTextChanged: {
    spellingRevision++
    misspelled = []
    debounce.restart()
    underlines.requestPaint()
  }
  onWidthChanged: underlines.requestPaint()
  onContentHeightChanged: underlines.requestPaint()
  Timer { id: debounce; interval: 350; onTriggered: input.checkSpelling() }
  Process {
    id: checker
    stdout: StdioCollector {
      onStreamFinished: {
        if (input.checkedRevision !== input.spellingRevision || text.length > 16384) return
        try {
          var ranges = JSON.parse(text)
          if (!Array.isArray(ranges) || ranges.length > 256) return
          input.misspelled = ranges.filter(function(r) {
            return Number.isInteger(r.start) && Number.isInteger(r.end)
              && r.start >= 0 && r.end > r.start && r.end <= input.text.length && r.end-r.start <= 48
          })
          underlines.requestPaint()
        } catch (e) { }
      }
    }
    onExited: if (input.checkedRevision !== input.spellingRevision) debounce.restart()
  }
  Canvas {
    id: underlines
    anchors.fill: parent
    Accessible.ignored: true
    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      ctx.strokeStyle = input.spellingColor
      ctx.lineWidth = 1
      for (var i = 0; i < input.misspelled.length; i++) {
        var range = input.misspelled[i]
        for (var p = range.start; p < range.end; p++) {
          var a = input.positionToRectangle(p)
          var b = input.positionToRectangle(p+1)
          var right = Math.abs(a.y-b.y) < 1 ? b.x : a.x + input.font.pixelSize * 0.5
          ctx.beginPath()
          for (var x = a.x; x < right; x += 2) {
            var y = a.y + a.height - 1 + (Math.floor(x/2)%2)
            if (x === a.x) ctx.moveTo(x,y); else ctx.lineTo(x,y)
          }
          ctx.stroke()
        }
      }
    }
  }
}
