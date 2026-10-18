#!/usr/bin/env node
// gcp-credits: read Google Cloud credit balances without the billing console UI.
//
// The console's credits table comes from a private API (cloudclient-pa) that
// only accepts a signed-in browser session, so this helper drives an isolated
// headless Chromium whose profile is a copy of the user's own Chromium profile.
// Same cookies, same device-bound session, no OAuth scope or API enablement.
// Its debug channel is a pipe this process owns (fd 3 and fd 4), never a port.
//
//   gcp-credits setup [--profile <chromium-profile-dir>]   clone the browser profile once
//   gcp-credits fetch [--account <billing-account>] [--json]
//   gcp-credits login                                      open the clone to sign in again
//   gcp-credits doctor                                     print state for debugging
//
// fetch writes ~/.cache/gcp-credits/credits.json and prints the same snapshot.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA = 1;
const ORIGIN = "https://console.cloud.google.com";
const CREDITS_URL =
  "https://cloudconsole-pa.clients6.google.com/v3/entityServices/BillingpricefactorsEntityService" +
  "/schemas/BILLINGPRICEFACTORS_GRAPHQL:batchGraphql?key=AIzaSyCI-zsRP85UVOi0DjtiCwWBwQ1djDy741g";
// The console ships its credits query as a persisted operation: the backend
// wants the operation signature, not the document text. Captured from the
// billing credits page on 2026-10-18 (chrome devtools, ListCreditsDetail call).
const QUERY_SIGNATURE = "2/PydlIw7s18h/dddSmzGlmxPZVxi71ZcnKjkR278Ovtw=";
const LIST_CREDITS_BODY = {
  querySignature: QUERY_SIGNATURE,
  operationName: "ListCreditsDetail",
  variables: {},
};

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".cache", "gcp-credits");
const PROFILE_DIR = path.join(STATE_DIR, "profile");
const CACHE_FILE = path.join(STATE_DIR, "credits.json");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const LOCK_DIR = path.join(STATE_DIR, "fetch.lock");
const BROWSER_LOG = path.join(STATE_DIR, "chromium.log");
const CHROMIUM = process.env.GCP_CREDITS_CHROMIUM || "/usr/lib/chromium/chromium";
const SOURCE_PROFILE = process.env.GCP_CREDITS_SOURCE_PROFILE || path.join(HOME, ".config", "chromium");

const CHROMIUM_ARGS = [
  `--user-data-dir=${PROFILE_DIR}`,
  "--password-store=gnome-libsecret",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,MediaRouter",
];

// Chromium reads DevTools commands from fd 3 and writes its answers to fd 4, so
// this flag only works together with the pipe pair `launchBrowser` hands the
// child. A pipe cannot be reached by another process - a loopback debug port
// can be reached by every local user, and this browser holds a live Google
// session. The sign-in window is launched without it: it needs no debug channel.
const CHROMIUM_PIPE_ARGS = [...CHROMIUM_ARGS, "--remote-debugging-pipe"];

// A fetch takes seconds, so a lock older than this cannot belong to a run that
// is still going: its pid was recycled.
const LOCK_STALE_MS = 10 * 60 * 1000;
// The lock directory and its pid file are written milliseconds apart; a caller
// that lands in between must see `busy`, not a lock it is free to steal.
const LOCK_SETTLE_MS = 5000;
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_TIMEOUT_MS = 45000;

class Failure extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// The state directory holds a copy of a signed-in browser profile, so every
// path created here is owner-only instead of inheriting the login umask.
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on filesystems without modes */
  }
}

function writePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

