#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script de Instalação Automática do Kwrl para macOS (Apple Silicon & Intel)
# ==============================================================================

echo "=========================================="
echo "  Instalador Automático do Kwrl (macOS)"
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
echo "[3/4] A compilar o Backend nativo (com aceleração Metal e assets de produção embutidos)..."
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
npx tauri build --no-bundle

echo ""
echo "[4/4] A empacotar e instalar Kwrl.app..."

BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/release/bundle/macos/Kwrl.app"
mkdir -p "${BUNDLE_DIR}/Contents/MacOS"
mkdir -p "${BUNDLE_DIR}/Contents/Resources"

cp "${PROJECT_DIR}/src-tauri/target/release/kwrl" "${BUNDLE_DIR}/Contents/MacOS/kwrl"
cp "${PROJECT_DIR}/src-tauri/target/release/kwrl-llm-worker" "${BUNDLE_DIR}/Contents/MacOS/kwrl-llm-worker"

# Assegura existência de Info.plist
cat << 'EOF' > "${BUNDLE_DIR}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Kwrl</string>
	<key>CFBundleExecutable</key>
	<string>kwrl</string>
	<key>CFBundleIdentifier</key>
	<string>app.kwrl.mail</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Kwrl</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.2.0</string>
	<key>CFBundleVersion</key>
	<string>0.2.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
EOF

if [ -f "${PROJECT_DIR}/src-tauri/icons/icon.icns" ]; then
    cp "${PROJECT_DIR}/src-tauri/icons/icon.icns" "${BUNDLE_DIR}/Contents/Resources/icon.icns"
fi

# Limpa atributos de quarentena do Gatekeeper e aplica assinatura ad-hoc
xattr -cr "${BUNDLE_DIR}"
codesign --force --deep --sign - "${BUNDLE_DIR}"

DEST_DIR="/Applications"
if [ ! -w "${DEST_DIR}" ]; then
    DEST_DIR="${HOME}/Applications"
    mkdir -p "${DEST_DIR}"
fi

echo "-> A instalar em ${DEST_DIR}/Kwrl.app..."
rm -rf "${DEST_DIR}/Kwrl.app"
cp -R "${BUNDLE_DIR}" "${DEST_DIR}/Kwrl.app"
xattr -cr "${DEST_DIR}/Kwrl.app"
codesign --force --deep --sign - "${DEST_DIR}/Kwrl.app"

echo ""
echo "================================================================="
echo "  Instalação concluída com sucesso no macOS!"
echo "================================================================="
echo ""
echo "O Kwrl está instalado em: ${DEST_DIR}/Kwrl.app"
echo "A abrir a aplicação..."
open "${DEST_DIR}/Kwrl.app"
echo ""
