#!/usr/bin/env bash
# Post-merge checks for the gcp-credits helper. Runs against a throwaway HOME
# with a copy of the live profile clone, so the real cache is never touched.
#
#   ./test/helper-tests.sh [path/to/gcp-credits.mjs]
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
HELPER=${1:-$SCRIPT_DIR/bin/gcp-credits.mjs}
LIVE_CLONE=$HOME/.cache/gcp-credits/profile
LIVE_CONFIG=$HOME/.cache/gcp-credits/config.json
ACCOUNT=$(python3 -c "import json;print(json.load(open('$LIVE_CONFIG')).get('billingAccount',''))" 2>/dev/null || true)
ACCOUNT=${GCP_CREDITS_ACCOUNT:-$ACCOUNT}
[ -n "$ACCOUNT" ] || { echo "no billing account id available"; exit 2; }

pass=0; fail=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2', want '$3')"; fi; }
count(){ local n; n=$(pgrep -fc "$1" 2>/dev/null || true); echo "${n:-0}"; }

echo "== helper under test: $HELPER"
echo "== account: $ACCOUNT"

# Copy the live profile clone and billing account config into a throwaway HOME
# so real fetches and lock checks never touch ~/.cache/gcp-credits.
copy_home() {
  local tmp; tmp=$(mktemp -d /tmp/gcp-t-XXXXXX)
  mkdir -p "$tmp/.cache/gcp-credits"
  cp -a "$LIVE_CLONE" "$tmp/.cache/gcp-credits/profile"
  printf '{"sourceProfile":"copied","copiedAt":"%s","billingAccount":"%s"}\n' "$(date -Is)" "$ACCOUNT" \
    > "$tmp/.cache/gcp-credits/config.json"
  chmod 600 "$tmp/.cache/gcp-credits/config.json"
  echo "$tmp"
}

json() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d$2)" "$1" 2>/dev/null; }
seed_good() {
  printf '{"schema":1,"ok":true,"code":null,"fetchedAt":"%s","billingAccount":"%s","totalUsable":1,"totals":[],"credits":[]}\n' "$(date -Is)" "$ACCOUNT" \
    > "$1/.cache/gcp-credits/credits.json"
  chmod 600 "$1/.cache/gcp-credits/credits.json"
}

# ------------------------------------------------- T1 a real fetch, over the pipe
H=$(copy_home)
( for _ in $(seq 1 80); do
    pid=$(pgrep -f "user-data-dir=$H/.cache/gcp-credits/profile" | head -1)
    if [ -n "${pid:-}" ]; then
      ps -o args= -p "$pid" > "$H/cmdline.txt" 2>/dev/null
      ss -ltnp 2>/dev/null | grep -c "pid=$pid," > "$H/listen.txt" 2>/dev/null || true
      break
    fi
    sleep 0.25
  done ) &
watcher=$!
HOME=$H node "$HELPER" fetch > "$H/out.json" 2>"$H/err.txt"; rc=$?
wait $watcher
check "T1 a real fetch exits 0" "$rc" "0"
check "T1 the printed snapshot is ok" "$(json "$H/out.json" "['ok']")" "True"
check "T1 the snapshot carries credits" "$(python3 -c "import json;print(len(json.load(open('$H/out.json'))['credits']) > 0)")" "True"
check "T1 the snapshot names the account that answered" "$([ "$(json "$H/out.json" "['authUser']")" != "None" ] && echo yes || echo no)" "yes"
check "T1 the browser was launched with the debug pipe" "$(grep -c -- '--remote-debugging-pipe' "$H/cmdline.txt" 2>/dev/null || true)" "1"
check "T1 the browser was launched without a debug port" "$(grep -c -- '--remote-debugging-port' "$H/cmdline.txt" 2>/dev/null || true)" "0"
check "T1 the browser opened no listening socket" "$(cat "$H/listen.txt" 2>/dev/null || echo 0)" "0"
sleep 1
check "T1 no chromium is left behind" "$(count "user-data-dir=$H/.cache/gcp-credits/profile")" "0"
check "T1 the lock is released" "$([ -e "$H/.cache/gcp-credits/fetch.lock" ] && echo present || echo gone)" "gone"

