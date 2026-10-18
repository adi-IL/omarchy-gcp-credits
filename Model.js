// GCP Credits - pure display logic for the Omarchy bar widget.
//
// Plain ECMAScript, shared by two runtimes:
//   - BarWidget.qml / Panel.qml import it as a QML JS module;
//   - a scratch node script can require it, because of the module.exports guard
//     at the bottom. Nothing here touches QML, files, timers or processes.
//
// The helper (bin/gcp-credits.mjs) does the browsing; it writes a schema-1
// snapshot to ~/.cache/gcp-credits/credits.json and prints the same JSON. This
// file turns that text into the one shape the widget and the panel both read,
// and into every string they display. A malformed, empty or hostile snapshot
// has to end up as one readable sentence and never as a thrown exception: the
// bar renders whatever comes out of parseSnapshot().

var SCHEMA = 1;

// Default refresh interval, as the manifest's schema declares it.
var DEFAULT_INTERVAL_SECONDS = 900;
var MIN_INTERVAL_SECONDS = 300;
var MAX_INTERVAL_SECONDS = 86400;

// Retained-field caps, so one pathological snapshot cannot bloat the view or
// the tooltip. A billing account has four credits today; the row cap is only
// there to bound the Repeater.
var MAX_TOTALS = 12;
var MAX_CREDITS = 200;
var MAX_ID_CHARS = 200;
var MAX_NAME_CHARS = 200;
var MAX_MESSAGE_CHARS = 400;
var MAX_HINT_CHARS = 300;
var MAX_CODE_CHARS = 40;
var MAX_ACCOUNT_CHARS = 64;
var MAX_CURRENCY_CHARS = 8;
// The bar's tooltip renders each line as one unwrapped Text, so a long failure
// message widens the bubble past the screen and clips it at both edges. The
// panel is where the helper's message is readable in full.
var MAX_TOOLTIP_CHARS = 80;

// Shown dimmed on the bar while the snapshot is not `ok`.
var WARNING_MARKER = "\u26A0";

var CACHE_RELATIVE_PATH = ".cache/gcp-credits/credits.json";
var DEFAULT_SCRIPT_RELATIVE_PATH =
  ".config/omarchy/plugins/adix.gcp-credits/bin/gcp-credits.mjs";

var CONSOLE_BASE_URL = "https://console.cloud.google.com/billing";

// Only used for states this file invents (a stalled fetch, an unreadable
// cache); the helper's own snapshots always carry a hint of their own.
var FALLBACK_HINT =
  "Middle-click the bar icon to try again; run `gcp-credits doctor` for the full state.";

// ---------------------------------------------------------------------------
// coercion

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function trimmed(value) {
  return text(value).replace(/^\s+|\s+$/g, "");
}

function isBlank(value) {
  return trimmed(value) === "";
}

// Collapse newlines and cap the length: every one of these strings can end up
// in a tooltip, and the helper's stderr is not written for a single line.
function clampText(value, limit) {
  // A snapshot is untrusted text. Control characters are invisible at best and
  // terminal escapes at worst: one of them reaching the shell log turns the
  // whole line into a journal blob, and one reaching a label draws a box.
  var raw = text(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  raw = trimmed(raw).replace(/\s+/g, " ");
  if (raw.length > limit) raw = raw.slice(0, limit) + "\u2026";
  return raw;
}

// Numbers arrive from JSON, so a missing key (`undefined`), an explicit null,
// an empty string and "not a number" all mean the same thing: use the fallback.
function numberOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function countOr(value) {
  var n = Math.floor(numberOr(value, 0));
  return n < 0 ? 0 : n;
}

// How many array entries the caps left out: the raw length minus what survived
// normalization. A non-array source drops nothing (it carries nothing).
function droppedCount(raw, kept) {
  if (!isArray(raw)) return 0;
  var dropped = raw.length - kept;
  return dropped > 0 ? dropped : 0;
}

function clampIntervalSeconds(value) {
  var seconds = Number(value);
  if (!isFinite(seconds) || seconds <= 0) seconds = DEFAULT_INTERVAL_SECONDS;
  seconds = Math.round(seconds);
  if (seconds < MIN_INTERVAL_SECONDS) seconds = MIN_INTERVAL_SECONDS;
  if (seconds > MAX_INTERVAL_SECONDS) seconds = MAX_INTERVAL_SECONDS;
  return seconds;
}

// A billing account id is a bare token (01ABCD-23EF45-6789AB). It is pasted
// into two places that must not be able to grow an option or a path
// separator - the helper's argv and the console URL - so anything that is not
// one is dropped here rather than quoted at each use.
function billingAccountId(value) {
  var raw = clampText(value, MAX_ACCOUNT_CHARS);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) ? raw : "";
}

function currencyCode(value) {
  var raw = trimmed(value).toUpperCase();
  return /^[A-Z]{2,8}$/.test(raw) ? raw : "";
}

// ---------------------------------------------------------------------------
// paths and the helper command

