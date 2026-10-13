#!/usr/bin/env bash
# Runs a generated project's own checks one by one, each in a collapsible log group. When one
# fails, it is named in an annotation and in the job summary, so a red job says at a glance that
# the generated app failed (not the CLI steps before it) and which command.
#
# Usage, in the project: bash check-project.sh install format:check lint typecheck test build
set -uo pipefail

for check in "$@"; do
  case "$check" in
    install) command="pnpm install --frozen-lockfile" ;;
    *) command="pnpm $check" ;;
  esac
  echo "::group::$command"
  $command
  status=$?
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    message="The generated project failed \`$command\` (exit $status). The CLI steps before this one passed: this is the generated app's own check."
    echo "::error title=Generated project: $command failed::$message"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf '### ❌ Generated project: `%s` failed\n\n%s\n' "$command" "$message" >> "$GITHUB_STEP_SUMMARY"
    fi
    exit "$status"
  fi
done
