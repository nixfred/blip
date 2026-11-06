import QtQuick
import qs.Commons
import qs.Commons as Commons

// Shared by Blip's conversation view, bar host and OTP prompt. Keep visual
// policy here so typography and palette changes reach every Blip surface.
QtObject {
  property var hostWidget: null
  property string themeFont: Style.font.family
  property color foreground: Commons.Color.foreground
  readonly property color background: Commons.Color.background
  readonly property color muted: Qt.alpha(foreground, 0.66)
  readonly property color accent: "#0a84ff"
  readonly property color accentText: "#ffffff"
  readonly property real cornerRadius: Style.cornerRadius
  readonly property real borderWidth: Math.max(1, Style.normalBorderWidth)
  /**
   * The font Messages actually uses, when this machine has it.
   *
   * Omarchy resolves its family to JetBrainsMono system-wide, so every label
   * here was monospace — the loudest remaining difference from Messages, more
   * than any spacing. Apple ships SF Pro Text with Messages; a machine themed
   * to look like a Mac usually already has it, and Qt.fontFamilies() says so
   * for certain rather than guessing (asking for a missing family silently
   * yields a default sans, which would be a worse wrong answer than the
   * theme font).
   * Order: SF Pro if the machine has it, then Inter — which is OFL-licensed,
   * ships in Arch's `extra`, and was drawn for exactly this job — then an installed Linux sans family. Explicit theme typography remains
   * available through ui_font=theme.
   * `ui_font=theme` in bridge.conf opts out.
   *
   * Blip will never SHIP a font: SF Pro is Apple's and its licence forbids
   * redistribution, which is why blip-setup installs Inter and only points at
   * Apple's own download for SF Pro.
   */
  readonly property string messagesFont: {
    var want = ["SF Pro Text", "SF Pro Display", "SF Pro", "Inter", "Adwaita Sans", "Noto Sans", "Liberation Sans"]
    var have = Qt.fontFamilies()
    for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) >= 0) return want[i]
    return ""
  }
  readonly property bool themeFontForced: !!hostWidget && hostWidget.uiFontTheme === true
  readonly property string fontFamily:
    (messagesFont !== "" && !themeFontForced) ? messagesFont : themeFont
  // `ui_font_size=N` in bridge.conf: N is bubble text in px. Unset (0) keeps
  // the readable sans default. Caption/body keep the same ratios as Style.font.
  readonly property int uiFontSizePx: {
    if (!hostWidget) return 0
    var n = hostWidget.uiFontSize
    return (typeof n === "number" && n > 0) ? n : 0
  }
  readonly property real uiFontScale: {
    if (uiFontSizePx <= 0) return themeFontForced ? 1 : Math.max(1, 13 / Style.font.bodySmall)
    var small = Style.font.bodySmall
    return small > 0 ? uiFontSizePx / small : 1
  }
  readonly property int fontTitle: Math.max(1, Math.round(Style.font.title * uiFontScale))
  readonly property int fontCaption: Math.max(1, Math.round(Style.font.caption * uiFontScale))
  readonly property int fontBodySmall: Math.max(1, Math.round(Style.font.bodySmall * uiFontScale))
  readonly property int fontBody: Math.max(1, Math.round(Style.font.body * uiFontScale))
}
