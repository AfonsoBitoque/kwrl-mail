#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Universal Installer for Kwrl Mail (OS Auto-Detection)
# ==============================================================================

OS="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "          Kwrl Mail Installer             "
echo "=========================================="

case "${OS}" in
    Darwin)
        echo "Detected OS: macOS"
        exec "${SCRIPT_DIR}/scripts/install-mac.sh" "$@"
        ;;
    Linux)
        if command -v pacman &>/dev/null; then
            echo "Detected OS: Arch Linux / Derivative"
            exec "${SCRIPT_DIR}/scripts/install-arch.sh" "$@"
        else
            echo "Detected OS: Generic Linux"
            echo "Checking essential system dependencies..."
            if command -v apt-get &>/dev/null; then
                sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev cmake
            elif command -v dnf &>/dev/null; then
                sudo dnf install -y webkit2gtk4.1-devel openssl-devel gtk3-devel cmake gcc gcc-c++
            fi
            echo "Building Kwrl Mail..."
            npm install
            npm run build
            cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
            npx tauri build --no-bundle
            echo "Build completed. Binary available at: src-tauri/target/release/kwrl"
        fi
        ;;
    CYGWIN*|MINGW*|MSYS*)
        echo "Windows environment detected via Unix shell."
        echo "Please run the native PowerShell installer:"
        echo "  powershell -ExecutionPolicy Bypass -File .\\scripts\\install-windows.ps1"
        exit 0
        ;;
    *)
        echo "Unsupported operating system: ${OS}"
        echo "Please refer to INSTALL.md for manual instructions."
        exit 1
        ;;
esac
