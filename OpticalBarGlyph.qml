import qs.Commons
import qs.Ui

// The bar glyph drawn like stock Omarchy bar icons (#153). Needs
// OpticalGlyph.paintedSize, which Omarchy has from 4.5. BarWidget.qml loads this
// file through a Loader and falls back to plain text where it cannot compile, so
// nothing else may assign paintedSize.
OpticalGlyph {
  anchors.fill: parent
  paintedSize: Style.bar.iconSize
}
