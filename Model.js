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

// ---------------------------------------------------------------------------
// amounts

function groupThousands(digits) {
  var out = "";
  var seen = 0;
  for (var i = digits.length - 1; i >= 0; i--) {
    out = digits.charAt(i) + out;
    seen++;
    if (seen % 3 === 0 && i > 0) out = "," + out;
  }
  return out;
}

function fixed(value, places) {
  return Number(value).toFixed(places);
}

// Full number with thousands separators, matching what the console prints:
// `12,345.67` and `1,250.50` keep both decimals, while a whole amount drops
// them entirely (`12,345`).
function exactAmount(magnitude) {
  if (!isFinite(magnitude)) return "\u2014";
  // Past 1e21 a JavaScript number prints as "1e+21", so the digit grouping
  // below would have nothing to group. A credit balance that large is absurd,
  // but the bar must still print a number rather than an exponent. The test is
  // on the input: rounding it first would push 1e21 down below the threshold.
  if (magnitude >= 1e21) return groupThousands(BigInt(Math.round(magnitude)).toString());
  var rounded = Math.round(magnitude * 100) / 100;
  if (rounded % 1 === 0) return groupThousands(String(rounded));
  var integral = Math.floor(rounded);
  var fraction = fixed(rounded - integral, 2).slice(2);
  return groupThousands(String(integral)) + "." + fraction;
}

// Three significant figures inside the chosen unit: `12.3k` and `1.50L` keep
// the digits that distinguish balances while still fitting several currencies
// in one bar label. `L` and `Cr` are the unit Indian billing actually prints;
// everything else shortens to `k` and `M`.
function significant3(quotient) {
  var places = quotient >= 100 ? 0 : quotient >= 10 ? 1 : 2;
  var out = fixed(quotient, places);
  // Rounding can carry into an extra digit (9.999 -> "10.00"); step down one
  // place so the result still reads as three significant figures.
  if (places === 2 && Number(out) >= 10) out = fixed(quotient, 1);
  if (places >= 1 && Number(out) >= 100) out = fixed(quotient, 0);
  return out;
}

function compactAmount(magnitude, currency) {
  var code = text(currency).toUpperCase();
  // The unit ladder stops once a unit would need more than three digits before
  // it: past that the exact grouped number is both shorter and unambiguous.
  if (code === "INR") {
    if (magnitude >= 1e15) return exactAmount(magnitude);
    if (magnitude >= 1e12) return significant3(magnitude / 1e12) + "L Cr";
    if (magnitude >= 10000000) return significant3(magnitude / 10000000) + "Cr";
    if (magnitude >= 100000) return significant3(magnitude / 100000) + "L";
  } else {
    if (magnitude >= 1e15) return exactAmount(magnitude);
    if (magnitude >= 1e12) return significant3(magnitude / 1e12) + "T";
    if (magnitude >= 1e9) return significant3(magnitude / 1e9) + "B";
    if (magnitude >= 1000000) return significant3(magnitude / 1000000) + "M";
  }
  if (magnitude >= 1000) return significant3(magnitude / 1000) + "k";
  // Below the smallest unit both modes are the same number.
  return exactAmount(magnitude);
}

// amount only, no currency: the callers below put the code in front of it.
function formatAmount(value, currency, mode) {
  var amount = Number(value);
  if (!isFinite(amount)) return "\u2014";
  var magnitude = Math.abs(amount);
  var body =
    text(mode) === "exact"
      ? exactAmount(magnitude)
      : compactAmount(magnitude, currency);
  return (amount < 0 ? "-" : "") + body;
}

