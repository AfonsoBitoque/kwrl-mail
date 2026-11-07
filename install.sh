#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Instalador Universal do Corvo (Auto-Deteção de Sistema Operativo)
# ==============================================================================

OS="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "          Instalador do Corvo             "
echo "=========================================="

case "${OS}" in
    Darwin)
        echo "Sistema detetado: macOS"
        exec "${SCRIPT_DIR}/scripts/install-mac.sh" "$@"
        ;;
    Linux)
        if command -v pacman &>/dev/null; then
            echo "Sistema detetado: Arch Linux / Derivado"
            exec "${SCRIPT_DIR}/scripts/install-arch.sh" "$@"
        else
            echo "Sistema detetado: Linux genérico"
            echo "A verificar dependências essenciais..."
            if command -v apt-get &>/dev/null; then
                sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev cmake
            elif command -v dnf &>/dev/null; then
                sudo dnf install -y webkit2gtk4.1-devel openssl-devel gtk3-devel cmake gcc gcc-c++
            fi
            echo "A compilar..."
            npm install
            npm run build
            cargo build --manifest-path src-tauri/Cargo.toml --release --bin corvo-llm-worker
            npx tauri build --no-bundle
            echo "Instalação concluída. Binários em: src-tauri/target/release/corvo-desktop"
        fi
        ;;
    CYGWIN*|MINGW*|MSYS*)
        echo "Ambiente Windows detetado via shell Unix."
        echo "Por favor execute o instalador PowerShell nativo:"
        echo "  powershell -ExecutionPolicy Bypass -File .\\scripts\\install-windows.ps1"
        exit 0
        ;;
    *)
        echo "Sistema operativo não suportado automaticamente: ${OS}"
        echo "Consulte o ficheiro INSTALL.md para instruções manuais."
        exit 1
        ;;
esac
