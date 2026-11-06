#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script de Instalação Automática do Corvo para macOS (Apple Silicon & Intel)
# ==============================================================================

echo "=========================================="
echo "  Instalador Automático do Corvo (macOS)"
echo "=========================================="

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Erro: Este script deve ser executado no macOS."
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

echo ""
echo "[1/4] A verificar ferramentas de desenvolvimento do macOS..."

if ! command -v xcode-select &>/dev/null || ! xcode-select -p &>/dev/null; then
    echo "A instalar Xcode Command Line Tools..."
    xcode-select --install || true
    echo "Por favor conclua a instalação do Xcode Command Line Tools e execute este script novamente."
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "Erro: Node.js não encontrado. Instale com 'brew install node' ou descarregue de https://nodejs.org"
    exit 1
fi

if ! command -v cargo &>/dev/null; then
    echo "Erro: Rust (cargo) não encontrado. Instale com: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

echo "Ferramentas detetadas: Node $(node -v), Cargo $(cargo -V)"

echo ""
echo "[2/4] A compilar o Frontend (Vite + React)..."
npm install
npm run build

echo ""
echo "[3/4] A compilar o Backend nativo (com aceleração Metal)..."
cargo build --manifest-path src-tauri/Cargo.toml --release

echo ""
echo "[4/4] A empacotar e instalar Corvo.app..."

BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/release/bundle/macos/Corvo.app"
mkdir -p "${BUNDLE_DIR}/Contents/MacOS"
mkdir -p "${BUNDLE_DIR}/Contents/Resources"

cp "${PROJECT_DIR}/src-tauri/target/release/corvo-desktop" "${BUNDLE_DIR}/Contents/MacOS/corvo-desktop"
cp "${PROJECT_DIR}/src-tauri/target/release/corvo-llm-worker" "${BUNDLE_DIR}/Contents/MacOS/corvo-llm-worker"

# Assegura existência de Info.plist
cat << 'EOF' > "${BUNDLE_DIR}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>pt-PT</string>
	<key>CFBundleDisplayName</key>
	<string>Corvo</string>
	<key>CFBundleExecutable</key>
	<string>corvo-desktop</string>
	<key>CFBundleIdentifier</key>
	<string>pt.corvo.mail</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Corvo</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.2.0</string>
	<key>CFBundleVersion</key>
	<string>0.2.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>CFBundleIconFile</key>
	<string>Corvo.icns</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
EOF

# Limpa atributos de quarentena do Gatekeeper e aplica assinatura ad-hoc
xattr -cr "${BUNDLE_DIR}"
codesign --force --deep --sign - "${BUNDLE_DIR}"

DEST_DIR="/Applications"
if [ ! -w "${DEST_DIR}" ]; then
    DEST_DIR="${HOME}/Applications"
    mkdir -p "${DEST_DIR}"
fi

echo "-> A instalar em ${DEST_DIR}/Corvo.app..."
rm -rf "${DEST_DIR}/Corvo.app"
cp -R "${BUNDLE_DIR}" "${DEST_DIR}/Corvo.app"
xattr -cr "${DEST_DIR}/Corvo.app"
codesign --force --deep --sign - "${DEST_DIR}/Corvo.app"

echo ""
echo "================================================================="
echo "  Instalação concluída com sucesso no macOS!"
echo "================================================================="
echo ""
echo "O Corvo está instalado em: ${DEST_DIR}/Corvo.app"
echo "A abrir a aplicação..."
open "${DEST_DIR}/Corvo.app"
echo ""
