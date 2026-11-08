#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Universal Uninstaller for Kwrl Mail (Auto-Detecting OS)
# ==============================================================================

OS="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "          Kwrl Mail Uninstaller           "
echo "=========================================="

case "${OS}" in
    Linux)
        if command -v pacman &>/dev/null; then
            exec "${SCRIPT_DIR}/scripts/uninstall-arch.sh" "$@"
        else
            echo "A remover binários e atalhos instalados..."
            pkill -f kwrl 2>/dev/null || true
            pkill -f corvo 2>/dev/null || true
            sudo rm -f /usr/local/bin/kwrl /usr/local/bin/kwrl-llm-worker \
                       /usr/bin/kwrl /usr/bin/kwrl-llm-worker \
                       /usr/local/share/applications/kwrl.desktop \
                       /usr/share/applications/kwrl.desktop
            echo "Desinstalação concluída."
        fi
        ;;
    Darwin)
        echo "A desinstalar Kwrl do macOS..."
        pkill -f Kwrl 2>/dev/null || true
        pkill -f kwrl 2>/dev/null || true
        rm -rf /Applications/Kwrl.app "${HOME}/Applications/Kwrl.app"
        echo "Kwrl.app removido com sucesso."
        ;;
    CYGWIN*|MINGW*|MSYS*)
        echo "Ambiente Windows detetado via shell Unix."
        echo "Para desinstalar no Windows, remova a pasta:"
        echo "  %LOCALAPPDATA%\\Programs\\Kwrl"
        exit 0
        ;;
    *)
        echo "Sistema operativo não suportado automaticamente: ${OS}"
        exit 1
        ;;
esac
