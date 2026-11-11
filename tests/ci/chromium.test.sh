#!/usr/bin/env bash
# Tests for .github/scripts/chromium.sh against stubbed pnpm and ldd
# (tests/ci/lib/chromium-bin): the verify jobs install Playwright's Chromium
# without Ubuntu's apt mirrors (outage of 2026-11-11), prove with ldd that every
# shared library the binaries link against is on the runner, and reach for apt
# (`playwright install-deps`) only when one is missing.
# Run: bash tests/ci/chromium.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/.github/scripts/chromium.sh"
STUB_BIN="$ROOT/tests/ci/lib/chromium-bin"
for tool in pnpm ldd; do
  if [ "$(PATH="$STUB_BIN:$PATH" command -v "$tool")" != "$STUB_BIN/$tool" ]; then
    echo "FAIL - $tool stub not found at $STUB_BIN/$tool; refusing to run against the real one" >&2
    exit 1
  fi
done
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; printf 'rc=%s\nout:\n%s\ncalls:\n%s\n' "$RC" "$OUT" "$CALLS" | sed 's/^/       /'; }
check() { local label=$1; shift; if "$@"; then ok "$label"; else nok "$label"; fi; }

# run <mode>: the script with the stubs first on PATH and a fresh browsers directory.
run() {
  rm -rf "$WORK/stub" "$WORK/browsers"; mkdir -p "$WORK/stub" "$WORK/browsers"; : >"$WORK/stub/calls"
  set +e
  OUT=$(PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/stub" STUB_MODE="$1" PLAYWRIGHT_BROWSERS_PATH="$WORK/browsers" bash "$SCRIPT" 2>&1)
  RC=$?
  set -e
  CALLS=$(cat "$WORK/stub/calls")
}
has()    { grep -qF -- "$2" <<<"$1"; }
hasnt()  { ! grep -qE -- "$2" <<<"$1"; }
count()  { grep -cF -- "$2" <<<"$1" || true; }

# --- every library present: no apt at all ------------------------------------
run present
check "present: exits 0" test "$RC" -eq 0
check "present: installs chromium through the tests package" has "$CALLS" "--filter @a2h/tests exec playwright install chromium"
check "present: never --with-deps" hasnt "$CALLS" "--with-deps"
check "present: never install-deps (apt)" hasnt "$CALLS" "install-deps"
check "present: ldd on chrome" has "$CALLS" "ldd $WORK/browsers/chromium-1/chrome-linux64/chrome"
check "present: ldd on chrome-headless-shell" has "$CALLS" "ldd $WORK/browsers/chromium_headless_shell-1/chrome-headless-shell-linux64/chrome-headless-shell"
check "present: says no apt was needed" has "$OUT" "no apt"

# --- a library missing: apt as the fallback, then re-checked ------------------
run missing
check "missing: exits 0 once install-deps provided it" test "$RC" -eq 0
check "missing: warns" has "$OUT" "::warning::"
check "missing: the warning names libgbm.so.1" has "$OUT" "libgbm.so.1"
check "missing: falls back to playwright install-deps chromium" has "$CALLS" "--filter @a2h/tests exec playwright install-deps chromium"
check "missing: re-checks after install-deps (ldd twice per binary)" test "$(count "$CALLS" "ldd ")" -eq 4

# --- still missing after the fallback: fail -----------------------------------
run missing-persist
check "missing-persist: fails" test "$RC" -ne 0
check "missing-persist: names the library" has "$OUT" "libgbm.so.1"

# --- apt unreachable and a library missing: fail ------------------------------
run missing,deps-fail
check "deps-fail: fails" test "$RC" -ne 0

# --- the download fails: fail before any check --------------------------------
run install-fails
check "install-fails: fails" test "$RC" -ne 0
check "install-fails: no ldd, no apt" hasnt "$CALLS" "^ldd |install-deps"

# --- nothing downloaded: fail (an empty check would prove nothing) ------------
run no-binary
check "no-binary: fails" test "$RC" -ne 0
check "no-binary: says no binary was found" has "$OUT" "no Chromium binary"

echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