# ------------------------------------------------- T2 busy must not clobber
seed_good "$H"
cp "$H/.cache/gcp-credits/credits.json" "$H/seed.json"
mkdir -p "$H/.cache/gcp-credits/fetch.lock"
echo $$ > "$H/.cache/gcp-credits/fetch.lock/pid"
HOME=$H node "$HELPER" fetch >"$H/busy.json" 2>/dev/null; rc=$?
check "T2 exit code while another fetch holds the lock" "$rc" "1"
check "T2 failure code" "$(json "$H/busy.json" "['code']")" "busy"
if cmp -s "$H/seed.json" "$H/.cache/gcp-credits/credits.json"; then ok "T2 the last good snapshot is untouched"; else bad "T2 busy overwrote the cache"; fi
rm -rf "$H/.cache/gcp-credits/fetch.lock"

# --------------------------------------------- T3 a dead holder is reclaimed
mkdir -p "$H/.cache/gcp-credits/fetch.lock"
echo 999999 > "$H/.cache/gcp-credits/fetch.lock/pid"
HOME=$H node "$HELPER" fetch --account 'not a real id' >"$H/bada.json" 2>/dev/null
check "T3 a dead pid's lock is reclaimed and the run reaches the account check" "$(json "$H/bada.json" "['code']")" "bad_account"
check "T3 the lock is released on that failure path" "$([ -e "$H/.cache/gcp-credits/fetch.lock" ] && echo present || echo gone)" "gone"

# ------------------------------------------- T4 lock without a pid, and blank
rm -rf "$H/.cache/gcp-credits/fetch.lock"; mkdir -p "$H/.cache/gcp-credits/fetch.lock"
HOME=$H node "$HELPER" fetch >"$H/nopid.json" 2>/dev/null
check "T4 a lock being written right now reads as busy" "$(json "$H/nopid.json" "['code']")" "busy"
sleep 5.5
HOME=$H node "$HELPER" fetch --account 'not a real id' >"$H/old.json" 2>/dev/null
check "T4 an abandoned lock directory is reclaimed after it settles" "$(json "$H/old.json" "['code']")" "bad_account"
rm -rf "$H/.cache/gcp-credits/fetch.lock"; mkdir -p "$H/.cache/gcp-credits/fetch.lock"; : > "$H/.cache/gcp-credits/fetch.lock/pid"
sleep 5.5
HOME=$H node "$HELPER" fetch --account 'not a real id' >"$H/blank.json" 2>/dev/null
check "T4 a blank pid file is not a live owner" "$(json "$H/blank.json" "['code']")" "bad_account"
rm -rf "$H/.cache/gcp-credits/fetch.lock"

# ------------------------------------------------- T5 no torn reads while writing
seed_good "$H"
( torn=0; for _ in $(seq 1 1200); do
    python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$H/.cache/gcp-credits/credits.json" 2>/dev/null || torn=$((torn + 1))
  done; echo "$torn" > "$H/torn.txt" ) &
reader=$!
HOME=$H node "$HELPER" fetch >/dev/null 2>&1
wait $reader
check "T5 torn reads while the cache is rewritten" "$(cat "$H/torn.txt")" "0"

# ------------------------------------------------ T6 SIGTERM cleans up
HOME=$H node "$HELPER" fetch >/dev/null 2>&1 &
fetch_pid=$!
sleep 2
pkill -TERM -P "$fetch_pid" 2>/dev/null
kill -TERM "$fetch_pid" 2>/dev/null
wait "$fetch_pid" 2>/dev/null
sleep 3
check "T6 a killed fetch releases the lock" "$([ -e "$H/.cache/gcp-credits/fetch.lock" ] && echo present || echo gone)" "gone"
check "T6 a killed fetch leaves no browser" "$(count "user-data-dir=$H/.cache/gcp-credits/profile")" "0"

