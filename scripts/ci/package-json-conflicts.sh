#!/usr/bin/env bash
# package.json files merge by key (#142), so edits to different keys merge cleanly, and a key
# both sides changed is a conflict that pnpm cannot read until it is resolved (#111):
#   A. the project added its own pnpm override where the upgrade adds the Starter's (the
#      project's own version, set too, is kept: projects own it): merges, and installs;
#   B. the project added a script at the end of `scripts`, and `add infra local` rewrites the
#      scripts before it: merges, and installs;
#   C. the web app set its own `next` range, and the upgrade bumps it (the web app's own version,
#      set too, is kept: workspace apps own it): a conflict on that key's line only.
# Each change runs with pnpm install on. A conflict must skip the install and say why, list the
# file, exit with 2 under --detailed-exit-code (0 without it), save a valid Starter version in
# .clubedge/incoming, fail doctor, and be named by a later command instead of a parse error.
#
# Usage: bash package-json-conflicts.sh <path to bin/create.mjs> <work folder> <older Starter tag>
set -euo pipefail
cli="$1"
work="$2"
from="$3"
export NO_COLOR=1

fail() {
  echo "::error title=package.json conflicts::$1"
  exit 1
}

generate() { # <folder> [create options]
  local folder="$1"
  shift
  node "$cli" "$folder" --framework next --no-install --yes "$@" >/dev/null
  git -C "$folder" config user.email ci@example.com
  git -C "$folder" config user.name CI
  git -C "$folder" add -A
  git -C "$folder" commit -qm "Generated project"
}

# Runs the CLI in a project and checks its exit code; the output is kept for expect and reject.
cli_in() { # <folder> <expected exit code> <arguments...>
  local folder="$1" expected="$2" status=0
  shift 2
  (cd "$folder" && node "$cli" "$@" --yes) >"$work/output.txt" 2>&1 || status=$?
  cat "$work/output.txt"
  [ "$status" = "$expected" ] || fail "\`$*\` in $(basename "$folder") exited with $status, not $expected."
}

expect() { grep -qF -- "$1" "$work/output.txt" || fail "The output does not contain: $1"; }
reject() { ! grep -qF -- "$1" "$work/output.txt" || fail "The output contains: $1"; }

