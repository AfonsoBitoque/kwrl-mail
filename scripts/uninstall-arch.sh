#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script de Desinstalação Completa do Kwrl / Corvo (Arch Linux)
# ==============================================================================

echo "================================================="
echo "  Desinstalador do Kwrl / Corvo (Arch Linux)"
echo "================================================="
echo ""

INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"

# 0. Terminar processos em execução
echo "A terminar processos em execução..."
pkill -f kwrl 2>/dev/null || true
pkill -f corvo 2>/dev/null || true

# 1. Se foi instalado como pacote pacman, remove via pacman
if pacman -Qi kwrl-desktop &>/dev/null; then
    echo "A remover pacote pacman 'kwrl-desktop'..."
    sudo pacman -R --noconfirm kwrl-desktop || true
fi
if pacman -Qi corvo-desktop &>/dev/null; then
    echo "A remover pacote pacman 'corvo-desktop'..."
    sudo pacman -R --noconfirm corvo-desktop || true
fi

# 2. Remover binários instalados manualmente em /usr/local/bin ou /usr/bin
echo "A remover binários do sistema..."
for bin in kwrl kwrl-llm-worker corvo-desktop corvo-llm-worker; do
    sudo rm -f "/usr/local/bin/${bin}"
    sudo rm -f "/usr/bin/${bin}"
done

# 3. Remover entradas .desktop
echo "A remover atalhos do ambiente de trabalho..."
for dt in kwrl.desktop corvo.desktop; do
    sudo rm -f "/usr/local/share/applications/${dt}"
    sudo rm -f "/usr/share/applications/${dt}"
done

# 4. Remover ícones
echo "A remover ícones..."
for name in kwrl corvo; do
    sudo rm -f "/usr/local/share/icons/hicolor/32x32/apps/${name}.png"
    sudo rm -f "/usr/local/share/icons/hicolor/128x128/apps/${name}.png"
    sudo rm -f "/usr/local/share/pixmaps/${name}.png"
    sudo rm -f "/usr/share/icons/hicolor/32x32/apps/${name}.png"
    sudo rm -f "/usr/share/icons/hicolor/128x128/apps/${name}.png"
    sudo rm -f "/usr/share/pixmaps/${name}.png"
done

if command -v update-desktop-database &>/dev/null; then
    sudo update-desktop-database "/usr/local/share/applications" 2>/dev/null || true
    sudo update-desktop-database "/usr/share/applications" 2>/dev/null || true
fi

echo ""
echo "Ficheiros de sistema removidos com sucesso!"
echo ""

# 5. Limpeza de dados do utilizador (Cache SQLite, Configurações e Modelos)
DATA_DIRS=(
    "${HOME}/.local/share/app.kwrl.mail"
    "${HOME}/.local/share/pt.corvo.mail"
    "${HOME}/.local/share/yoot-mail"
)

echo "Deseja também apagar todos os dados locais do utilizador (base de dados SQLite e sessão)? [s/N]"
read -rp "Selecione uma opção: " PURGE_DATA

if [[ "${PURGE_DATA}" =~ ^[sSyY]$ ]]; then
    rm -rf "${HOME}/.cache/app.kwrl.mail" "${HOME}/.config/app.kwrl.mail" 2>/dev/null || true
    echo "Deseja preservar o ficheiro de modelo de IA (2.1 GB) para evitar descarregar novamente? [S/n]"
    read -rp "Selecione uma opção: " KEEP_MODELS

    for dir in "${DATA_DIRS[@]}"; do
        if [ -d "${dir}" ]; then
            if [[ ! "${KEEP_MODELS}" =~ ^[nN]$ ]] && [ -d "${dir}/models" ]; then
                echo "A preservar modelos em /tmp/kwrl_models_backup..."
                mkdir -p /tmp/kwrl_models_backup
                cp -r "${dir}/models/"* /tmp/kwrl_models_backup/ 2>/dev/null || true
                rm -rf "${dir}"
                mkdir -p "${HOME}/.local/share/app.kwrl.mail/models"
                mv /tmp/kwrl_models_backup/* "${HOME}/.local/share/app.kwrl.mail/models/" 2>/dev/null || true
                rm -rf /tmp/kwrl_models_backup
                echo "Base de dados e cache apagados (modelos preservados em ~/.local/share/app.kwrl.mail/models)."
            else
                rm -rf "${dir}"
                echo "Pasta '${dir}' apagada na totalidade."
            fi
        fi
    done
fi

echo ""
echo "================================================="
echo "  Desinstalação concluída!"
echo "================================================="