// The widget watches the cache file and reloads it on every change, so a
// snapshot is written whole to a temporary file and renamed over the old one:
// a reader sees the old snapshot or the new one, never a half-written file.
function writeAtomic(file, data) {
  const temp = `${file}.tmp`;
  writePrivate(temp, data);
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const readConfig = () => readJson(CONFIG_FILE, {});

// ---------------------------------------------------------------------------
// snapshot shape

function money(value) {
  if (!value) return 0;
  return Number(value.units || 0) + Number(value.nanos || 0) / 1e9;
}

// The console's status column, derived the same way it does: spending first,
// then the window. `available` is the only state that still has funds to spend.
function creditState(credit, now = Date.now()) {
  if (money(credit.remainingAmount) <= 0) return "used";
  const start = credit.startTime ? Date.parse(credit.startTime) : null;
  const end = credit.endTime ? Date.parse(credit.endTime) : null;
  if (start && start > now) return "future";
  if (end && end < now) return "expired";
  return "available";
}

function toCredit(raw) {
  const original = money(raw.value);
  const remaining = money(raw.remainingAmount);
  return {
    id: String(raw.name || "").split("/").pop(),
    displayName: raw.displayName || raw.name || "Credit",
    remaining,
    original,
    currency: raw.value?.currencyCode || raw.remainingAmount?.currencyCode || null,
    percentRemaining: original > 0 ? Math.round((remaining / original) * 100) : 0,
    start: raw.startTime || null,
    end: raw.endTime || null,
    state: creditState(raw),
  };
}

// Credits come back in the billing account's own currency plus whatever an
// individual program was issued in, so a single grand total would be a lie.
// Every total is keyed by currency; `usable` counts only credits still
// spendable today.
function totalsByCurrency(credits) {
  const totals = new Map();
  for (const credit of credits) {
    const entry = totals.get(credit.currency) || { currency: credit.currency, usable: 0, remaining: 0, original: 0, count: 0 };
    entry.remaining += credit.remaining;
    entry.original += credit.original;
    entry.count += 1;
    if (credit.state === "available") entry.usable += credit.remaining;
    totals.set(credit.currency, entry);
  }
  return [...totals.values()].sort((a, b) => b.usable - a.usable);
}

function snapshot(credits, billingAccount, fetchedAt, authUser) {
  const totals = totalsByCurrency(credits);
  return {
    schema: SCHEMA,
    ok: true,
    fetchedAt,
    billingAccount,
    // Which Google account in the cloned profile answered the query: a profile
    // can hold several, and only the owner of the billing account sees credits.
    authUser,
    primaryCurrency: totals[0]?.currency || null,
    totalUsable: totals[0]?.usable || 0,
    totals,
    credits,
  };
}

function errorSnapshot(code, message, hint, billingAccount) {
  return {
    schema: SCHEMA,
    ok: false,
    code,
    error: message,
    hint: hint || null,
    fetchedAt: new Date().toISOString(),
    billingAccount: billingAccount || null,
    primaryCurrency: null,
    totalUsable: 0,
    totals: [],
    credits: [],
  };
}

// ---------------------------------------------------------------------------
// chromium profile

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function clearSingletons() {
  for (const entry of fs.readdirSync(PROFILE_DIR)) {
    if (entry.startsWith("Singleton")) fs.rmSync(path.join(PROFILE_DIR, entry), { force: true });
  }
  fs.rmSync(path.join(PROFILE_DIR, "DevToolsActivePort"), { force: true });
}

// Chromium's own single-instance guard: SingletonLock is a symlink to
// "<host>-<pid>". A live pid means a browser already has this profile open -
// the sign-in window - and clearing that lock would let a second browser write
// the same cookie jar under the first one.
function profileBrowserPid() {
  let target = "";
  try {
    target = fs.readlinkSync(path.join(PROFILE_DIR, "SingletonLock"));
  } catch {
    return null;
  }
  const pid = Number(String(target).split("-").pop());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return pid;
}

function assertChromium() {
  try {
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
  } catch {
    throw new Failure("no_chromium", `No executable Chromium at ${CHROMIUM}`, "Install chromium, or point GCP_CREDITS_CHROMIUM at one");
  }
}

// A browser on the clone can only be one this plugin started: nothing else
// reads that profile. A headless one that outlived its helper - a killed run, a
// helper the shell dropped - still holds the profile and the signed-in session,
// so it is reaped rather than allowed to block every later fetch. A window the
// user is looking at is left alone and reported instead.
function reapCloneBrowser() {
  let pid = null;
  try {
    pid = Number(String(fs.readlinkSync(path.join(PROFILE_DIR, "SingletonLock"))).split("-").pop());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  let cmdline = "";
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    cmdline = "";
  }
  if (!cmdline.includes("--headless")) return pid;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  clearSingletons();
  sleepSync(400);
  return null;
}

function ensureProfileFree() {
  const pid = reapCloneBrowser();
  if (!pid) return;
  throw new Failure(
    "browser_running",
    `A Chromium window (pid ${pid}) already has the cloned profile open`,
    "Close the sign-in window from `gcp-credits login`, then let the next refresh run",
  );
}

// The reaping above is a `spawnSync`-style wait: this runs before the async
// part of a fetch, where a promise would be out of place.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cmdSetup(args) {
  const source = args.profile || SOURCE_PROFILE;
  if (!fs.existsSync(path.join(source, "Default", "Cookies"))) {
    throw new Failure("no_source_profile", `No Chromium profile with cookies at ${source}`, "Pass --profile <dir>.");
  }
  assertChromium();
  ensureProfileFree();
  ensurePrivateDir(STATE_DIR);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  const copy = run("rsync", [
    "-a",
    // -a preserves the source modes, which would ship a world-readable copy of
    // the cookie jar if the source profile was ever loosened.
    "--chmod=D700,F600",
    "--exclude",
    "GPUCache",
    "--exclude",
    "DawnGraphiteCache",
    "--exclude",
    "DawnWebGPUCache",
    "--exclude",
    "Crash Reports",
    "--exclude",
    "component_crx_cache",
    "--exclude",
    "extensions_crx_cache",
    `${source}/`,
    `${PROFILE_DIR}/`,
  ]);
  if (copy.status !== 0) throw new Failure("copy_failed", `rsync failed: ${copy.stderr.trim()}`);
  clearSingletons();
  // Only the clone's provenance is replaced: a re-clone must not drop the
  // billing account a previous fetch resolved, or the next one has to find
  // `gcloud` again.
  writePrivate(
    CONFIG_FILE,
    JSON.stringify({ ...readConfig(), sourceProfile: source, copiedAt: new Date().toISOString() }, null, 2),
  );
  return { ok: true, copiedFrom: source, profileDir: PROFILE_DIR };
}

