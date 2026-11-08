#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script de Instalação Automática do Kwrl para Arch Linux / derivados (Manjaro, EndeavourOS)
# ==============================================================================

echo "=========================================="
echo "  Instalador Automático do Kwrl (Arch Linux)"
echo "=========================================="

if ! command -v pacman &>/dev/null; then
    echo "Erro: Este script foi concebido para distribuições baseadas em Arch Linux (com pacman)."
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

echo ""
echo "[1/4] A verificar e instalar dependências do sistema via pacman..."

DEPS=(
    base-devel
    cmake
    clang
    webkit2gtk-4.1
    gtk3
    glib2
    openssl
    nodejs
    npm
    rust
    gnome-keyring
)

MISSING_DEPS=()
for dep in "${DEPS[@]}"; do
    if ! pacman -Qi "${dep}" &>/dev/null; then
        MISSING_DEPS+=("${dep}")
    fi
done

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo "A instalar pacotes em falta: ${MISSING_DEPS[*]}"
    sudo pacman -S --needed "${MISSING_DEPS[@]}"
else
    echo "Todas as dependências do sistema já estão instaladas."
fi

# Se o utilizador utilizar rustup, garante que o toolchain está atualizado (requerido >= 1.90 pelas crates do Tauri)
if command -v rustup &>/dev/null; then
    echo "A atualizar Rust via rustup (Tauri v2 requer Rust >= 1.90)..."
    rustup update stable || true
    rustup default stable || true
fi

echo ""
echo "[2/4] Escolha de aceleração de hardware para o motor de IA (llama.cpp):"
echo "  1) CPU Multi-thread (Padrão: AVX2/AVX-512, compatível com todos os processadores)"
echo "  2) NVIDIA CUDA (requer GPU NVIDIA e pacote 'cuda')"
echo "  3) Vulkan (GPU AMD Radeon, Intel Arc ou NVIDIA)"
read -rp "Selecione uma opção [1-3, padrão=1]: " ACCEL_CHOICE

CARGO_FLAGS=""
case "${ACCEL_CHOICE}" in
    2)
        echo "A ativar aceleração NVIDIA CUDA..."
        if ! pacman -Qi cuda &>/dev/null; then
            echo "A instalar pacote 'cuda'..."
            sudo pacman -S --needed cuda
        fi
        CARGO_FLAGS="--features cuda"
        ;;
    3)
        echo "A ativar aceleração Vulkan..."
        if ! pacman -Qi vulkan-headers &>/dev/null || ! pacman -Qi vulkan-icd-loader &>/dev/null; then
            echo "A instalar cabeçalhos Vulkan..."
            sudo pacman -S --needed vulkan-headers vulkan-icd-loader
        fi
        CARGO_FLAGS="--features vulkan"
        ;;
    *)
        echo "A compilar para CPU Multi-thread (otimizado para o seu processador)..."
        ;;
esac

echo ""
echo "[3/4] A compilar a aplicação..."

echo "-> A instalar dependências Node e compilar Frontend (Vite)..."
npm install
npm run build

echo "-> A compilar motor de IA isolado (kwrl-llm-worker)..."
# shellcheck disable=SC2086
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker ${CARGO_FLAGS}

echo "-> A compilar o Kwrl com assets de produção embutidos (Tauri)..."
if [ -n "${CARGO_FLAGS}" ]; then
    # shellcheck disable=SC2086
    npx tauri build --no-bundle ${CARGO_FLAGS}
else
    npx tauri build --no-bundle
fi

echo ""
echo "[4/4] A instalar ficheiros no sistema..."

INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"

echo "-> A copiar binários para ${INSTALL_PREFIX}/bin..."
sudo install -d "${INSTALL_PREFIX}/bin"
sudo install -m 755 src-tauri/target/release/kwrl "${INSTALL_PREFIX}/bin/kwrl"
sudo install -m 755 src-tauri/target/release/kwrl-llm-worker "${INSTALL_PREFIX}/bin/kwrl-llm-worker"

# Symlinks de compatibilidade para quem usava corvo-desktop
sudo ln -sf "${INSTALL_PREFIX}/bin/kwrl" "${INSTALL_PREFIX}/bin/corvo-desktop"
sudo ln -sf "${INSTALL_PREFIX}/bin/kwrl-llm-worker" "${INSTALL_PREFIX}/bin/corvo-llm-worker"

echo "-> A instalar atalho no ambiente de trabalho (.desktop)..."
sudo install -d "${INSTALL_PREFIX}/share/applications"
sudo install -m 644 packaging/linux/kwrl.desktop "${INSTALL_PREFIX}/share/applications/kwrl.desktop"
sudo install -m 644 packaging/linux/corvo.desktop "${INSTALL_PREFIX}/share/applications/corvo.desktop"

echo "-> A instalar ícones da aplicação..."
sudo install -d "${INSTALL_PREFIX}/share/icons/hicolor/32x32/apps"
sudo install -m 644 src-tauri/icons/32x32.png "${INSTALL_PREFIX}/share/icons/hicolor/32x32/apps/kwrl.png"
sudo ln -sf kwrl.png "${INSTALL_PREFIX}/share/icons/hicolor/32x32/apps/corvo.png"

sudo install -d "${INSTALL_PREFIX}/share/icons/hicolor/128x128/apps"
sudo install -m 644 src-tauri/icons/128x128.png "${INSTALL_PREFIX}/share/icons/hicolor/128x128/apps/kwrl.png"
sudo ln -sf kwrl.png "${INSTALL_PREFIX}/share/icons/hicolor/128x128/apps/corvo.png"

sudo install -d "${INSTALL_PREFIX}/share/pixmaps"
sudo install -m 644 src-tauri/icons/icon.png "${INSTALL_PREFIX}/share/pixmaps/kwrl.png"
sudo ln -sf kwrl.png "${INSTALL_PREFIX}/share/pixmaps/corvo.png"

if command -v update-desktop-database &>/dev/null; then
    sudo update-desktop-database "${INSTALL_PREFIX}/share/applications" || true
fi

echo ""
echo "================================================================="
echo "  Instalação concluída com sucesso no Arch Linux!"
echo "================================================================="
echo ""
echo "Pode agora abrir o Kwrl de duas formas:"
echo "  1. No menu de aplicações do seu ambiente de trabalho (pesquisar por 'Kwrl')"
echo "  2. Pelo terminal com o comando: kwrl"
echo ""
