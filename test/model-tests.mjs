#!/usr/bin/env node
// Fast unit tests for Model.js (pure snapshot parsing and formatting).
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../Model.js");

let pass = 0;
function test(name, fn) {
  fn();
  pass++;
}

test("coercion and sanitizers", () => {
  assert.equal(M.isArray([]), true);
  assert.equal(M.isArray({}), false);
  assert.equal(M.text(null), "");
  assert.equal(M.text(42), "42");
  assert.equal(M.isBlank("  \n\t "), true);
  assert.equal(M.isBlank(" a "), false);
  assert.equal(M.clampText("a\u0000b\nc\x1fd", 10), "a b c d");
  assert.equal(M.clampText("abcdef", 4), "abcd…");
  assert.equal(M.numberOr(null, 7), 7);
  assert.equal(M.numberOr("", 7), 7);
  assert.equal(M.numberOr("12.5", 0), 12.5);
  assert.equal(M.numberOr("nan", 5), 5);
  assert.equal(M.countOr(-3), 0);
  assert.equal(M.countOr(4.9), 4);
  assert.equal(M.clampIntervalSeconds(10), M.MIN_INTERVAL_SECONDS);
  assert.equal(M.clampIntervalSeconds(999999), M.MAX_INTERVAL_SECONDS);
  assert.equal(M.clampIntervalSeconds("bad"), M.DEFAULT_INTERVAL_SECONDS);
  assert.equal(M.billingAccountId("01ABCD-23EF45-6789AB"), "01ABCD-23EF45-6789AB");
  assert.equal(M.billingAccountId("--account"), "");
  assert.equal(M.billingAccountId("../etc/passwd"), "");
  assert.equal(M.currencyCode(" inr "), "INR");
  assert.equal(M.currencyCode("123"), "");
});

test("paths, argv, and urls", () => {
  assert.equal(
    M.helperScriptPath("file:///home/u/my%20dir/bin/gcp-credits.mjs", "/home/u"),
    "/home/u/my dir/bin/gcp-credits.mjs",
  );
  assert.equal(M.helperScriptPath("/opt/gcp-credits.mjs", "/home/u"), "/opt/gcp-credits.mjs");
  assert.equal(
    M.helperScriptPath("", "/home/u"),
    "/home/u/" + M.DEFAULT_SCRIPT_RELATIVE_PATH,
  );
  assert.equal(M.helperScriptPath("", ""), "");
  assert.equal(M.cachePath("/home/u"), "/home/u/" + M.CACHE_RELATIVE_PATH);
  assert.equal(M.cachePath(""), "");
  assert.deepEqual(M.helperArgv("/bin/h.mjs", "01ABCD-23EF45-6789AB"), [
    "node",
    "/bin/h.mjs",
    "fetch",
    "--account",
    "01ABCD-23EF45-6789AB",
  ]);
  assert.deepEqual(M.helperArgv("/bin/h.mjs", "--bad"), ["node", "/bin/h.mjs", "fetch"]);
  assert.equal(M.isSafeUrl("https://console.cloud.google.com/billing"), true);
  assert.equal(M.isSafeUrl("javascript:alert(1)"), false);
  assert.equal(
    M.consoleUrl("01ABCD-23EF45-6789AB"),
    "https://console.cloud.google.com/billing/01ABCD-23EF45-6789AB/credits/all",
  );
  assert.equal(M.consoleUrl("bad/id"), M.CONSOLE_BASE_URL);
});

test("parseSnapshot and parseFetchOutput", () => {
  assert.equal(M.parseSnapshot("   ").loading, true);
  assert.equal(M.parseSnapshot("{bad").code, "unexpected");
  assert.equal(M.parseSnapshot("[]").code, "unexpected");
  assert.equal(M.parseSnapshot('{"schema":1}').code, "unexpected");
  assert.equal(M.parseSnapshot('{"schema":2,"ok":true}').code, "unexpected");

  const raw = JSON.stringify({
    schema: 1,
    ok: true,
    fetchedAt: "2026-10-18T10:00:00Z",
    billingAccount: "01ABCD-23EF45-6789AB",
    primaryCurrency: "inr",
    totalUsable: 50000.25,
    totals: Array.from({ length: 15 }, (_, i) => ({
      currency: i === 0 ? "INR" : "USD",
      usable: i === 0 ? 50000.25 : 0,
      remaining: 50000.25,
      original: 100000,
      count: 2,
    })),
    credits: [
      {
        id: "c1",
        displayName: "Startup Credit",
        remaining: 1250.5,
        original: 5000,
        currency: "USD",
        start: "2026-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
        state: "AVAILABLE",
      },
      {
        id: "c2",
        displayName: "",
        remaining: 0,
        original: 500,
        currency: "USD",
        percentRemaining: 0,
        state: "used",
      },
    ],
  });
  const view = M.parseSnapshot(raw);
  assert.equal(view.ok, true);
  assert.equal(view.primaryCurrency, "INR");
  assert.equal(view.totals.length, M.MAX_TOTALS);
  assert.equal(view.droppedTotals, 3);
  assert.equal(view.credits.length, 2);
  assert.equal(view.credits[0].state, "available");
  assert.equal(Number.isNaN(view.credits[0].percentRemaining), true);
  assert.equal(view.credits[1].percentRemaining, 0);

  assert.equal(M.parseFetchOutput(0, raw, "", "").ok, true);
  assert.equal(M.parseFetchOutput(1, "", "boom", raw).ok, true);
  const failed = M.parseFetchOutput(2, "", "line1\nline2", "");
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "gcp-credits fetch failed (exit 2): line1");
  assert.match(M.timeoutView(30).error, /30 seconds/);
});