function profileState() {
  if (!fs.existsSync(PROFILE_DIR)) return { present: false };
  return { present: true, ...readConfig(), profileDir: PROFILE_DIR, runningPid: profileBrowserPid() };
}

// ---------------------------------------------------------------------------
// CDP over the debug pipe

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chromium writes protocol messages to fd 4 and reads them from fd 3, each one
// a JSON object terminated by a NUL byte. Nothing but this process and its
// child can reach the channel, and it dies with them.
function pipeClient(child, defaultTimeoutMs = 30000) {
  const pending = new Map();
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  const answers = child.stdio[4];

  answers.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        continue; // a log line Chromium wrote to the pipe; nothing to answer
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Failure("query_rejected", message.error.message));
      else entry.resolve(message.result);
    }
  });
  // A browser that dies mid-command makes the write side fail asynchronously;
  // the answer never arrives, so the request times out or the close handler
  // rejects it. Handling the stream error keeps Node from crashing on it.
  child.stdio[3].on("error", () => {});
  answers.on("error", () => {});
  answers.on("close", () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Failure("browser_failed", "Chromium closed the debug pipe", `See ${BROWSER_LOG}`));
    }
  });

  const send = (method, params = {}, sessionId, timeoutMs = defaultTimeoutMs) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Failure(
            "browser_failed",
            `Chromium did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds`,
            `See ${BROWSER_LOG}`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });

  return {
    send,
    close() {
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
      }
      child.stdio[3].destroy();
      answers.destroy();
    },
  };
}

async function launchBrowser() {
  assertChromium();
  ensureProfileFree();
  clearSingletons();
  const logFd = openBrowserLog();
  const child = spawn(CHROMIUM, [...CHROMIUM_PIPE_ARGS, "--headless=new", `${ORIGIN}/`], {
    // fd 3 and 4 are the debug pipe. The child gets its own process group so
    // `stopBrowser` can bring the whole browser - zygote, renderers, utility
    // processes - down with one signal.
    stdio: ["ignore", logFd, logFd, "pipe", "pipe"],
    detached: true,
  });
  child.unref();
  // A browser that cannot be spawned emits `error` here; the pipe client has
  // nothing to answer with, so the request fails on its own timeout.
  child.on("error", () => {});
  const cdp = pipeClient(child);
  try {
    // Commands written before Chromium is up wait in the pipe, so the first
    // answer doubles as the startup check. A binary that cannot be executed -
    // swallowed by the handler above - rejects this instead of waiting out the
    // whole timeout.
    await Promise.race([
      cdp.send("Browser.getVersion", {}, undefined, REQUEST_TIMEOUT_MS),
      new Promise((_, reject) =>
        child.once("error", (error) =>
          reject(new Failure("browser_failed", `Chromium did not start: ${error.message}`, `See ${BROWSER_LOG}`)),
        ),
      ),
    ]);
    return { child, cdp };
  } catch (error) {
    cdp.close();
    await stopBrowser(child);
    throw error instanceof Failure
      ? error
      : new Failure("browser_failed", `Chromium did not start: ${error.message}`, `See ${BROWSER_LOG}`);
  }
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !fs.existsSync(`/proc/${child.pid}`)) return;
    await sleep(120);
  }
  signal("SIGKILL");
}

