#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Universal Uninstaller for Kwrl Mail
# ==============================================================================

OS="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${OS}" in
    Linux)
        exec "${SCRIPT_DIR}/scripts/install-arch.sh" --uninstall "$@"
        ;;
    Darwin)
        echo "Removing Kwrl.app on macOS..."
        pkill -f kwrl-llm-worker 2>/dev/null || true
        pkill -x kwrl 2>/dev/null || true
        rm -rf "/Applications/Kwrl.app" "${HOME}/Applications/Kwrl.app"
        echo "Kwrl.app removed."
        ;;
    *)
        echo "Please run ./scripts/install-arch.sh --uninstall"
        exit 1
        ;;
esac
