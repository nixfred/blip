import QtQuick
import Quickshell
import Quickshell.Io

// Live, file-backed appearance preferences shared by the popout and app.
// preferences.ts is the trust boundary: it caps and validates the writable
// JSON before this long-lived shell process sees a small normalized object.
Item {
  id: root
  visible: false
  implicitWidth: 0
  implicitHeight: 0

  readonly property string home: Quickshell.env("HOME")
  readonly property string configPath: home + "/.config/blip/preferences.json"
  readonly property string helperPath:
    decodeURIComponent(Qt.resolvedUrl("preferences.ts").toString().replace(/^file:\/\//, ""))

  property string outgoingBubbleColor: "theme"
  property string incomingBubbleColor: "theme"
  property real backgroundOpacity: 0.70
  property real fontScale: 1.0
  property real density: 1.0
  property int sidebarWidth: 320
  property int avatarSize: 34
  property real cornerScale: 1.0
  property bool hideShortCodeConversations: true
  property bool use12HourConversationTimes: true

  property bool loaded: false
  property bool exists: false
  property bool saving: false
  property bool dirty: false
  property string error: ""
  property string notice: "Loading preferences…"
  property string lastSerialized: ""

  function defaults() {
    return {
      schemaVersion: 1,
      outgoingBubbleColor: "theme",
      incomingBubbleColor: "theme",
      backgroundOpacity: 0.70,
      fontScale: 1.0,
      density: 1.0,
      sidebarWidth: 320,
      avatarSize: 34,
      cornerScale: 1.0,
      hideShortCodeConversations: true,
      use12HourConversationTimes: true
    }
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      outgoingBubbleColor: outgoingBubbleColor,
      incomingBubbleColor: incomingBubbleColor,
      backgroundOpacity: Math.round(backgroundOpacity * 100) / 100,
      fontScale: Math.round(fontScale * 100) / 100,
      density: Math.round(density * 100) / 100,
      sidebarWidth: Math.round(sidebarWidth),
      avatarSize: Math.round(avatarSize),
      cornerScale: Math.round(cornerScale * 100) / 100,
      hideShortCodeConversations: hideShortCodeConversations,
      use12HourConversationTimes: use12HourConversationTimes
    }
  }

  function finiteIn(value, low, high) {
    return typeof value === "number" && isFinite(value) && value >= low && value <= high
  }

  function validColor(value) {
    return typeof value === "string" &&
      (value === "theme" || /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value))
  }

  // Defense in depth: verify the helper's normalized object again before any
  // value is retained by the shell or used in geometry.
  function applyPreferences(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1)
      return false
    if (!validColor(value.outgoingBubbleColor) || !validColor(value.incomingBubbleColor)) return false
    if (!finiteIn(value.backgroundOpacity, 0.2, 1.0)) return false
    if (!finiteIn(value.fontScale, 0.75, 1.5)) return false
    if (!finiteIn(value.density, 0.7, 1.4)) return false
    if (!finiteIn(value.sidebarWidth, 240, 520)) return false
    if (!finiteIn(value.avatarSize, 24, 64)) return false
    if (!finiteIn(value.cornerScale, 0, 2)) return false
    if (typeof value.hideShortCodeConversations !== "boolean") return false
    if (typeof value.use12HourConversationTimes !== "boolean") return false

    var normalized = {
      schemaVersion: 1,
      outgoingBubbleColor: value.outgoingBubbleColor,
      incomingBubbleColor: value.incomingBubbleColor,
      backgroundOpacity: Math.round(value.backgroundOpacity * 100) / 100,
      fontScale: Math.round(value.fontScale * 100) / 100,
      density: Math.round(value.density * 100) / 100,
      sidebarWidth: Math.round(value.sidebarWidth),
      avatarSize: Math.round(value.avatarSize),
      cornerScale: Math.round(value.cornerScale * 100) / 100,
      hideShortCodeConversations: value.hideShortCodeConversations,
      use12HourConversationTimes: value.use12HourConversationTimes
    }
    var serialized = JSON.stringify(normalized)
    // Keep bindings and slider delegates untouched when the periodic bounded
    // read returns the same file contents.
    if (loaded && serialized === lastSerialized) return true
    outgoingBubbleColor = normalized.outgoingBubbleColor
    incomingBubbleColor = normalized.incomingBubbleColor
    backgroundOpacity = normalized.backgroundOpacity
    fontScale = normalized.fontScale
    density = normalized.density
    sidebarWidth = normalized.sidebarWidth
    avatarSize = normalized.avatarSize
    cornerScale = normalized.cornerScale
    hideShortCodeConversations = normalized.hideShortCodeConversations
    use12HourConversationTimes = normalized.use12HourConversationTimes
    lastSerialized = serialized
    return true
  }

  function safeError(value) {
    return String(value || "Preference operation failed")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 180)
  }

  function consumeRead(raw) {
    if (raw.length > 4096) {
      error = "Preference helper returned too much data"
      return
    }
    try {
      var result = JSON.parse(raw.trim())
      if (!result || result.ok !== true) {
        error = safeError(result ? result.error : "Preference helper failed")
        loaded = true
        return
      }
      if (!applyPreferences(result.preferences)) {
        error = "Preference helper returned an invalid schema"
        loaded = true
        return
      }
      exists = result.exists === true
      error = ""
      loaded = true
      notice = exists ? "Loaded preferences.json" : "Using defaults; creating preferences.json…"
      if (!exists) scheduleSave()
    } catch (e) {
      error = "Preference helper returned invalid JSON"
      loaded = true
    }
  }

  function load(force) {
    if (reader.running || writer.running) return
    if (!force && dirty) return
    if (force) {
      dirty = false
      saveTimer.stop()
    }
    reader.command = ["bun", helperPath, "read"]
    reader.running = true
  }

  function scheduleSave() {
    dirty = true
    notice = "Unsaved changes…"
    saveTimer.restart()
  }

  function writeNow() {
    if (writer.running) {
      saveTimer.restart()
      return
    }
    writer.payload = JSON.stringify(snapshot())
    writer.resultOk = false
    writer.stdinEnabled = true
    dirty = false
    saving = true
    notice = "Saving…"
    writer.command = ["bun", helperPath, "write"]
    writer.running = true
  }

  function setColor(key, value) {
    var color = String(value || "").trim().toLowerCase()
    if (!validColor(color)) return false
    if (key === "outgoingBubbleColor") outgoingBubbleColor = color
    else if (key === "incomingBubbleColor") incomingBubbleColor = color
    else return false
    scheduleSave()
    return true
  }

  function setNumber(key, value) {
    var number = Number(value)
    if (key === "backgroundOpacity" && finiteIn(number, 0.2, 1.0)) backgroundOpacity = number
    else if (key === "fontScale" && finiteIn(number, 0.75, 1.5)) fontScale = number
    else if (key === "density" && finiteIn(number, 0.7, 1.4)) density = number
    else if (key === "sidebarWidth" && finiteIn(number, 240, 520)) sidebarWidth = Math.round(number)
    else if (key === "avatarSize" && finiteIn(number, 24, 64)) avatarSize = Math.round(number)
    else if (key === "cornerScale" && finiteIn(number, 0, 2)) cornerScale = number
    else return false
    scheduleSave()
    return true
  }

  function setBoolean(key, value) {
    if (typeof value !== "boolean") return false
    if (key === "hideShortCodeConversations") hideShortCodeConversations = value
    else if (key === "use12HourConversationTimes") use12HourConversationTimes = value
    else return false
    scheduleSave()
    return true
  }

  function restoreDefaults() {
    applyPreferences(defaults())
    scheduleSave()
  }

  Timer {
    id: saveTimer
    interval: 350
    onTriggered: root.writeNow()
  }

  // A restored dotfile is picked up without restarting the shell. Polling the
  // bounded helper avoids feeding the writable file itself into FileView.
  Timer {
    interval: 5000
    repeat: true
    running: true
    onTriggered: root.load(false)
  }

  Process {
    id: reader
    stdout: StdioCollector { onStreamFinished: root.consumeRead(text) }
  }

  Process {
    id: writer
    property string payload: ""
    property bool resultOk: false
    stdout: StdioCollector {
      onStreamFinished: {
        if (text.length > 4096) {
          root.error = "Preference writer returned too much data"
          return
        }
        try {
          var result = JSON.parse(text.trim())
          writer.resultOk = result && result.ok === true
          if (!writer.resultOk) root.error = root.safeError(result ? result.error : "Preference write failed")
          else if (!root.dirty && !root.applyPreferences(result.preferences)) {
            writer.resultOk = false
            root.error = "Preference writer returned an invalid schema"
          }
        } catch (e) {
          root.error = "Preference writer returned invalid JSON"
        }
      }
    }
    onStarted: {
      write(payload)
      stdinEnabled = false
    }
    onExited: function(code, status) {
      root.saving = false
      if (code === 0 && resultOk) {
        root.exists = true
        root.error = ""
        root.notice = "Saved to preferences.json"
      } else if (root.error === "") {
        root.error = "Could not save preferences.json"
      }
      if (root.dirty) saveTimer.restart()
    }
  }

  Component.onCompleted: load(false)
}
