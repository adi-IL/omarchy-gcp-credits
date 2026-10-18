import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import qs.Commons
// Aliased, because QtQuick exports a `Color` value type of its own and an
// unqualified name resolves to that instead of the qs.Commons singleton:
// `Color.foreground` would quietly be undefined and every tint in this panel
// would come out wrong. The kit's own files reach for `Commons.Color` for the
// same reason.
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The GCP Credits popup: the credits behind the bar label.
//
// The widget owns polling and state; this panel only mirrors `hostWidget.view`
// and asks the widget to refresh, so the label and the panel can never disagree
// about the same snapshot. Nothing here fetches: a cold fetch drives a headless
// Chromium for about four seconds, and only the widget's one-at-a-time rule
// makes that safe to ask for.
Panel {
    id: root
    moduleName: "adix.gcp-credits"
    // The bar widget owns the plugin's IPC target (it is the thing that lives
    // for the whole session), so this panel registers no handler of its own. It
    // still has to say so: a loaded Panel with manageIpc left at its default
    // would register a second handler for the same target and shadow the
    // widget's.
    manageIpc: false

    property var anchorItem: null
    property var hostWidget: null

    readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
    readonly property color dim: Qt.darker(foreground, 1.5)
    readonly property color accent: Commons.Color.accent
    readonly property color warn: bar ? bar.urgent : Commons.Color.urgent
    readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

    readonly property var view: hostWidget && hostWidget.view ? hostWidget.view : Model.loadingView()
    // Both come from the widget, which read them off the plugin's settings.
    readonly property string mode: hostWidget ? hostWidget.amountMode : "compact"
    readonly property bool showSpent: hostWidget ? hostWidget.showSpentCredits === true : false

    readonly property var totals: view.totals || []
    readonly property var credits: Model.visibleCredits(view.credits, root.showSpent)
    readonly property int hiddenCredits: Model.hiddenCreditCount(view.credits, root.showSpent)
    readonly property bool isOk: view.ok === true
    readonly property bool isLoading: view.loading === true

    // The panel never fetches; it asks, and the widget queues the request if a
    // fetch is already in flight.
    function refreshNow() {
        if (hostWidget && typeof hostWidget.refreshNow === "function")
            hostWidget.refreshNow();
    }

    // Same division: the widget owns the account id and the launcher call, so
    // the URL is built in exactly one place.
    function openConsole() {
        if (hostWidget && typeof hostWidget.openConsole === "function")
            hostWidget.openConsole();
        root.close();
    }

    // Switching panels with Tab: the bar's coordinator matches on the bar widget
    // item, not on this panel, so the widget is what gets handed over.
    function switchPanel(direction) {
        if (bar && typeof bar.switchPanelFrom === "function")
            return bar.switchPanelFrom(root.hostWidget || root, direction);
        return false;
    }

    KeyboardPanel {
        id: popup
        anchorItem: root.anchorItem
        owner: root.hostWidget || root
        bar: root.bar
        open: root.opened
        focusTarget: keyCatcher
        contentWidth: popup.fittedContentWidth(Style.space(380))
        contentHeight: popup.fittedContentHeight(column.implicitHeight, Style.space(620))

        PanelKeyCatcher {
            id: keyCatcher
            anchors.fill: parent

            onCloseRequested: root.close()
            onTextKey: function (t) {
                if (t === "r" || t === "R")
                    root.refreshNow();
                else if (t === "o" || t === "O")
                    root.openConsole();
            }

            Flickable {
                id: flick
                anchors.fill: parent
                contentWidth: width
                contentHeight: column.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.VerticalFlick
                interactive: contentHeight > height
                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                }

                Column {
                    id: column
                    width: flick.width
                    spacing: Style.space(10)

                    // ---- who and when ------------------------------------------
                    // The billing account and the age of the snapshot: the two
                    // things that decide whether the numbers below are even
                    // about the account the reader thinks they are.
                    PanelHero {
                        id: hero
                        width: parent.width
                        title: "GCP Credits"
                        meta: Model.heroMeta(root.view)
                        detail: Model.heroDetail(root.view)
                        foreground: root.foreground
                        fontFamily: root.fontFamily

                        iconComponent: Component {
                            GoogleCloudMark {
                                size: hero.iconSize
                                color: root.foreground
                            }
                        }
                    }

                    // ---- a snapshot that is not ok says so, and nothing else ---
                    // The helper's own code, message and hint, verbatim: they
                    // name the next command to run (`gcp-credits login`,
                    // `setup`, `doctor`) and that is the whole recovery path.
                    Column {
                        visible: !root.isOk
                        width: parent.width
                        spacing: Style.space(2)

                        Text {
                            width: parent.width
                            textFormat: Text.PlainText
                            text: Model.errorText(root.view)
                            color: root.isLoading ? root.dim : root.warn
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                            // Text.Wrap, not WordWrap: an error is arbitrary
                            // text, and a token with no spaces (a hash, a base64
                            // blob, a URL) must break inside the card instead of
                            // running past its edge unclipped.
                            wrapMode: Text.Wrap
                        }

                        Text {
                            width: parent.width
                            visible: text !== ""
                            textFormat: Text.PlainText
                            text: Model.errorCode(root.view)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.Wrap
                        }

                        Text {
                            width: parent.width
                            visible: text !== ""
                            textFormat: Text.PlainText
                            text: Model.errorHint(root.view)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.Wrap
                        }
                    }

                    PanelSeparator {
                        visible: root.isOk
                        foreground: root.foreground
                    }

                    // ---- one line per currency ---------------------------------
                    // Credits are issued in the billing account's own currency
                    // plus, often, one or two others, so the totals are never
                    // added up across currencies: usable, remaining and the
                    // original issue are shown per currency, in the helper's
                    // usable-first order.
                    Column {
                        visible: root.isOk
                        width: parent.width
                        spacing: Style.space(4)

                        PanelSectionHeader {
                            width: parent.width
                            text: "By currency"
                            foreground: root.foreground
                            fontFamily: root.fontFamily
                        }

                        // A snapshot with more currencies than the view keeps:
                        // the list below is the first slice, and this says so
                        // above the rows, where a full card cannot hide it.
                        Text {
                            width: parent.width
                            visible: text !== ""
                            textFormat: Text.PlainText
                            text: Model.droppedTotalsNote(root.view)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.WordWrap
                        }

                        Repeater {
                            model: root.totals

                            delegate: Text {
                                required property var modelData

                                width: parent.width
                                textFormat: Text.PlainText
                                text: Model.summaryLine(modelData, root.mode)
                                color: root.foreground
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.bodySmall
                                // Wraps rather than elides: the credit count at
                                // the end of the line is part of the summary,
                                // and a narrow card should show it on a second
                                // line instead of dropping it.
                                wrapMode: Text.WordWrap
                            }
                        }

                        Text {
                            width: parent.width
                            visible: root.totals.length === 0
                            textFormat: Text.PlainText
                            text: Model.emptyCreditsText()
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.bodySmall
                            wrapMode: Text.WordWrap
                        }
                    }

                    PanelSeparator {
                        visible: root.isOk
                        foreground: root.foreground
                    }

                    // ---- one row per credit ------------------------------------
                    Column {
                        visible: root.isOk
                        width: parent.width
                        spacing: Style.space(6)

                        PanelSectionHeader {
                            width: parent.width
                            text: "Credits"
                            foreground: root.foreground
                            fontFamily: root.fontFamily
                        }

                        // The `expiredCredits` setting: spent-out and expired
                        // credits are history, so hiding them is the default,
                        // and the note says how many are behind it rather than
                        // letting the list look complete.
                        Text {
                            width: parent.width
                            visible: text !== ""
                            textFormat: Text.PlainText
                            text: Model.hiddenCreditsNote(root.hiddenCredits)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.WordWrap
                        }

                        // The credit cap, said out loud: a 300-credit snapshot
                        // shows 200 and the rest is counted, not silently gone.
                        Text {
                            width: parent.width
                            visible: text !== ""
                            textFormat: Text.PlainText
                            text: Model.droppedCreditsNote(root.view)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.WordWrap
                        }

                        Column {
                            id: creditRows
                            width: parent.width
                            spacing: Style.space(8)

                            Repeater {
                                model: root.credits

                                delegate: CreditRow {
                                    required property var modelData

                                    credit: modelData
                                }
                            }
                        }

                        Text {
                            width: parent.width
                            visible: root.credits.length === 0 && root.hiddenCredits === 0
                            textFormat: Text.PlainText
                            text: Model.emptyCreditsText()
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            topPadding: Style.space(10)
                            bottomPadding: Style.space(10)
                        }
                    }

                    PanelSeparator {
                        foreground: root.foreground
                    }

                    // ---- footer: how to get fresh numbers, and where they came from
                    RowLayout {
                        width: parent.width
                        spacing: Style.space(8)

                        Text {
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignVCenter
                            textFormat: Text.PlainText
                            text: Model.footerHints()
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
                        }

                        PanelActionButton {
                            id: refreshButton
                            Layout.alignment: Qt.AlignVCenter
                            // Spins for as long as the widget has a helper
                            // process running, which is also why a fresh fetch
                            // takes a few seconds: a cloned Chromium has to
                            // answer first.
                            transformOrigin: Item.Center
                            iconText: "\uf021"
                            tooltipText: "Refresh now"
                            foreground: root.foreground
                            onClicked: root.refreshNow()

                            RotationAnimator on rotation {
                                running: root.hostWidget !== null && root.hostWidget.busy === true
                                from: 0
                                to: 360
                                duration: 900
                                loops: Animation.Infinite
                                onRunningChanged: if (!running) refreshButton.rotation = 0
                            }
                        }

                        Button {
                            Layout.alignment: Qt.AlignVCenter
                            text: "Console"
                            foreground: root.foreground
                            tooltipText: "Open the billing console credits page"
                            onClicked: root.openConsole()
                        }
                    }
                }
            }
        }
    }

    // One credit: its name and state, what is left of it as a number and as a
    // bar, and when it ends. The bar is drawn from `percentRemaining` when the
    // helper sends it and recomputed from the amounts when it does not, so a
    // slimmer snapshot still draws a truthful bar.
    component CreditRow: Item {
        id: row

        property var credit: null

        readonly property real percent: Model.percentRemaining(row.credit)
        readonly property string state: row.credit ? String(row.credit.state) : ""
        readonly property string currencyPrefix: row.credit && row.credit.currency ? String(row.credit.currency) + " " : ""
        // Only an available credit is money that can still be spent; the rest
        // recede into the panel's dim tone behind their chip.
        readonly property color stateColor: row.state === "available"
            ? root.accent
            : (row.state === "future" ? root.foreground : root.dim)

        width: parent ? parent.width : implicitWidth
        implicitHeight: rowContent.implicitHeight

        Column {
            id: rowContent
            width: parent.width
            spacing: Style.space(3)

            RowLayout {
                width: parent.width
                spacing: Style.space(8)

                Text {
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                    textFormat: Text.PlainText
                    text: Model.creditTitle(row.credit)
                    color: row.state === "available" ? root.foreground : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                }

                BorderSurface {
                    Layout.alignment: Qt.AlignVCenter
                    implicitWidth: chipLabel.implicitWidth + Style.space(10)
                    implicitHeight: chipLabel.implicitHeight + Style.space(4)
                    color: "transparent"
                    borderSpec: Border.controlSpec("normal", row.stateColor, row.stateColor)
                    radius: Style.cornerRadius

                    Text {
                        id: chipLabel
                        anchors.centerIn: parent
                        textFormat: Text.PlainText
                        text: Model.creditStateLabel(row.state)
                        color: row.stateColor
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                    }
                }
            }

            RowLayout {
                width: parent.width
                spacing: Style.space(8)

                Rectangle {
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                    Layout.preferredHeight: Style.space(4)
                    radius: height / 2
                    color: Qt.rgba(root.dim.r, root.dim.g, root.dim.b, 0.25)

                    Rectangle {
                        width: Math.round(parent.width * row.percent / 100)
                        height: parent.height
                        radius: parent.radius
                        color: row.stateColor
                    }
                }

                Text {
                    Layout.alignment: Qt.AlignVCenter
                    textFormat: Text.PlainText
                    text: Model.percentText(row.credit)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }
            }

            RowLayout {
                width: parent.width
                spacing: Style.space(8)

                Text {
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                    textFormat: Text.PlainText
                    text: row.currencyPrefix + Model.remainingText(row.credit, root.mode)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                }

                Text {
                    Layout.alignment: Qt.AlignVCenter
                    textFormat: Text.PlainText
                    visible: text !== ""
                    text: Model.endText(row.credit, Date.now())
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                }
            }
        }
    }
}