test("amount formatting", () => {
  assert.equal(M.groupThousands("1234567"), "1,234,567");
  assert.equal(M.formatAmount(NaN, "USD", "compact"), "—");
  assert.equal(M.formatAmount(12345.67, "INR", "exact"), "12,345.67");
  assert.equal(M.formatAmount(12345, "INR", "exact"), "12,345");
  assert.equal(M.formatAmount(150000, "INR", "compact"), "1.50L");
  assert.equal(M.formatAmount(25000000, "INR", "compact"), "2.50Cr");
  assert.equal(M.formatAmount(1500000, "USD", "compact"), "1.50M");
  assert.equal(M.formatAmount(-1250, "USD", "compact"), "-1.25k");
  assert.equal(M.amountWithCurrency(1000, "USD", "compact"), "USD 1.00k");
  assert.equal(M.amountWithCurrency(1000, "", "exact"), "1,000");
  assert.equal(M.plural(1, "credit", "credits"), "credit");
  assert.equal(M.plural(2, "credit", "credits"), "credits");
});

test("bar, tooltip, status, and panel helpers", () => {
  const now = Date.parse("2026-10-18T10:05:00Z");
  const view = M.parseSnapshot(
    JSON.stringify({
      schema: 1,
      ok: true,
      fetchedAt: "2026-10-18T10:00:00Z",
      billingAccount: "01ABCD-23EF45-6789AB",
      primaryCurrency: "USD",
      totalUsable: 1500,
      totals: [
        { currency: "USD", usable: 1500, remaining: 1500, original: 2000, count: 1 },
        { currency: "INR", usable: 100000, remaining: 100000, original: 100000, count: 1 },
      ],
      credits: [
        {
          id: "1",
          displayName: "GenAI",
          remaining: 250,
          original: 1000,
          currency: "USD",
          end: "2026-12-31T00:00:00Z",
          state: "available",
        },
        {
          id: "2",
          displayName: "",
          remaining: 0,
          original: 500,
          currency: "USD",
          end: "2026-01-01T00:00:00Z",
          state: "expired",
        },
      ],
    }),
  );

  assert.equal(M.barLabel(view, "compact"), "USD 1.50k · INR 1.00L");
  assert.equal(M.warningMarker(), "⚠");
  assert.equal(M.ageText("2026-10-18T10:00:00Z", now), "5 minutes ago");
  assert.match(M.tooltip(view, "compact", now), /Billing account 01ABCD-23EF45-6789AB/);
  assert.match(M.statusLine(view, "compact", now), /2 credits, snapshot 5 minutes ago/);
  assert.equal(M.heroMeta(view), "01ABCD-23EF45-6789AB");
  assert.match(M.summaryLine(view.totals[0], "exact"), /^USD 1,500 usable/);
  assert.equal(M.creditTitle(view.credits[0]), "GenAI");
  assert.equal(M.creditTitle(view.credits[1]), "Unnamed credit");
  assert.equal(M.creditStateLabel("available"), "Available");
  assert.equal(M.creditStateLabel("custom"), "Custom");
  assert.equal(M.visibleCredits(view.credits, false).length, 1);
  assert.equal(M.hiddenCreditCount(view.credits, false), 1);
  assert.match(M.hiddenCreditsNote(1), /1 expired or used credit hidden/);
  assert.equal(M.percentRemaining(view.credits[0]), 25);
  assert.equal(M.percentText(view.credits[0]), "25%");
  assert.equal(M.remainingText(view.credits[0], "exact"), "250 of 1,000");
  assert.match(M.endText(view.credits[0], now), /^ends 2026-12-/);
  assert.match(M.endText(view.credits[1], now), /^ended 2026-01-/);
  assert.equal(M.droppedCreditsNote({ credits: [1], droppedCredits: 2 }), "Showing the first 1 of 3 credits");
  assert.equal(M.droppedTotalsNote({ totals: [1], droppedTotals: 1 }), "Showing the first 1 of 2 currencies");
  assert.equal(M.errorCode(M.failureView("busy", "err", "hint")), "code: busy");
  assert.equal(M.errorText(M.loadingView()), "No snapshot read yet.");
  assert.match(M.errorHint(M.loadingView()), /Middle-click/);
  assert.match(M.emptyCreditsText(), /No credits/);
  assert.equal(M.footerHints(), "r refresh · o console");
});

console.log(`PASS  ${pass} model test groups`);
