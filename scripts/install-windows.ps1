# ==============================================================================
# Script de Instalação Automática do Kwrl para Windows 10 / 11 (PowerShell)
# ==============================================================================

[CmdletBinding()]
param (
    [switch]$BuildInstaller = $false
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Instalador Automático do Kwrl (Windows)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = (Resolve-Path "$ScriptDir\..").Path
Set-Location $ProjectDir

# [1/4] Verificar Ferramentas Necessárias
Write-Host "[1/4] A verificar ferramentas necessárias..." -ForegroundColor Yellow

$missingTools = @()

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $missingTools += "Node.js (https://nodejs.org ou 'winget install OpenJS.NodeJS')"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $missingTools += "Rust Toolchain (https://rustup.rs ou 'winget install Rustlang.Rustup')"
}

if ($missingTools.Count -gt 0) {
    Write-Host "Erro: As seguintes ferramentas obrigatórias estão em falta:" -ForegroundColor Red
    foreach ($tool in $missingTools) {
        Write-Host "  - $tool" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Por favor instale as ferramentas indicadas e execute o instalador novamente."
    Exit 1
}

Write-Host "Ferramentas detetadas com sucesso." -ForegroundColor Green

# [2/4] Escolha de aceleração de hardware para o motor de IA
Write-Host ""
Write-Host "[2/4] Escolha de aceleração de hardware para o motor de IA (llama.cpp):" -ForegroundColor Yellow
Write-Host "  1) CPU Multi-thread (Padrão: AVX2/AVX-512, compatível com qualquer CPU)"
Write-Host "  2) NVIDIA CUDA (requer GPU NVIDIA e CUDA Toolkit instalado)"
Write-Host "  3) Vulkan (GPU AMD Radeon, Intel Arc ou NVIDIA)"

$accel = Read-Host "Selecione uma opção [1-3, padrão=1]"
$cargoFeatures = ""

if ($accel -eq "2") {
    Write-Host "A ativar aceleração NVIDIA CUDA..." -ForegroundColor Cyan
    $cargoFeatures = "--features cuda"
} elseif ($accel -eq "3") {
    Write-Host "A ativar aceleração Vulkan..." -ForegroundColor Cyan
    $cargoFeatures = "--features vulkan"
} else {
    Write-Host "A compilar para CPU Multi-thread (otimizado)..." -ForegroundColor Cyan
}

# [3/4] Compilação do Frontend e Backend
Write-Host ""
Write-Host "[3/4] A compilar a aplicação..." -ForegroundColor Yellow

Write-Host "-> A instalar dependências Node e compilar Frontend (Vite)..." -ForegroundColor Gray
npm install
npm run build

Write-Host "-> A compilar binários nativos Rust de produção (com assets embutidos)..." -ForegroundColor Gray
if ($cargoFeatures) {
    cargo build --manifest-path src-tauri\Cargo.toml --release --bin kwrl-llm-worker $cargoFeatures
    npx tauri build --no-bundle $cargoFeatures
} else {
    cargo build --manifest-path src-tauri\Cargo.toml --release --bin kwrl-llm-worker
    npx tauri build --no-bundle
}

# [4/4] Instalação no Sistema
Write-Host ""
Write-Host "[4/4] A instalar o Kwrl..." -ForegroundColor Yellow

$InstallDir = "$env:LOCALAPPDATA\Programs\Kwrl"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$desktopExe = "$ProjectDir\src-tauri\target\release\kwrl.exe"
$workerExe = "$ProjectDir\src-tauri\target\release\kwrl-llm-worker.exe"

Copy-Item $desktopExe -Destination "$InstallDir\kwrl.exe" -Force
Copy-Item $workerExe -Destination "$InstallDir\kwrl-llm-worker.exe" -Force
Copy-Item "$ProjectDir\src-tauri\icons\icon.png" -Destination "$InstallDir\kwrl.png" -Force

# Criar atalho no Menu Iniciar
$startMenuDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$shortcutPath = "$startMenuDir\Kwrl.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "$InstallDir\kwrl.exe"
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.IconLocation = "$InstallDir\kwrl.exe,0"
$Shortcut.Description = "Cliente de e-mail calmo e seguro com IA local"
$Shortcut.Save()

# Criar atalho no Desktop (Área de Trabalho)
$desktopShortcutPath = "$([Environment]::GetFolderPath('Desktop'))\Kwrl.lnk"
$DesktopShortcut = $WshShell.CreateShortcut($desktopShortcutPath)
$DesktopShortcut.TargetPath = "$InstallDir\kwrl.exe"
$DesktopShortcut.WorkingDirectory = $InstallDir
$DesktopShortcut.IconLocation = "$InstallDir\kwrl.exe,0"
$DesktopShortcut.Description = "Cliente de e-mail calmo e seguro com IA local"
$DesktopShortcut.Save()

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Green
Write-Host "  Instalação concluída com sucesso no Windows!" -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Instalado em: $InstallDir"
Write-Host "Atalhos criados no Menu Iniciar e no Ambiente de Trabalho."
Write-Host ""

$launch = Read-Host "Deseja iniciar o Kwrl agora? (S/n)"
if ($launch -ne "n" -and $launch -ne "N") {
    Start-Process "$InstallDir\kwrl.exe"
}
