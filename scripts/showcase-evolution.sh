#!/usr/bin/env bash
# The project-evolution showcase: a project generated from an older Starter, edited, upgraded,
# and changed with add and remove, using the published CLI. Recorded by record-session.py.
# Commands are typed out for the viewer, then run exactly as shown.
#   bash scripts/showcase-evolution.sh <empty-directory> [starter-ref]
set -euo pipefail
cd "$1"
FROM="${2:-v0.14.0}"
export GIT_PAGER=cat

mark() { printf '\033]1337;Marker=%s\a' "$1"; }
type_out() {
  local text="$1"
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:i:1}"
    sleep 0.028
  done
  sleep 0.4
  printf '\n'
}
run() {
  printf '\033[34m$\033[0m '
  type_out "$1"
  eval "$1"
  sleep 1.2
}
note() {
  printf '\033[2m# %s\033[0m\n' "$1"
  sleep 1.4
}

mark "Create a project on Starter $FROM"
run "pnpm dlx @clubedge/create-clubedge-app my-app --ref $FROM --no-install --yes"
run "cd my-app"
run "git add -A && git commit -qm 'Generated from Starter $FROM'"

mark "Make it your own"
note "Edited by hand: the product description, and a script of our own in package.json"
node -e '
  const fs = require("fs");
  const edit = (file, change) => {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    change(json);
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  };
  edit("apps/web/src/config/site.json", (s) => (s.description = "Bookings and memberships for climbing gyms."));
  edit("package.json", (p) => (p.scripts["verify"] = "pnpm lint && pnpm typecheck && pnpm test"));
'
run "git diff"
run "git commit -qam 'Our description and verify script'"

mark "Upgrade to the latest Starter"
run "pnpm clubedge upgrade --no-install --yes"
run "git diff --stat | tail -n 1"
note "Our script is still there, next to the Starter's own changes"
run "git diff package.json"
run "git add -A && git commit -qm 'Upgrade the Starter'"

mark "Add Stripe payments"
run "pnpm clubedge add payments stripe --no-install --yes"
run "git add -A && git commit -qm 'Add Stripe payments'"

mark "Remove file storage"
run "pnpm clubedge remove storage --no-install --yes"
run "git add -A && git commit -qm 'Remove file storage'"

mark "Check where the project stands"
run "pnpm clubedge status"
run "git log --oneline"
run "grep description apps/web/src/config/site.json"
sleep 2