function openBrowserLog() {
  ensurePrivateDir(STATE_DIR);
  try {
    fs.chmodSync(BROWSER_LOG, 0o600);
  } catch {
    /* not created yet */
  }
  return fs.openSync(BROWSER_LOG, "w", 0o600);
}

// The browser of the fetch that is running, so a signal can take it down: a
// headless Chromium left behind would hold the cloned profile - and the signed
// in session - until the user noticed it.
let activeBrowser = null;

async function shutdown(code) {
  const browser = activeBrowser;
  activeBrowser = null;
  if (browser) await stopBrowser(browser.child);
  releaseLock();
  process.exit(code);
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    void shutdown(code);
  });
}

// Last resort for an exit that is not a signal: never orphan the browser.
process.on("exit", () => {
  if (!activeBrowser) return;
  try {
    process.kill(-activeBrowser.child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});

// ---------------------------------------------------------------------------
// console access

async function consolePage(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const existing = targetInfos.find((t) => t.type === "page" && t.url.startsWith(ORIGIN));
  const targetId = existing
    ? existing.targetId
    : (await cdp.send("Target.createTarget", { url: `${ORIGIN}/`, background: true })).targetId;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const probe = await cdp
      .send(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify({origin: location.origin, cookie: document.cookie.includes('SAPISID')})",
          returnByValue: true,
        },
        sessionId,
      )
      .catch(() => null);
    const value = probe?.result?.value ? JSON.parse(probe.result.value) : null;
    if (value?.origin === ORIGIN && value.cookie) return { sessionId, targetId, created: !existing };
    await sleep(500);
  }
  throw new Failure(
    "auth_required",
    "The cloned browser profile is not signed in to Google Cloud",
    "Run `gcp-credits login` and sign in, or `gcp-credits setup` to re-clone your Chromium profile",
  );
}

// One credits query exactly as the console page makes it: the session cookie
// signs the request with SAPISIDHASH, and `authUser` names which Google account
// in this profile answers.
async function creditsRequest(cdp, sessionId, billingAccount, authUser) {
  const body = JSON.stringify({ ...LIST_CREDITS_BODY, variables: { name: `billingAccounts/${billingAccount}` } });
  const expression = `
    (async () => {
      const cookies = Object.fromEntries(document.cookie.split('; ').map(c => {
        const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)];
      }));
      const sapisid = cookies['SAPISID'];
      if (!sapisid) return JSON.stringify({ transport: 'no_sapisid' });
      const ts = Math.floor(Date.now() / 1000);
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sapisid + ' ${ORIGIN}'));
      const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      // The page owns the deadline: a Google endpoint that accepts the
      // connection and then stalls must not hold the helper - and its browser -
      // open until something kills them.
      let response;
      try {
        response = await fetch(${JSON.stringify(CREDITS_URL)}, {
          method: 'POST',
          credentials: 'include',
          signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}),
          headers: {
            'content-type': 'application/json',
            authorization: 'SAPISIDHASH ' + ts + '_' + hash,
            'x-goog-authuser': '${authUser}',
          },
          body: ${JSON.stringify(body)},
        });
      } catch (error) {
        return JSON.stringify({ transport: 'failed', message: String((error && error.message) || error) });
      }
      return JSON.stringify({ transport: 'http', status: response.status, text: await response.text() });
    })()`;
  const out = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    REQUEST_TIMEOUT_MS + 15000,
  );
  const raw = out?.result?.value;
  if (typeof raw !== "string") {
    const detail = out?.exceptionDetails?.exception?.description || "no value returned";
    throw new Failure("browser_failed", `The console page answered nothing: ${String(detail).slice(0, 200)}`, null);
  }
  const result = JSON.parse(raw);
  if (result.transport === "no_sapisid")
    throw new Failure("auth_required", "The console page has no SAPISID cookie", "Run `gcp-credits login`");
  if (result.transport === "failed")
    throw new Failure(
      "network_error",
      `The credits request failed: ${String(result.message).slice(0, 200)}`,
      "Check this machine's network, then let the next refresh run",
    );
  if (result.status !== 200) {
    const detail = result.text.slice(0, 300).replace(/\s+/g, " ");
    throw new Failure(
      result.status === 401 || result.status === 403 ? "auth_required" : "http_error",
      `credits request failed with HTTP ${result.status}: ${detail}`,
      "Run `gcp-credits login` if the browser session expired",
    );
  }
  return JSON.parse(result.text);
}

