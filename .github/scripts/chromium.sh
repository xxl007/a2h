#!/usr/bin/env bash
# Installs Playwright's Chromium for the verify jobs without Ubuntu's apt mirrors.
#
# Why: on 2026-11-11 every verify failed at `playwright install --with-deps
# chromium` because apt on the runner could not resolve archive.ubuntu.com,
# azure.archive.ubuntu.com or security.ubuntu.com (run 43031922902). That log
# shows the runner image already holds every shared library Chromium links
# against ("already the newest version"); apt was fetching nine optional font
# packages only (CJK, Thai, GNU Unifont, X11 bitmap fonts). No suite compares
# pixels, so those fonts change no result.
#
# So: download the browser from Playwright's CDN (no apt), then prove with ldd
# that nothing the binaries need is missing. Only if a library is missing (a
# future runner image) fall back to `playwright install-deps chromium` (apt),
# and check again; still missing fails the step.
# Run: .github/scripts/chromium.sh   (no arguments)
set -euo pipefail

browsers="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

pnpm --filter @a2h/tests exec playwright install chromium

mapfile -t bins < <(find "$browsers" -type f \( -name chrome -o -name chrome-headless-shell \) | sort)
if [ "${#bins[@]}" -eq 0 ]; then
  echo "::error::no Chromium binary under $browsers after playwright install" >&2
  exit 1
fi

# Prints "<binary>: <library>" for each library ldd reports not found.
missing() {
  local b
  for b in "${bins[@]}"; do
    ldd "$b" | awk -v b="$b" '/=> not found/ { print b ": " $1 }'
  done
}

gaps=$(missing)
if [ -z "$gaps" ]; then
  echo "Chromium: every shared library of ${#bins[@]} binaries is on the runner; no apt."
  exit 0
fi

echo "::warning::Chromium needs libraries the runner lacks; falling back to apt (playwright install-deps): $(cut -d' ' -f2 <<<"$gaps" | sort -u | tr '\n' ' ')"
printf '%s\n' "$gaps"
pnpm --filter @a2h/tests exec playwright install-deps chromium

gaps=$(missing)
if [ -n "$gaps" ]; then
  echo "::error::Chromium libraries still missing after install-deps:" >&2
  printf '%s\n' "$gaps" >&2
  exit 1
fi
echo "Chromium: every shared library present after install-deps."
