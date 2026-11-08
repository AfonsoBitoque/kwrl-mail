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

INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"

uninstall_kwrl() {
    local WIPE_MODE="${1:-ask}"
    echo ""
    echo "-> A encerrar processos ativos do Kwrl..."
    pkill -f kwrl-llm-worker 2>/dev/null || true
    pkill -f corvo-llm-worker 2>/dev/null || true
    pkill -x kwrl 2>/dev/null || true
    pkill -x corvo-desktop 2>/dev/null || true

    echo "-> A remover binários e atalhos do sistema..."
    sudo rm -f "${INSTALL_PREFIX}/bin/kwrl" \
               "${INSTALL_PREFIX}/bin/kwrl-llm-worker" \
               "${INSTALL_PREFIX}/bin/corvo-desktop" \
               "${INSTALL_PREFIX}/bin/corvo-llm-worker" \
               "${INSTALL_PREFIX}/share/applications/kwrl.desktop" \
               "${INSTALL_PREFIX}/share/applications/corvo.desktop" \
               "${INSTALL_PREFIX}/share/icons/hicolor/32x32/apps/kwrl.png" \
               "${INSTALL_PREFIX}/share/icons/hicolor/32x32/apps/corvo.png" \
               "${INSTALL_PREFIX}/share/icons/hicolor/128x128/apps/kwrl.png" \
               "${INSTALL_PREFIX}/share/icons/hicolor/128x128/apps/corvo.png" \
               "${INSTALL_PREFIX}/share/pixmaps/kwrl.png" \
               "${INSTALL_PREFIX}/share/pixmaps/corvo.png"

    if pacman -Qi kwrl-desktop &>/dev/null; then
        sudo pacman -Rns --noconfirm kwrl-desktop || true
    fi
    if pacman -Qi corvo-desktop &>/dev/null; then
        sudo pacman -Rns --noconfirm corvo-desktop || true
    fi

    if command -v update-desktop-database &>/dev/null; then
        sudo update-desktop-database "${INSTALL_PREFIX}/share/applications" 2>/dev/null || true
    fi

    if [ "${WIPE_MODE}" = "ask" ]; then
        echo ""
        echo "Como pretende tratar os dados locais do utilizador?"
        echo "  1) Limpar contas, cache e configurações, mas MANTER o modelo IA (.gguf) [Recomendado para testar do 0]"
        echo "  2) Apagar TUDO (incluindo o modelo IA de ~2 GB)"
        echo "  3) Manter todos os dados locais intactos"
        read -rp "Selecione uma opção [1-3, padrão=1]: " DATA_CHOICE
        case "${DATA_CHOICE}" in
            2) WIPE_MODE="all" ;;
            3) WIPE_MODE="keep" ;;
            *) WIPE_MODE="db_only" ;;
        esac
    fi

    if [ "${WIPE_MODE}" = "db_only" ]; then
        echo "-> A limpar base de dados SQLite, cache WebKit e configurações (mantendo modelos .gguf)..."
        rm -f "${HOME}/.local/share/app.kwrl.mail/kwrl_cache.sqlite3"*
        rm -rf "${HOME}/.local/share/pt.corvo.mail" "${HOME}/.local/share/yoot-mail"
        rm -rf "${HOME}/.cache/app.kwrl.mail" "${HOME}/.config/app.kwrl.mail"
        rm -rf "${HOME}/.cache/pt.corvo.mail" "${HOME}/.config/pt.corvo.mail"
    elif [ "${WIPE_MODE}" = "all" ]; then
        echo "-> A apagar todos os dados locais e modelos IA..."
        rm -rf "${HOME}/.local/share/app.kwrl.mail" "${HOME}/.local/share/pt.corvo.mail" "${HOME}/.local/share/yoot-mail"
        rm -rf "${HOME}/.cache/app.kwrl.mail" "${HOME}/.config/app.kwrl.mail"
        rm -rf "${HOME}/.cache/pt.corvo.mail" "${HOME}/.config/pt.corvo.mail"
    else
        echo "-> Dados locais preservados."
    fi
}

if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ] || [ "${1:-}" = "-u" ]; then
    uninstall_kwrl "ask"
    echo ""
    echo "================================================================="
    echo "  Kwrl desinstalado com sucesso!"
    echo "================================================================="
    exit 0
fi

if [ "${1:-}" = "--clean" ] || [ "${1:-}" = "--reinstall" ]; then
    uninstall_kwrl "db_only"
elif [ -f "${INSTALL_PREFIX}/bin/kwrl" ] || [ -f "${INSTALL_PREFIX}/bin/corvo-desktop" ]; then
    echo ""
    echo "Foi detetada uma instalação anterior do Kwrl neste sistema."
    echo "O que pretende fazer?"
    echo "  1) Reinstalar do zero (limpar contas/base de dados, mas manter modelo IA .gguf)"
    echo "  2) Atualizar mantendo contas e dados atuais"
    echo "  3) Reinstalar apagando tudo (incluindo modelo IA .gguf)"
    echo "  4) Apenas desinstalar e sair"
    read -rp "Selecione uma opção [1-4, padrão=1]: " EXISTING_CHOICE
    case "${EXISTING_CHOICE}" in
        2)
            echo "-> A atualizar mantendo os dados atuais..."
            ;;
        3)
            uninstall_kwrl "all"
            ;;
        4)
            uninstall_kwrl "ask"
            echo ""
            echo "================================================================="
            echo "  Kwrl desinstalado com sucesso!"
            echo "================================================================="
            exit 0
            ;;
        *)
            uninstall_kwrl "db_only"
            ;;
    esac
fi

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
sudo rm -f "${INSTALL_PREFIX}/share/applications/corvo.desktop"

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