// A Chromium profile usually holds more than one Google account, and the API
// answers for the account the `authuser` index names. A billing account only
// answers for the account that owns it, and every other index is refused with a
// permission error, so the index is found by asking. That is what keeps this
// working after `setup` re-clones a profile whose useful account is not first.
async function fetchCredits(cdp, sessionId, billingAccount) {
  let denied = "";
  for (const authUser of [0, 1, 2, 3]) {
    const payload = await creditsRequest(cdp, sessionId, billingAccount, authUser);
    const entry = payload[0]?.results?.[0];
    if (entry?.errors?.length) {
      const message = entry.errors.map((e) => e.message).join("; ").slice(0, 300);
      // Only a permission answer means "wrong account"; anything else is the
      // query itself being refused and must not be retried.
      if (!/permission|forbidden|unauthor/i.test(message)) {
        throw new Failure(
          "query_rejected",
          `The console rejected the credits query: ${message}`,
          "The stored query signature probably changed; re-capture it from the billing credits page",
        );
      }
      denied = message;
      continue;
    }
    return { credits: entry?.data?.creditsQuery?.listCredits?.data ?? null, authUser };
  }
  throw new Failure(
    "query_rejected",
    `No Google account signed in to the cloned profile can read this billing account: ${denied}`,
    "Run `gcp-credits login` and sign in with the account that owns the billing account",
  );
}

// ---------------------------------------------------------------------------
// billing account

function accountId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return ACCOUNT_ID_RE.test(id) ? id : "";
}

function resolveBillingAccount(args) {
  const config = readConfig();
  const explicit = args.account !== undefined ? args.account : process.env.GCP_CREDITS_ACCOUNT;
  // `--account --json` parses as `true`, and a junk id would be cached and then
  // sent to the API on every later fetch, so anything explicit is checked.
  if (explicit !== undefined && explicit !== false && !accountId(explicit)) {
    throw new Failure(
      "bad_account",
      `"${typeof explicit === "string" ? explicit : ""}" is not a billing account id`,
      "Use the id from `gcloud billing accounts list`.",
    );
  }
  for (const candidate of [accountId(explicit), accountId(config.billingAccount)]) if (candidate) return candidate;

  const listed = run("gcloud", ["billing", "accounts", "list", "--format=json"]);
  let account = "";
  if (listed.status === 0) {
    try {
      const accounts = JSON.parse(listed.stdout);
      const open = accounts.find((entry) => entry.open) || accounts[0];
      account = accountId(String(open?.name || "").split("/").pop());
    } catch {
      account = "";
    }
  }
  if (!account) {
    throw new Failure(
      "no_billing_account",
      "No billing account found",
      "Pass --account <id>, set GCP_CREDITS_ACCOUNT, or sign in with `gcloud auth login`",
    );
  }
  if (account !== config.billingAccount) {
    writePrivate(CONFIG_FILE, JSON.stringify({ ...config, billingAccount: account }, null, 2));
  }
  return account;
}

// ---------------------------------------------------------------------------
// lock

function lockState(now) {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8").trim() || 0);
  } catch {
    pid = 0;
  }
  let age = Infinity;
  try {
    age = now - fs.statSync(LOCK_DIR).mtimeMs;
  } catch {
    age = Infinity;
  }
  // No usable pid yet: either a fetch is a millisecond into writing the lock, or
  // a killed fetch left a directory that must not wedge everyone forever.
  if (!Number.isInteger(pid) || pid <= 0) return age < LOCK_SETTLE_MS ? "busy" : "stale";
  // A pid alone cannot be trusted: pids are recycled, and a fetch is over in
  // seconds, so age decides once no run could still be going.
  if (age > LOCK_STALE_MS) return "stale";
  try {
    process.kill(pid, 0);
    return "busy";
  } catch {
    return "stale";
  }
}

