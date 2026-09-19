#!/usr/bin/env bash
set -euo pipefail

LABEL='com.mai.review-tmp-janitor'
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LAUNCHCTL="${MAI_REVIEW_LAUNCHCTL:-launchctl}"
PLUTIL="${MAI_REVIEW_PLUTIL:-plutil}"

die() {
  echo "install-janitor: $*" >&2
  exit 1
}

[ "${MAI_REVIEW_PLATFORM:-$(uname -s)}" = 'Darwin' ] ||
  die 'the LaunchAgent backstop is available on macOS only; on Windows run: powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-maintenance.ps1 -Job ReviewCleanup -Action Install'

# launchd execve()s ProgramArguments with no shell and no PATH search, so the
# staged plist carries absolute paths rendered here, never committed.
HELPER="$SCRIPT_DIR/review-scratch.mjs"
resolve_node() {
  local node
  node="$(command -v node || true)"
  [ -n "$node" ] || die 'node is not on PATH; install Node 24 before installing the janitor'
  case "$node" in
    /*) ;;
    *) die "node resolved to a non-absolute path: $node" ;;
  esac
  [ -x "$node" ] || die "node is not executable: $node"
  printf '%s\n' "$node"
}

install_agent() {
  local node argv_json
  node="$(resolve_node)"
  [ -f "$HELPER" ] || die "the canonical helper is missing beside this installer: $HELPER"
  mkdir -p "$AGENTS_DIR"
  [ ! -L "$AGENTS_DIR" ] || die "refusing symlinked LaunchAgents directory: $AGENTS_DIR"

  local staged previous='' had_previous=0 was_loaded=0 failure=0 rollback_failure=0
  local print_output print_status
  staged="$(mktemp "$AGENTS_DIR/.$LABEL.candidate.XXXXXX")"
  cp "$SCRIPT_DIR/com.mai.review-tmp-janitor.plist" "$staged"
  chmod 600 "$staged"
  # Render the template argv as JSON so plutil owns every byte of XML escaping.
  argv_json="$("$node" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$node" "$HELPER" prune --days 7)"
  "$PLUTIL" -replace ProgramArguments -json "$argv_json" "$staged"
  "$PLUTIL" -lint "$staged" >/dev/null

  if [ -e "$INSTALLED_PLIST" ]; then
    [ ! -L "$INSTALLED_PLIST" ] || die "refusing symlinked installed plist: $INSTALLED_PLIST"
    previous="$(mktemp "$AGENTS_DIR/.$LABEL.previous.XXXXXX")"
    cp -p "$INSTALLED_PLIST" "$previous"
    had_previous=1
  fi
  set +e
  print_output="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>&1)"
  print_status=$?
  set -e
  if [ "$print_status" -eq 0 ]; then
    was_loaded=1
  elif [ "$print_status" -eq 113 ] && printf '%s\n' "$print_output" | grep -Fq 'Could not find service'; then
    was_loaded=0
  else
    rm -f -- "$staged" "$previous"
    die "could not determine whether the prior janitor is loaded (status $print_status): $print_output"
  fi
  if [ "$was_loaded" -eq 1 ] && [ "$had_previous" -eq 0 ]; then
    rm -f -- "$staged" "$previous"
    die 'janitor is loaded but its installed plist is missing; refusing an update that cannot roll back'
  fi

  if [ "$was_loaded" -eq 1 ]; then
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || {
      rm -f -- "$staged" "$previous"
      die 'could not unload the existing janitor; prior installation left intact'
    }
  fi

  mv -f -- "$staged" "$INSTALLED_PLIST"
  set +e
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$INSTALLED_PLIST"
  failure=$?
  if [ "$failure" -eq 0 ]; then
    "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
    failure=$?
  fi
  set -e

  if [ "$failure" -ne 0 ]; then
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    if [ "$had_previous" -eq 1 ]; then
      mv -f -- "$previous" "$INSTALLED_PLIST"
    else
      rm -f -- "$INSTALLED_PLIST"
    fi
    if [ "$was_loaded" -eq 1 ] && [ "$had_previous" -eq 1 ]; then
      set +e
      "$LAUNCHCTL" bootstrap "$DOMAIN" "$INSTALLED_PLIST"
      rollback_failure=$?
      if [ "$rollback_failure" -eq 0 ]; then
        "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
        rollback_failure=$?
      fi
      set -e
    fi
    rm -f -- "$staged" "$previous"
    if [ "$rollback_failure" -ne 0 ]; then
      die "new janitor failed (status $failure) and prior job reload failed (status $rollback_failure)"
    fi
    die "new janitor failed to load (status $failure); prior installation restored"
  fi

  rm -f -- "$previous"
  echo "installed: $INSTALLED_PLIST"
}

case "${1:-install}" in
  install)
    install_agent
    ;;
  status)
    "$LAUNCHCTL" print "$DOMAIN/$LABEL"
    ;;
  uninstall)
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    [ ! -L "$INSTALLED_PLIST" ] || die "refusing symlinked installed plist: $INSTALLED_PLIST"
    rm -f -- "$INSTALLED_PLIST"
    echo "uninstalled: $LABEL"
    ;;
  *) die 'usage: install-janitor.sh [install|status|uninstall]' ;;
esac