// "INR 12.3k" / "INR 12,345"
function amountWithCurrency(value, currency, mode) {
  var code = text(currency);
  var amount = formatAmount(value, code, mode);
  return code === "" ? amount : code + " " + amount;
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// what the bar shows

// Up to `limit` currencies that still have funds, in the helper's usable-first
// order. Currencies that are spent out are left out: the point of the label is
// what is still there to spend.
function usableLabels(view, limit, mode) {
  var out = [];
  var totals = isArray(view && view.totals) ? view.totals : [];
  var cap = Math.floor(numberOr(limit, 2));
  for (var i = 0; i < totals.length && out.length < cap; i++) {
    var usable = Number(totals[i] && totals[i].usable);
    if (!isFinite(usable) || usable <= 0) continue;
    out.push(amountWithCurrency(usable, totals[i].currency, mode));
  }
  return out;
}

function barLabel(view, mode) {
  if (!view || view.ok !== true) return "";
  var parts = usableLabels(view, 2, mode);
  if (parts.length > 0) return parts.join(" \u00b7 ");
  // Nothing usable anywhere: name the primary currency at zero rather than
  // dropping off the bar, because the panel is how it gets refreshed.
  var primary = text(view.primaryCurrency);
  if (primary === "" && isArray(view.totals) && view.totals.length > 0)
    primary = text(view.totals[0].currency);
  if (primary === "") return "GCP";
  return amountWithCurrency(numberOr(view.totalUsable, 0), primary, mode);
}

function warningMarker() {
  return WARNING_MARKER;
}

// ---------------------------------------------------------------------------
// what the tooltip shows

function ageText(fetchedAt, nowMs) {
  var when = Date.parse(text(fetchedAt));
  if (!isFinite(when)) return "unknown";
  var now = Number(nowMs);
  if (!isFinite(now)) now = Date.now();
  var seconds = Math.round((now - when) / 1000);
  // A snapshot stamped in the future is a clock difference, not a prediction.
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return "just now";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  var days = Math.floor(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

function tooltip(view, mode, nowMs) {
  var state = view || loadingView();
  var lines = [];
  if (state.ok === true) {
    var label = barLabel(state, mode);
    lines.push("GCP Credits: " + (label === "" ? "no usable funds" : label));
    if (state.billingAccount !== "")
      lines.push("Billing account " + state.billingAccount);
    lines.push("Snapshot taken " + ageText(state.fetchedAt, nowMs));
  } else if (state.loading === true) {
    lines.push("GCP Credits: no snapshot read yet");
    lines.push("Snapshot file " + CACHE_RELATIVE_PATH);
  } else {
    lines.push(
      "GCP Credits: " + (state.error === "" ? "fetch failed" : clampText(state.error, MAX_TOOLTIP_CHARS)),
    );
    if (state.code !== "") lines.push("code: " + state.code);
    if (state.hint !== "") lines.push("hint: " + clampText(state.hint, MAX_TOOLTIP_CHARS));
    if (state.fetchedAt !== "")
      lines.push("Snapshot taken " + ageText(state.fetchedAt, nowMs));
  }
  lines.push(
    "Click for the panel \u00b7 middle-click to refresh \u00b7 right-click to open the billing console",
  );
  return lines.join("\n");
}

// One line for the shell log, so a failed fetch is visible without the panel.
function statusLine(view, mode, nowMs) {
  var state = view || loadingView();
  if (state.loading === true) return "no snapshot read yet";
  if (state.ok !== true)
    return (
      "not ok" +
      (state.code === "" ? "" : " (" + state.code + ")") +
      (state.error === "" ? "" : ": " + state.error)
    );
  var label = barLabel(state, mode);
  return (
    (label === "" ? "no usable funds" : label) +
    ", " +
    state.credits.length +
    " " +
    plural(state.credits.length, "credit", "credits") +
    ", snapshot " +
    ageText(state.fetchedAt, nowMs)
  );
}

// ---------------------------------------------------------------------------
// what the panel shows

function heroMeta(view) {
  var state = view || loadingView();
  if (state.billingAccount !== "") return state.billingAccount;
  if (state.loading === true) return "reading the snapshot";
  return "unknown billing account";
}

function heroDetail(view) {
  var state = view || loadingView();
  if (state.loading === true) return "";
  return ageText(state.fetchedAt, Date.now());
}

// One line per currency: everything the totals line carries, in the same order
// the helper sorted them.
function summaryLine(total, mode) {
  if (!total) return "";
  var code = text(total.currency);
  var count = countOr(total.count);
  return (
    amountWithCurrency(total.usable, code, mode) +
    " usable \u00b7 " +
    formatAmount(total.remaining, code, mode) +
    " remaining \u00b7 " +
    formatAmount(total.original, code, mode) +
    " issued \u00b7 " +
    count +
    " " +
    plural(count, "credit", "credits")
  );
}

function creditTitle(credit) {
  var name = credit ? text(credit.displayName) : "";
  return name === "" ? "Unnamed credit" : name;
}

function creditStateLabel(state) {
  var raw = text(state);
  if (raw === "available") return "Available";
  if (raw === "future") return "Future";
  if (raw === "expired") return "Expired";
  if (raw === "used") return "Used";
  if (raw === "") return "Unknown";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// The two states that are over: expired by the clock, or spent out. They are
// what the `expiredCredits` setting hides.
function isSpentState(state) {
  var raw = text(state);
  return raw === "expired" || raw === "used";
}

function visibleCredits(credits, showSpent) {
  var list = isArray(credits) ? credits : [];
  if (showSpent) return list;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (!isSpentState(list[i] && list[i].state)) out.push(list[i]);
  }
  return out;
}

function hiddenCreditCount(credits, showSpent) {
  var list = isArray(credits) ? credits : [];
  return list.length - visibleCredits(list, showSpent).length;
}

function hiddenCreditsNote(count) {
  var n = countOr(count);
  if (n === 0) return "";
  return (
    n +
    (n === 1 ? " expired or used credit hidden" : " expired or used credits hidden") +
    " \u00b7 set Expired and used credits to Show"
  );
}

// The percent bar. The helper sends percentRemaining, but a snapshot that
// omits it still draws from the two amounts rather than an empty bar.
function percentRemaining(credit) {
  var pct = Number(credit && credit.percentRemaining);
  if (!isFinite(pct)) {
    var remaining = Number(credit && credit.remaining);
    var original = Number(credit && credit.original);
    if (isFinite(remaining) && isFinite(original) && original > 0)
      pct = (remaining / original) * 100;
  }
  if (!isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function percentText(credit) {
  return Math.round(percentRemaining(credit)) + "%";
}

// "1,250.50 of 5,000" - what is left of what was issued.
function remainingText(credit, mode) {
  if (!credit) return "";
  return (
    formatAmount(credit.remaining, credit.currency, mode) +
    " of " +
    formatAmount(credit.original, credit.currency, mode)
  );
}

function pad2(value) {
  var n = Math.floor(Number(value));
  return (n < 10 ? "0" : "") + n;
}

// Local calendar date from the helper's ISO timestamp; "" when it is not one,
// so a row can hide the line instead of printing Invalid Date.
function formatDate(iso) {
  var raw = text(iso);
  if (raw === "") return "";
  var when = new Date(raw);
  if (!isFinite(when.getTime())) return "";
  return when.getFullYear() + "-" + pad2(when.getMonth() + 1) + "-" + pad2(when.getDate());
}

function endText(credit, nowMs) {
  var date = formatDate(credit && credit.end);
  if (date === "") return "";
  var when = new Date(text(credit.end)).getTime();
  var now = Number(nowMs);
  if (!isFinite(now)) now = Date.now();
  var past = isFinite(when) && when < now;
  return (past ? "ended " : "ends ") + date;
}

// The failed snapshot's error and hint, with a readable stand-in when the
// helper sent neither (an empty cache, a killed fetch).
function errorText(view) {
  var state = view || loadingView();
  if (state.error !== "") return state.error;
  if (state.loading === true) return "No snapshot read yet.";
  return "The snapshot is not usable.";
}

function errorHint(view) {
  var state = view || loadingView();
  if (state.hint !== "") return state.hint;
  if (state.loading === true)
    return "Middle-click the bar icon, or press r here, to run the fetch.";
  return FALLBACK_HINT;
}

function errorCode(view) {
  var state = view || loadingView();
  return state.code === "" ? "" : "code: " + state.code;
}

function emptyCreditsText() {
  return "No credits on this billing account.";
}

function footerHints() {
  // Deliberately terse: this shares one caption row with the refresh and
  // console buttons inside the panel's contentWidth, and the panel must never
  // clip a hint mid-word. The Console button beside it names the destination;
  // `r` and `o` are the panel's own keys (r = refresh, o = console).
  return "r refresh \u00b7 o console";
}

// The view caps totals at MAX_TOTALS and credits at MAX_CREDITS. A snapshot
// that carries more is shown as its first N plus a count of the rest, so a
// truncated list is never mistaken for the whole account.
function droppedCreditsNote(view) {
  var dropped = countOr(view && view.droppedCredits);
  if (dropped === 0) return "";
  var shown = isArray(view && view.credits) ? view.credits.length : 0;
  return "Showing the first " + shown + " of " + (shown + dropped) + " credits";
}

function droppedTotalsNote(view) {
  var dropped = countOr(view && view.droppedTotals);
  if (dropped === 0) return "";
  var shown = isArray(view && view.totals) ? view.totals.length : 0;
  return "Showing the first " + shown + " of " + (shown + dropped) + " currencies";
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
    groupThousands: groupThousands,
    formatAmount: formatAmount,
    amountWithCurrency: amountWithCurrency,
    plural: plural,
    usableLabels: usableLabels,
    barLabel: barLabel,
    warningMarker: warningMarker,
    ageText: ageText,
    tooltip: tooltip,
    statusLine: statusLine,
    heroMeta: heroMeta,
    heroDetail: heroDetail,
    summaryLine: summaryLine,
    creditTitle: creditTitle,
    creditStateLabel: creditStateLabel,
    isSpentState: isSpentState,
    visibleCredits: visibleCredits,
    hiddenCreditCount: hiddenCreditCount,
    hiddenCreditsNote: hiddenCreditsNote,
    droppedCreditsNote: droppedCreditsNote,
    droppedTotalsNote: droppedTotalsNote,
    percentRemaining: percentRemaining,
    percentText: percentText,
    remainingText: remainingText,
    formatDate: formatDate,
    endText: endText,
    errorText: errorText,
    errorHint: errorHint,
    errorCode: errorCode,
    emptyCreditsText: emptyCreditsText,
    footerHints: footerHints,
  };
}
