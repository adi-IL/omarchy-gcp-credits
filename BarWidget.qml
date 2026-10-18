import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// GCP Credits - usable Google Cloud credit balances in the Omarchy bar.
//
// The billing console's credits table only answers a signed-in browser session,
// so the plugin's helper drives a cloned headless Chromium and writes a
// schema-1 snapshot to ~/.cache/gcp-credits/credits.json. This widget owns
// every bit of state around that: it reads the cache file at startup so the bar
// shows the last snapshot immediately, runs the helper on `intervalSeconds` and
// on demand, and hands one parsed view to both the bar mark and the panel.
//
// At most one fetch is ever in flight. A request that arrives while one runs -
// a click, an IPC refresh, a queued follow-up - is remembered and taken up when
// the process exits, because a Process that is already running can neither be
// re-armed nor restarted.
BarWidget {
    id: root
    moduleName: "adix.gcp-credits"

    readonly property string home: Quickshell.env("HOME") || ""

    // ---- settings (inline on this widget's shell.json entry) ----------------
    readonly property int intervalSeconds: Model.clampIntervalSeconds(root.setting("intervalSeconds", Model.DEFAULT_INTERVAL_SECONDS))
    // "exact" prints the full amount, "compact" the shortened one (USD 1.25k).
    readonly property string amountMode: String(root.setting("format", "compact")) === "exact" ? "exact" : "compact"
    // Expired and spent-out credits are hidden by default: they are history, not
    // money. "Show" lists them in the panel, dimmed behind their state chip.
    readonly property bool showSpentCredits: String(root.setting("expiredCredits", "Hide")) === "Show"
    // Optional pin: without it the helper resolves the open billing account
    // itself, and the snapshot reports what it settled on.
    readonly property string accountSetting: Model.billingAccountId(root.setting("billingAccount", ""))

    // ---- state --------------------------------------------------------------
    // The parsed snapshot, and the whole display state besides `busy`. Starts on
    // the loading view, so a first run with no cache file says so instead of
    // showing a zero balance.
    property var view: Model.loadingView()
    // A refresh asked for while a fetch was in flight. One flag, not a count:
    // two queued requests are served by one follow-up fetch.
    property bool fetchQueued: false
    // Set by the stall timer when it cuts a hung fetch loose, so the process's
    // own onExited knows not to overwrite the timeout message.
    property bool stalled: false
    // The last status line written to the shell log and when, so one fetch that
    // lands through several paths logs once.
    property string lastLoggedLine: ""
    property double lastLoggedAt: 0

    readonly property bool busy: proc.running
    readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
    // A snapshot that has not been read yet is not a failure: the bar keeps the
    // mark there (dimmed, so it reads as "not yet") and only a real failure
    // swaps in the warning glyph.
    readonly property bool loadingSnapshot: root.view.loading === true
    readonly property bool failedSnapshot: root.view.ok !== true && !root.loadingSnapshot

    // ---- display ------------------------------------------------------------
    readonly property string cachePath: Model.cachePath(root.home)
    readonly property string helperScript: Model.helperScriptPath(Qt.resolvedUrl("bin/gcp-credits.mjs").toString(), root.home)
    // The snapshot's own account is authoritative; the setting only covers the
    // window before the first snapshot arrives.
    readonly property string billingAccount: root.view.billingAccount !== "" ? root.view.billingAccount : root.accountSetting

    // ---- fetching -----------------------------------------------------------
    // Run the helper once. The command is assigned immediately before `running`
    // is set, so the argv can never race the run.
    function refresh() {
        if (proc.running) {
            root.fetchQueued = true;
            return;
        }
        root.fetchQueued = false;
        root.stalled = false;
        proc.command = Model.helperArgv(root.helperScript, root.accountSetting);
        proc.running = true;
    }

    // BarWidget.broadcast() target, so an IPC refresh reaches every bar instance
    // instead of only the one that owns the IPC target.
    function refreshNow() {
        root.refresh();
    }

    // The single place a parsed snapshot becomes the display state, so the bar
    // label, the tooltip and the panel can never disagree, and the shell log
    // records every fetch.
    //
    // One fetch lands here several times in the same instant: the process's
    // stdout, the queued re-arm, the cache file's change and its reload all
    // carry the same snapshot. A repeat of the same line inside one second is
    // that burst and is dropped; a later fetch that happens to render the same
    // amounts is a new event and is logged.
    function applyView(next) {
        root.view = next;
        var line = "GCP Credits: " + Model.statusLine(next, root.amountMode);
        var now = Date.now();
        if (line === root.lastLoggedLine && now - root.lastLoggedAt < 1000)
            return;
        root.lastLoggedLine = line;
        root.lastLoggedAt = now;
        if (next.ok !== true && next.loading !== true)
            console.warn(line);
        else
            console.log(line);
    }

    function openConsole() {
        var url = Model.consoleUrl(root.billingAccount);
        if (Model.isSafeUrl(url))
            Quickshell.execDetached(["omarchy-launch-browser", url]);
    }

    // ---- panel --------------------------------------------------------------
    // Opening the panel is also the plainest way to ask for fresh data, so it
    // fetches as well as showing what is already known.
    function open() {
        if (panelLoader.item)
            panelLoader.item.open();
        root.refresh();
    }

    function close() {
        if (panelLoader.item)
            panelLoader.item.close();
    }

    function togglePanel() {
        if (root.opened)
            root.close();
        else
            root.open();
    }

    function closeForPopoutSwitch() {
        if (panelLoader.item && typeof panelLoader.item.closeForPopoutSwitch === "function")
            panelLoader.item.closeForPopoutSwitch();
    }

    function injectPanel() {
        var target = panelLoader.item;
        if (!target)
            return;
        if ("bar" in target)
            target.bar = root.bar;
        if ("settings" in target)
            target.settings = root.settings;
        if ("anchorItem" in target)
            target.anchorItem = button;
        if ("hostWidget" in target)
            target.hostWidget = root;
    }

    onBarChanged: injectPanel()
    onSettingsChanged: injectPanel()

    // ---- interaction --------------------------------------------------------
    function handlePressed(buttonCode) {
        if (buttonCode === Qt.MiddleButton)
            root.refresh();
        else if (buttonCode === Qt.RightButton)
            root.openConsole();
        else
            root.togglePanel();
    }

    // The cache file is read, not fetched: this is what makes the bar show the
    // last snapshot the moment the shell starts. Watching it also means a fetch
    // run by hand (`gcp-credits fetch`) shows up here without waiting for the
    // next interval - `FileView.text()` is only fresh after a load, so the
    // change handler reloads and every parse stays in `onLoaded`. A missing
    // file parses as the loading state rather than as a failure.
    FileView {
        id: cacheFile
        path: root.cachePath
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.applyView(Model.parseSnapshot(text()))
        onLoadFailed: root.applyView(Model.parseSnapshot(""))
    }

    Process {
        id: proc
        // No `command:` binding: refresh() assigns the argv immediately before
        // it sets `running`, so the command cannot race the run.
        stdout: StdioCollector {
            id: fetchStdout
            waitForEnd: true
        }
        stderr: StdioCollector {
            id: fetchStderr
            waitForEnd: true
        }
        onRunningChanged: if (running)
            stallTimer.restart()
        onExited: function (exitCode) {
            stallTimer.stop();
            // The stall timer already reported the timeout and is about to
            // receive this exit from the process it killed; keep that message.
            if (root.stalled) {
                root.stalled = false;
                return;
            }
            // The helper prints the snapshot it just wrote, so stdout is the
            // authority; the cache file is the fallback for a run that died
            // before printing anything.
            var next = Model.parseFetchOutput(exitCode, fetchStdout.text, fetchStderr.text, cacheFile.text());
            // Losing the race to another fetch says nothing about the credits:
            // the helper wrote nothing and the file still holds the last good
            // snapshot, so keep showing that instead of flipping the bar to a
            // warning glyph for a whole interval.
            if (next.code === "busy")
                console.log("GCP Credits: another fetch holds the lock, keeping the last snapshot");
            else
                root.applyView(next);
            // Re-read the file: this is also what re-attaches the watcher when
            // the file did not exist yet at startup.
            cacheFile.reload();
            if (root.fetchQueued) {
                root.fetchQueued = false;
                Qt.callLater(root.refresh);
            }
        }
    }

    // A tick here spawns a headless Chromium for about four seconds, and the bar
    // is already showing the last snapshot from the cache file. So the timer
    // does not fire at startup: the first fetch is the one the user asks for -
    // opening the panel, middle-clicking, or the first interval elapsing.
    Timer {
        interval: root.intervalSeconds * 1000
        running: true
        repeat: true
        onTriggered: root.refresh()
    }

    // The helper has its own timeouts, but a Chromium that never returns would
    // hold the widget on its last reading until the shell restarts, since a
    // Process already running cannot be restarted. Cut it loose and say so.
    Timer {
        id: stallTimer
        interval: 90000
        onTriggered: {
            if (!proc.running)
                return;
            root.stalled = true;
            proc.running = false;
            console.warn("GCP Credits: the helper gave no answer within 90 seconds");
            root.applyView(Model.timeoutView(90));
        }
    }

    // ---- panel wiring -------------------------------------------------------
    Loader {
        id: panelLoader
        active: true
        source: Qt.resolvedUrl("Panel.qml")
        visible: false
        onLoaded: {
            root.injectPanel();
            Qt.callLater(root.injectPanel);
        }
    }

    // The widget owns the plugin's IPC target: it is the item that lives for the
    // whole session, so the panel registers none of its own (see Panel.qml).
    IpcHandler {
        target: root.moduleName

        function open(): void {
            root.open();
        }
        function close(): void {
            root.close();
        }
        function show(): void {
            root.open();
        }
        function hide(): void {
            root.close();
        }
        function toggle(): void {
            root.togglePanel();
        }
        function refresh(): string {
            root.broadcast("refreshNow");
            return "ok";
        }
    }

    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        hasVisualContent: true
        // A failed snapshot swaps the cloud for the warning glyph in the accent
        // colour, so a stale reading never wears the Google Cloud mark. While no
        // snapshot has been read at all the mark stays, dimmed: that is a
        // "waiting", not an error. Either way the bar carries one icon slot, and
        // the hover tooltip carries the amounts: one usable amount per currency,
        // the account, the age, and the failure's code, error and hint.
        text: root.failedSnapshot ? Model.warningMarker() : ""
        iconComponent: root.failedSnapshot ? null : markComponent
        active: root.failedSnapshot
        tooltipText: Model.tooltip(root.view, root.amountMode)
        onPressed: function (buttonCode) {
            root.handlePressed(buttonCode);
        }

        Component {
            id: markComponent

            // The mark is a filled shape where the bar's other icons are line
            // art, so it is drawn inside the optical canvas rather than across
            // it, the same way the notifications widget sizes its mark.
            GoogleCloudMark {
                opacity: root.loadingSnapshot ? 0.45 : 1.0
                color: button.active && button.useActiveColor ? button.activeColor : button.foreground
            }
        }
    }
}
