import QtQuick
import QtQuick.Effects
import qs.Commons

// The Google Cloud mark, tinted to the theme.
//
// The asset is a single white path, and one file is enough for every Omarchy
// theme: MultiEffect colorization replaces its colour with `color`, the same
// trick the GitHub notifications widget uses for its mark. Source and licence:
// see the note in README.md.
Item {
  id: root

  property color color: Color.foreground
  // 0 means "use the box I was given" (the bar hands the widget the optical
  // canvas, which the bar sizes itself). The panel hero passes its own size.
  property real size: 0
  // The mark is a filled shape where the bar's other icons are line art, so it
  // is drawn smaller than the slot it sits in to read at the same weight, the
  // same way the notifications widget sizes its mark. Tuned against the stock
  // nerd-font glyphs in the bar.
  property real markScale: 0.7

  readonly property real boxSize: root.size > 0 ? root.size : Math.max(1, Math.min(width, height))
  readonly property real markSize: Math.max(1, Math.round(root.boxSize * root.markScale))

  implicitWidth: root.size > 0 ? root.size : Style.bar.iconCanvas
  implicitHeight: implicitWidth

  // Only ever a source for the effect below: ShaderEffectSource renders it
  // whether or not it is visible, so it is not drawn twice.
  Image {
    id: source
    // Centered at `markSize` rather than filling the parent: the bar's icon
    // loader fills this item with the whole optical canvas, so filling the
    // parent would paint the cloud across the canvas instead of inside it.
    anchors.centerIn: parent
    width: root.markSize
    height: root.markSize
    source: Qt.resolvedUrl("assets/google-cloud.svg")
    sourceSize.width: Math.max(2, Math.round(root.markSize * 2))
    sourceSize.height: Math.max(2, Math.round(root.markSize * 2))
    fillMode: Image.PreserveAspectFit
    smooth: true
    visible: false
  }

  MultiEffect {
    anchors.fill: source
    source: source
    colorization: 1.0
    colorizationColor: root.color
    autoPaddingEnabled: false

    Behavior on colorizationColor {
      ColorAnimation { duration: 160 }
    }
  }
}
