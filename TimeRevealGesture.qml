import QtQuick
import "TimeReveal.mjs" as TimeReveal

// State for the sideways swipe that reveals message times. The conversation's
// wheel handler feeds it; rows read `progress`. Decisions live in time-reveal.ts.
Item {
  id: gesture
  property real maxOffset: 72
  property real offset: 0
  property bool tracking: false
  property var wheelState: TimeReveal.idleGesture()
  readonly property real progress: maxOffset > 0 ? Math.max(0, Math.min(1, offset / maxOffset)) : 0

  /** Returns the vertical delta the caller should still scroll by. */
  function route(dx, dy) {
    var routed = TimeReveal.routeWheel(wheelState, dx, dy)
    wheelState = routed.gesture
    idle.restart()
    if (routed.dx !== 0) {
      tracking = true
      hold.stop()
      offset = TimeReveal.nextOffset(offset, routed.dx, maxOffset)
    }
    return routed.dy
  }

  Behavior on offset {
    enabled: !gesture.tracking
    NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
  }
  Timer {
    id: idle
    interval: 120
    onTriggered: {
      gesture.wheelState = TimeReveal.idleGesture()
      if (!gesture.tracking) return
      gesture.tracking = false
      hold.interval = TimeReveal.settleDelay(gesture.offset, gesture.maxOffset)
      hold.restart()
    }
  }
  Timer { id: hold; onTriggered: gesture.offset = 0 }
}