function acquireLock() {
  ensurePrivateDir(STATE_DIR);
  try {
    fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
  } catch {
    if (lockState(Date.now()) === "busy") throw new Failure("busy", "Another gcp-credits fetch is already running");
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
  }
  writePrivate(path.join(LOCK_DIR, "pid"), String(process.pid));
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// commands

async function cmdFetch(args) {
  if (!profileState().present) {
    throw new Failure("setup_required", "No cloned browser profile yet", "Run `gcp-credits setup` once");
  }
  // Only a fetch that won the lock releases it, so the acquisition stays out of
  // the try: everything after it runs with the lock held and releases it on
  // every path, including a bad account id and a browser that never starts.
  acquireLock();
  try {
    const account = resolveBillingAccount(args);
    const browser = await launchBrowser();
    activeBrowser = browser;
    try {
      const page = await consolePage(browser.cdp);
      const fetched = await fetchCredits(browser.cdp, page.sessionId, account);
      if (!fetched.credits) throw new Failure("empty_response", "The console returned no credit rows", null);
      const fetchedAt = new Date().toISOString();
      const rank = { available: 0, future: 1, expired: 2, used: 3 };
      const credits = fetched.credits
        .map(toCredit)
        .sort((a, b) => rank[a.state] - rank[b.state] || b.remaining - a.remaining);
      const result = snapshot(credits, account, fetchedAt, fetched.authUser);
      writeAtomic(CACHE_FILE, JSON.stringify(result, null, 2));
      return result;
    } finally {
      activeBrowser = null;
      browser.cdp.close();
      await stopBrowser(browser.child);
    }
  } finally {
    releaseLock();
  }
}

function cmdLogin() {
  if (!profileState().present) {
    throw new Failure("setup_required", "No cloned browser profile yet", "Run `gcp-credits setup` once");
  }
  assertChromium();
  ensureProfileFree();
  clearSingletons();
  const logFd = openBrowserLog();
  // No debug channel on purpose: this window is for the user to sign in, and a
  // port that outlives the command would hand the cloned session to any local
  // process for as long as the window stays open.
  const child = spawn(CHROMIUM, [...CHROMIUM_ARGS, `${ORIGIN}/billing`], { stdio: ["ignore", logFd, logFd], detached: true });
  child.unref();
  return {
    ok: true,
    message: "Sign in to Google Cloud in the window that just opened, then close it: the bar cannot refresh while it stays open.",
    pid: child.pid,
  };
}

function cmdDoctor() {
  const cache = readJson(CACHE_FILE, null);
  const config = readConfig();
  let chromium = null;
  try {
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    chromium = CHROMIUM;
  } catch {
    chromium = null;
  }
  return {
    chromium,
    sourceProfile: config.sourceProfile || SOURCE_PROFILE,
    profile: profileState(),
    cache: cache
      ? { ok: cache.ok, code: cache.code || null, error: cache.error || null, fetchedAt: cache.fetchedAt, credits: Array.isArray(cache.credits) ? cache.credits.length : 0 }
      : null,
    billingAccount: config.billingAccount || null,
    lock: fs.existsSync(LOCK_DIR) ? lockState(Date.now()) : null,
    browserRunning: profileBrowserPid(),
    version: process.version,
  };
}

const COMMANDS = { setup: cmdSetup, fetch: cmdFetch, login: cmdLogin, doctor: cmdDoctor };

function parseArgs(argv) {
  const [name, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return { name, args };
}

async function main() {
  const { name, args } = parseArgs(process.argv.slice(2));
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write("usage: gcp-credits <setup|fetch|login|doctor> [--account ID] [--profile DIR]\n");
    process.exit(2);
  }
  try {
    const result = await command(args);
    // The JSON always goes to stdout: it is the whole point of the command, and
    // the widget parses it to know what the fetch did. The one-line summary is
    // for a human reading a terminal, so it goes to stderr.
    fs.writeSync(process.stdout.fd, JSON.stringify(result, null, 2) + "\n");
    if (name === "fetch") {
      const summary =
        result.ok && result.totals.length
          ? result.totals
              .map((t) => `${t.currency} ${t.usable.toFixed(2)} usable of ${t.remaining.toFixed(2)} across ${t.count}`)
              .join(" | ")
          : `failed: ${result.error}`;
      process.stderr.write(`gcp-credits: ${summary}\n`);
    }
    process.exit(result.ok === false ? 1 : 0);
  } catch (error) {
    const failure =
      error instanceof Failure
        ? errorSnapshot(error.code, error.message, error.hint, null)
        : errorSnapshot("unexpected", error.message, null, null);
    // Losing the fetch race is not a reading: another fetch holds the lock and
    // is about to write a real snapshot, so the file keeps the last good one
    // instead of blinking to a failure on the bar.
    if (name === "fetch" && failure.code !== "busy") writeAtomic(CACHE_FILE, JSON.stringify(failure, null, 2));
    fs.writeSync(process.stdout.fd, JSON.stringify(failure, null, 2) + "\n");
    process.stderr.write(`gcp-credits: ${error.message}\n`);
    process.exit(1);
  }
}

main();
