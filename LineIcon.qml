import QtQuick

// Shared 24-unit icon geometry keeps stroke weight independent of font glyphs.
Canvas {
  id: root
  property string name: ""
  property color color: "white"
  implicitWidth: 20
  implicitHeight: 20
  onNameChanged: requestPaint()
  onColorChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()
  onPaint: {
    var c = getContext("2d")
    c.reset()
    c.scale(width / 24, height / 24)
    c.strokeStyle = color
    c.fillStyle = color
    c.lineWidth = 1.8
    c.lineCap = "round"
    c.lineJoin = "round"
    function line(points) {
      c.beginPath(); c.moveTo(points[0], points[1])
      for (var i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1])
      c.stroke()
    }
    if (name === "plus") { line([5,12,19,12]); line([12,5,12,19]) }
    else if (name === "send") { line([12,20,12,4]); line([5,11,12,4,19,11]) }
    else if (name === "back") { line([15,5,8,12,15,19]) }
    else if (name === "check") { line([5,12,10,17,19,7]) }
    else if (name === "search") {
      c.beginPath(); c.arc(10,10,6.5,0,Math.PI*2); c.stroke(); line([15,15,21,21])
    } else if (name === "more") {
      for (var j=0; j<3; j++) { c.beginPath(); c.arc(5+j*7,12,1.4,0,Math.PI*2); c.fill() }
    } else if (name === "emoji") {
      c.beginPath(); c.arc(12,12,9,0,Math.PI*2); c.stroke()
      for (var eye=0; eye<2; eye++) { c.beginPath(); c.arc(8.5+eye*7,9.5,0.9,0,Math.PI*2); c.fill() }
      c.beginPath(); c.arc(12,12,5,0.20*Math.PI,0.80*Math.PI); c.stroke()
    } else if (name === "compose") {
      line([19,13,19,19,5,19,5,5,11,5])
      line([10,14,11,10,18,3,21,6,14,13,10,14]); line([16,5,19,8])
    } else if (name === "window") {
      line([10,5,4,5,4,20,19,20,19,14]); line([13,3,21,3,21,11]); line([11,13,21,3])
    }
  }
}
