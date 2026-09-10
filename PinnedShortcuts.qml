import QtQuick

// Window-scoped shortcuts also work while a draft editor owns keyboard focus.
Item {
  id: root
  property var pins: []
  property bool active: false
  signal chosen(var thread)
  Repeater {
    model: 9
    delegate: Item {
      required property int index
      Shortcut {
        sequence: "Ctrl+" + (index + 1)
        context: Qt.WindowShortcut
        enabled: root.active
        onActivated: {
          var thread = root.pins[index]
          if (thread) root.chosen(thread)
        }
      }
    }
  }
}
