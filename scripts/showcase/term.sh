# Helpers for the terminal scenes of the showcase walkthroughs, sourced by each scene script.
# A scene runs inside record-session.py; commands are typed out for the viewer, then run exactly
# as shown. Anything not shown (secrets, file edits) is done by plain commands between them.
export GIT_PAGER=cat

type_out() {
  local text="$1"
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:i:1}"
    sleep 0.026
  done
  sleep 0.35
  printf '\n'
}

prompt() { printf '\033[34m$\033[0m '; }

# Types a command, runs it, and pauses so the output can be read.
run() {
  prompt
  type_out "$1"
  eval "$1"
  sleep "${2:-1.2}"
}

# A comment line, for what happens off screen.
note() {
  printf '\033[2m# %s\033[0m\n' "$1"
  sleep 1.4
}

# Starts a long-running command (a dev server, a local database) detached from the terminal, shows
# its output until it prints the ready pattern, and leaves it running for the next scenes.
#   serve "<command>" "<ready regex>" <name>
serve() {
  local log="$SHOWCASE_STATE/$3.log"
  prompt
  type_out "$1"
  : > "$log"
  setsid bash -c "$1" > "$log" 2>&1 < /dev/null &
  echo $! > "$SHOWCASE_STATE/$3.pid"
  tail -n +1 -f "$log" &
  local tail=$!
  if ! timeout 300 bash -c "until grep -qE '$2' '$log'; do sleep 0.5; done"; then
    kill "$tail"
    echo "$1 did not become ready" >&2
    exit 1
  fi
  sleep 2
  kill "$tail"
  wait "$tail" 2> /dev/null || true
}

# Stops what serve started (off screen), the way Ctrl+C would.
stop() {
  local pidfile="$SHOWCASE_STATE/$1.pid"
  [ -f "$pidfile" ] || return 0
  kill -INT -- "-$(cat "$pidfile")" 2> /dev/null || true
  timeout 30 bash -c "while kill -0 -- -$(cat "$pidfile") 2>/dev/null; do sleep 0.5; done" || kill -KILL -- "-$(cat "$pidfile")" 2> /dev/null || true
  rm -f "$pidfile"
}

# Sets KEY=VALUE in an env file (off screen), replacing an existing line.
setenv() {
  local file="$1" key="$2" value="$3"
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# The app's env file: apps/web for Next.js, apps/start for TanStack Start.
envfile() { ls apps/*/.env.local | head -n 1; }