parses() { node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$1"; }

# A change that merged a package.json both sides changed, then installed.
check_merged() { # <project> <merged package.json>
  local project="$1" file="$2"
  expect "merge    $file"
  expect "Dependencies updated"
  reject "Skipped \`pnpm install\`"
  reject "conflict $file"
  ! grep -q '^<<<<<<< yours' "$project/$file" || fail "$file has conflict markers."
  parses "$project/$file" || fail "$file is not valid JSON."
}

# A change that left a conflict in a package.json.
check_conflict() { # <project> <conflicted package.json>
  local project="$1" file="$2"
  expect "conflict $file"
  expect "Skipped \`pnpm install\`: $file has conflict markers, which pnpm cannot read"
  expect "  $file (1 block)"
  reject "pnpm was not found"
  grep -q '^<<<<<<< yours' "$project/$file" || fail "$file has no conflict markers."
  parses "$project/.clubedge/incoming/$file" || fail ".clubedge/incoming/$file is not valid JSON."
}

rm -rf "$work"
mkdir -p "$work"

echo "::group::Generate a project from Starter $from"
generate "$work/older" --ref "$from"
echo "::endgroup::"

echo "::group::A. The project's own version and override, then upgrade"
cp -R "$work/older" "$work/a"
(cd "$work/a" && npm pkg set version=1.0.0)
# The Starter adds an override at the end of pnpm.overrides after the older tag (undici, in
# v0.25.0); the project's own at the same place is another key, so it merges. pnpm records
# overrides in the lockfile, so the project updates it, as `pnpm install` would.
(cd "$work/a" && npm pkg set "pnpm.overrides.left-pad=^1.3.0" && pnpm install --lockfile-only --silent)
# An edited file saved with CRLF, as editors on Windows can; the merge must keep its line endings.
sed -i 's/$/\r/' "$work/a/README.md"
printf 'Notes of our own.\r\n' >>"$work/a/README.md"
git -C "$work/a" commit -qam "Release 1.0.0, with an override of our own"
cli_in "$work/a" 0 upgrade --detailed-exit-code
check_merged "$work/a" package.json
grep -qx '  "version": "1.0.0",' "$work/a/package.json" || fail "The project's version was not kept."
grep -q '"left-pad": "^1.3.0"' "$work/a/package.json" || fail "The project's override was not kept."
grep -q '"undici@' "$work/a/package.json" || fail "The Starter's override was not added."
grep -q '^Notes of our own\.' "$work/a/README.md" || fail "README.md lost the project's line."
[ "$(grep -c $'\r$' "$work/a/README.md")" = "$(wc -l <"$work/a/README.md")" ] || fail "README.md lost its CRLF line endings."
echo "::endgroup::"

echo "::group::B. A script at the end of scripts, then add infra local"
generate "$work/b"
(cd "$work/b" && npm pkg set "scripts.seed:demo=tsx scripts/demo.ts")
git -C "$work/b" commit -qam "Add seed:demo"
cli_in "$work/b" 0 add infra local --detailed-exit-code
check_merged "$work/b" package.json
grep -q '"seed:demo": "tsx scripts/demo.ts"' "$work/b/package.json" || fail "The project's script was not kept."
grep -q '"infra:up": "pnpm --filter @clubedge/local-db' "$work/b/package.json" || fail "The local infra scripts were not added."
echo "::endgroup::"

echo "::group::C. The web app's own version and next, then upgrade"
cp -R "$work/older" "$work/c"
(cd "$work/c/apps/web" && npm pkg set version=1.0.0)
# The Starter bumps next after v0.24.0 (^16.1.0, to ^16.4.3 in v0.24.2): both sides changed that key.
(cd "$work/c/apps/web" && npm pkg set "dependencies.next=^16.0.0")
git -C "$work/c" commit -qam "Release the web app 1.0.0, with next 16.0.0"
cli_in "$work/c" 2 upgrade --detailed-exit-code
check_conflict "$work/c" apps/web/package.json
grep -qx '  "version": "1.0.0",' "$work/c/apps/web/package.json" || fail "The web app's version was not kept."
[ "$(grep -c '"version"' "$work/c/apps/web/package.json")" = 1 ] || fail "The web app's version is in a conflict."
# The block holds next's line on each side, and nothing else.
block=$(sed -n '/^<<<<<<< yours/,/^>>>>>>> clubedge/p' "$work/c/apps/web/package.json")
[ "$(printf '%s\n' "$block" | wc -l)" = 5 ] || fail "The conflict is not just next's line: $block"
printf '%s\n' "$block" | grep -qx '    "next": "^16.0.0",' || fail "The web app's next is not in the conflict."
expect "git diff --no-index apps/web/package.json .clubedge/incoming/apps/web/package.json"
cli_in "$work/c" 1 doctor --no-services
expect "apps/web/package.json (1 block)"
# From the web app's folder, the CLI reads that package.json first.
cli_in "$work/c/apps/web" 1 status
expect "package.json has 1 unresolved conflict from an earlier add, remove, or upgrade"
expect "git diff --no-index package.json ../../.clubedge/incoming/apps/web/package.json"
# Without --detailed-exit-code, conflicts exit with 0, as the upgrade workflow in existing projects expects.
git -C "$work/c" checkout -q -- .
git -C "$work/c" clean -fdq
cli_in "$work/c" 0 upgrade
check_conflict "$work/c" apps/web/package.json
echo "::endgroup::"

echo "Edits to different keys merged and installed, and the conflict on one key was reported."
