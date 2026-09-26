#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
profile_dir="${project_dir}/.auth/codeforces-chrome-profile"
mkdir -p "$profile_dir"
chmod 700 "$profile_dir"

if [[ -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]]; then
  chrome_bin='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
elif [[ -x "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  chrome_bin="${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome-stable >/dev/null 2>&1; then
  chrome_bin="$(command -v google-chrome-stable)"
elif command -v google-chrome >/dev/null 2>&1; then
  chrome_bin="$(command -v google-chrome)"
else
  echo 'Stable Google Chrome is not installed. Install it locally and retry.' >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:9222 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Local CDP port 9222 is already in use. Close that browser/process before launching the dedicated Chrome session.' >&2
  exit 1
fi

# Chrome is launched by the operating system, with no Playwright involvement.
nohup "$chrome_bin" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$profile_dir" \
  'https://codeforces.com/enter' >/dev/null 2>&1 </dev/null &

cat <<'MESSAGE'
Google Chrome is opening with the dedicated Codeforces profile.
Log in and complete any verification manually. Reach a normal authenticated Codeforces page.
Leave this Chrome window open, then run `npm run session:export` in another terminal.
MESSAGE