// Qt.resolvedUrl() hands QML a file:// URL; Process wants a path. The host
// builds that URL with Util.fileUrl(), which percent-encodes each segment, so
// every escape is decoded here rather than only spaces. A plugin installed
// anywhere still resolves through its own directory, so the resolved URL wins
// and the $HOME-relative default is only the fallback.
function helperScriptPath(value, home) {
  var raw = text(value);
  if (raw.indexOf("file://") === 0) {
    var path = raw.slice(7);
    // file:///home/x -> /home/x. A host part here is never meaningful, so it
    // is dropped rather than turned into a path segment.
    if (path.charAt(0) !== "/") path = "/" + path;
    return path.replace(/%([0-9A-Fa-f]{2})/g, function (match, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
  if (raw.charAt(0) === "/") return raw;
  var homeDir = text(home);
  if (homeDir === "") return "";
  return homeDir + "/" + DEFAULT_SCRIPT_RELATIVE_PATH;
}

function cachePath(home) {
  var homeDir = text(home);
  return homeDir === "" ? "" : homeDir + "/" + CACHE_RELATIVE_PATH;
}

// `node <script> fetch [--account <id>]`, exactly the helper's documented CLI.
// No shell is involved, so the path needs no quoting and the account id has
// already been reduced to a safe token.
function helperArgv(scriptPath, account) {
  var script = text(scriptPath);
  var argv = ["node", script, "fetch"];
  var id = billingAccountId(account);
  if (id !== "") {
    argv.push("--account");
    argv.push(id);
  }
  return argv;
}

function isSafeUrl(url) {
  return /^https?:\/\/[^\s]+$/i.test(text(url));
}

function consoleUrl(billingAccount) {
  var id = billingAccountId(billingAccount);
  return id === "" ? CONSOLE_BASE_URL : CONSOLE_BASE_URL + "/" + id + "/credits/all";
}

// ---------------------------------------------------------------------------
// the snapshot

// Nothing read yet: no cache file, and no fetch has finished. Distinct from a
// failed snapshot so the panel can say which of the two it is looking at.
function loadingView() {
  var view = emptyView();
  view.loading = true;
  return view;
}

function emptyView() {
  return {
    schema: SCHEMA,
    loading: false,
    ok: false,
    code: "",
    error: "",
    hint: "",
    fetchedAt: "",
    billingAccount: "",
    primaryCurrency: "",
    totalUsable: 0,
    totals: [],
    credits: [],
    // Entries the caps left out. The panel says so rather than presenting a
    // truncated list as the whole account.
    droppedTotals: 0,
    droppedCredits: 0,
  };
}

function failureView(code, error, hint) {
  var view = emptyView();
  view.code = clampText(code, MAX_CODE_CHARS);
  view.error = clampText(error, MAX_MESSAGE_CHARS);
  view.hint = clampText(hint, MAX_HINT_CHARS);
  return view;
}

// A hung fetch cut loose by the widget's own stall timer. The helper never
// emits this, so there is no code to report - only what happened.
function timeoutView(seconds) {
  var limit = Math.round(numberOr(seconds, 0));
  return failureView(
    "",
    "gcp-credits gave no answer within " + limit + " seconds.",
    "Try again, or run `gcp-credits doctor` to see what the browser profile is doing.",
  );
}

function parseSnapshot(raw) {
  var source = text(raw);
  if (isBlank(source)) return loadingView();

  var parsed = null;
  var syntaxError = false;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    syntaxError = true;
    parsed = null;
  }
  // A syntax error and a valid non-object are different bugs: the first means
  // the file is torn or was written by something else, the second means it
  // parsed but is the wrong shape (a bare `null`, an array, a number).
  if (syntaxError) {
    return failureView(
      "unexpected",
      "The GCP credits snapshot is not valid JSON.",
      "Run `gcp-credits fetch` to rewrite ~/.cache/gcp-credits/credits.json.",
    );
  }
  if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
    return failureView(
      "unexpected",
      "The GCP credits snapshot is not a JSON object.",
      "Run `gcp-credits fetch` in a terminal to see what the helper prints.",
    );
  }

  // Every snapshot the helper writes carries the schema and a boolean `ok`.
  // Without them the file is a torn write or something else entirely, and
  // reading it as a balance of zero would be a lie the bar cannot show.
  if (typeof parsed.ok !== "boolean") {
    return failureView(
      "unexpected",
      "The GCP credits snapshot has no status field.",
      "Run `gcp-credits fetch` to rewrite ~/.cache/gcp-credits/credits.json.",
    );
  }
  if (parsed.schema !== undefined && Math.floor(numberOr(parsed.schema, SCHEMA)) !== SCHEMA) {
    return failureView(
      "unexpected",
      "This snapshot uses schema " + Math.floor(numberOr(parsed.schema, SCHEMA)) + ", and this widget reads schema " + SCHEMA + ".",
      "Update the adix.gcp-credits plugin, or run `gcp-credits fetch`.",
    );
  }

  var view = emptyView();
  view.schema = SCHEMA;
  view.ok = parsed.ok === true;
  view.code = clampText(parsed.code, MAX_CODE_CHARS);
  view.error = clampText(parsed.error, MAX_MESSAGE_CHARS);
  view.hint = clampText(parsed.hint, MAX_HINT_CHARS);
  view.fetchedAt = clampText(parsed.fetchedAt, 40);
  view.billingAccount = billingAccountId(parsed.billingAccount);
  view.primaryCurrency = currencyCode(parsed.primaryCurrency);
  view.totalUsable = numberOr(parsed.totalUsable, 0);
  view.totals = normalizeTotals(parsed.totals);
  view.credits = normalizeCredits(parsed.credits);
  view.droppedTotals = droppedCount(parsed.totals, view.totals.length);
  view.droppedCredits = droppedCount(parsed.credits, view.credits.length);

  // A snapshot that claims `ok` but carries nothing is still rendered as
  // success: the totals and credits arrays decide what the rows show.
  return view;
}

// What one finished fetch means. The helper prints the snapshot it just wrote,
// so stdout is what usually decides; the cache file is the fallback for a run
// that died before printing (and which therefore left the previous snapshot in
// place).
function parseFetchOutput(exitCode, stdout, stderr, cacheText) {
  var out = text(stdout);
  if (!isBlank(out)) return parseSnapshot(out);
  var cached = text(cacheText);
  if (!isBlank(cached)) return parseSnapshot(cached);
  return failureView("unexpected", fetchFailureText(exitCode, stderr), FALLBACK_HINT);
}

function firstLine(value) {
  var raw = text(value).replace(/\r/g, "");
  var at = raw.indexOf("\n");
  if (at !== -1) raw = raw.slice(0, at);
  return trimmed(raw);
}

function fetchFailureText(exitCode, output) {
  var detail = firstLine(output);
  var code = Number(exitCode);
  var head = "gcp-credits fetch failed";
  if (isFinite(code)) head += " (exit " + code + ")";
  return detail === "" ? head + "." : head + ": " + detail;
}

function normalizeTotals(value) {
  var out = [];
  if (!isArray(value)) return out;
  var limit = Math.min(value.length, MAX_TOTALS);
  for (var i = 0; i < limit; i++) {
    var item = value[i];
    if (!item || typeof item !== "object" || isArray(item)) continue;
    out.push({
      currency: currencyCode(item.currency),
      usable: numberOr(item.usable, 0),
      remaining: numberOr(item.remaining, 0),
      original: numberOr(item.original, 0),
      count: countOr(item.count),
    });
  }
  return out;
}

function normalizeCredits(value) {
  var out = [];
  if (!isArray(value)) return out;
  var limit = Math.min(value.length, MAX_CREDITS);
  for (var i = 0; i < limit; i++) {
    var item = value[i];
    if (!item || typeof item !== "object" || isArray(item)) continue;
    out.push({
      id: clampText(item.id, MAX_ID_CHARS),
      displayName: clampText(item.displayName, MAX_NAME_CHARS),
      remaining: numberOr(item.remaining, 0),
      original: numberOr(item.original, 0),
      currency: currencyCode(item.currency),
      // Deliberately absent when the snapshot omits it: `0` is also a real
      // reading (a spent-out credit), so it cannot double as "unknown".
      percentRemaining: numberOr(item.percentRemaining, NaN),
      start: clampText(item.start, 40),
      end: clampText(item.end, 40),
      // Not restricted to the four states the helper emits: an unrecognised
      // one is shown as it arrived rather than silently relabelled.
      state: clampText(item.state, 20).toLowerCase(),
    });
  }
  return out;
}


if (typeof module !== "undefined") {
  module.exports = {
    SCHEMA: SCHEMA,
    DEFAULT_INTERVAL_SECONDS: DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS: MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS: MAX_INTERVAL_SECONDS,
    MAX_TOTALS: MAX_TOTALS,
    MAX_CREDITS: MAX_CREDITS,
    WARNING_MARKER: WARNING_MARKER,
    CACHE_RELATIVE_PATH: CACHE_RELATIVE_PATH,
    DEFAULT_SCRIPT_RELATIVE_PATH: DEFAULT_SCRIPT_RELATIVE_PATH,
    CONSOLE_BASE_URL: CONSOLE_BASE_URL,
    isArray: isArray,
    text: text,
    isBlank: isBlank,
    clampText: clampText,
    numberOr: numberOr,
    countOr: countOr,
    clampIntervalSeconds: clampIntervalSeconds,
    billingAccountId: billingAccountId,
    currencyCode: currencyCode,
    helperScriptPath: helperScriptPath,
    cachePath: cachePath,
    helperArgv: helperArgv,
    isSafeUrl: isSafeUrl,
    consoleUrl: consoleUrl,
    emptyView: emptyView,
    loadingView: loadingView,
    failureView: failureView,
    timeoutView: timeoutView,
    parseSnapshot: parseSnapshot,
    parseFetchOutput: parseFetchOutput,
    fetchFailureText: fetchFailureText,
    normalizeTotals: normalizeTotals,
    normalizeCredits: normalizeCredits,
  };
}
