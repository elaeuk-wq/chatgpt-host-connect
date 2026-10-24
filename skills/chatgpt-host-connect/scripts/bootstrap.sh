#!/usr/bin/env bash
# Sourced by the local/SSH adapter, or host.py. No action merely by sourcing.
# Dependency installers must never consume the private request on stdin.
setup_fail() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}
find_brew() {
  HOST_SETUP_BREW=$(command -v brew || true)
  if [ -z "$HOST_SETUP_BREW" ]; then
    for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$p" ]; then HOST_SETUP_BREW=$p; break; fi
    done
  fi
}
ensure_brew() {
  find_brew
  if [ -z "$HOST_SETUP_BREW" ]; then
    [ "$(id -u)" != 0 ] || setup_fail 'Run setup as the intended login user, not root'
    # Homebrew on a fresh Mac needs admin rights. Never solicit a password over SSH/stdin.
    sudo -n -v </dev/null >/dev/null 2>&1 || setup_fail 'Homebrew is missing; its first installation needs macOS administrator approval. Complete the official installer from https://brew.sh in a target terminal, then resume.'
    command -v curl >/dev/null || setup_fail 'curl is required to fetch the official Homebrew installer'
    installer=$(curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --max-time 60 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh </dev/null) || setup_fail 'Could not fetch the official Homebrew installer; check target network'
    NONINTERACTIVE=1 /bin/bash -c "$installer" </dev/null >&2 || setup_fail 'Official Homebrew installation failed; inspect target prerequisites and permissions before resuming'
    unset installer
    find_brew
  fi
  [ -n "$HOST_SETUP_BREW" ] || setup_fail 'Homebrew installation did not provide brew'
}
find_python() {
  HOST_SETUP_PYTHON=''
  for p in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /opt/homebrew/opt/python@3.13/bin/python3.13 /usr/local/opt/python@3.13/bin/python3.13; do
    [ -n "$p" ] && [ -x "$p" ] || continue
    # Avoid invoking the macOS developer-tools stub on a pristine system.
    if [ "$p" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ]; then
      xcode-select -p >/dev/null 2>&1 || continue
    fi
    if "$p" -c 'import sys; sys.exit(sys.version_info < (3, 9))' </dev/null >/dev/null 2>&1; then
      HOST_SETUP_PYTHON=$p; return
    fi
  done
}
prepare_python() {
  find_python
  [ -z "$HOST_SETUP_PYTHON" ] || return 0
  [ "$(id -u)" != 0 ] || setup_fail 'Run setup as the intended login user, not root'
  case "$(uname -s)" in
    Darwin)
      ensure_brew
      HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$HOST_SETUP_BREW" install python@3.13 </dev/null >&2 || setup_fail 'Homebrew Python installation failed; check target network and permissions'
      prefix=$("$HOST_SETUP_BREW" --prefix python@3.13 </dev/null) || setup_fail 'Cannot locate installed Python'
      HOST_SETUP_PYTHON="$prefix/bin/python3.13"
      ;;
    Linux)
      sudo -n true </dev/null >/dev/null 2>&1 || setup_fail 'Python 3.9+ is missing; installing system packages needs target administrator approval'
      if command -v apt-get >/dev/null; then
        sudo -n apt-get update </dev/null >&2 && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 ca-certificates </dev/null >&2 || setup_fail 'apt Python installation failed; inspect target package manager before resuming'
      elif command -v dnf >/dev/null; then
        sudo -n dnf install -y python3 ca-certificates </dev/null >&2 || setup_fail 'dnf Python installation failed; inspect target package manager before resuming'
      else
        setup_fail 'Install Python 3.9+ using this Linux distribution package manager, then resume'
      fi
      find_python
      ;;
    *) setup_fail 'Supported targets are macOS or Linux; native Windows requires explicitly selected WSL2' ;;
  esac
  [ -n "$HOST_SETUP_PYTHON" ] && "$HOST_SETUP_PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 9))' </dev/null >/dev/null 2>&1 || setup_fail 'Target still lacks a usable Python 3.9+ interpreter'
}