# ------------------------------------------------ T7 a live window is not stolen
rm -f "$H/.cache/gcp-credits/profile/SingletonLock"
ln -s "$(hostname)-$$" "$H/.cache/gcp-credits/profile/SingletonLock"
HOME=$H node "$HELPER" fetch >"$H/running.json" 2>/dev/null
check "T7 fetch refuses while a clone window is open" "$(json "$H/running.json" "['code']")" "browser_running"
check "T7 the live window's lock survives" "$(readlink "$H/.cache/gcp-credits/profile/SingletonLock")" "$(hostname)-$$"
rm -f "$H/.cache/gcp-credits/profile/SingletonLock"

# --------------------------------------- T8 a headless orphan is reaped, not fatal
sleep 400 &
orphan=$!
ln -s "$(hostname)-$orphan" "$H/.cache/gcp-credits/profile/SingletonLock"
HOME=$H node "$HELPER" fetch --account 'not a real id' >"$H/orphan.json" 2>/dev/null
check "T8 a leftover headless browser is reaped, not reported as a window" "$(json "$H/orphan.json" "['code']")" "bad_account"
rm -f "$H/.cache/gcp-credits/profile/SingletonLock"

# ------------------------------------------------- T9 setup keeps the account id
HOME=$H node "$HELPER" setup --profile "$LIVE_CLONE" >/dev/null 2>&1
check "T9 setup keeps the cached billing account" "$(json "$H/.cache/gcp-credits/config.json" "['billingAccount']")" "$ACCOUNT"
check "T9 config mode" "$(stat -c %a "$H/.cache/gcp-credits/config.json")" "600"

# ------------------------------------------------- T10 bad account ids are refused
rm -f "$H/.cache/gcp-credits/config.json"; echo '{}' > "$H/.cache/gcp-credits/config.json"
HOME=$H node "$HELPER" fetch --account >"$H/junk.json" 2>/dev/null
check "T10 --account with no value is refused" "$(json "$H/junk.json" "['code']")" "bad_account"
check "T10 the junk value is not cached" "$(json "$H/.cache/gcp-credits/config.json" ".get('billingAccount')")" "None"

# ------------------------------------------------- T11 missing chromium, cleanly
HOME=$H GCP_CREDITS_CHROMIUM=/nonexistent/chromium node "$HELPER" fetch --account "$ACCOUNT" >"$H/nochrome.json" 2>/dev/null; rc=$?
check "T11 a missing chromium exits non-zero" "$rc" "1"
check "T11 a missing chromium is reported, not thrown" "$(json "$H/nochrome.json" "['code']")" "no_chromium"
check "T11 no lock is left by that failure" "$([ -e "$H/.cache/gcp-credits/fetch.lock" ] && echo present || echo gone)" "gone"
touch "$H/notexec"
HOME=$H GCP_CREDITS_CHROMIUM=$H/notexec node "$HELPER" doctor >"$H/doc2.json" 2>/dev/null
check "T11 doctor does not claim a non-executable chromium" "$(json "$H/doc2.json" "['chromium']")" "None"

# ------------------------------------------------- T12 doctor
HOME=$H node "$HELPER" doctor >"$H/doctor.json" 2>/dev/null
check "T12 doctor reports the chromium path" "$([ "$(json "$H/doctor.json" "['chromium']")" != "None" ] && echo yes || echo no)" "yes"
check "T12 doctor reports no running browser" "$(json "$H/doctor.json" "['browserRunning']")" "None"
check "T12 doctor reports no lock" "$(json "$H/doctor.json" "['lock']")" "None"

echo
echo "== $pass passed, $fail failed"
[ "${KEEP:-0}" = 1 ] || rm -rf "$H" /tmp/gcp-t-*
[ "$fail" = 0 ]
