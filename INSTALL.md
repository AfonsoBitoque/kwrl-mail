# Guia de Instalação Rápida — Corvo

Este documento detalha o processo de instalação fácil e automatizada do **Corvo** nos três principais sistemas operativos: **Arch Linux**, **macOS** e **Windows**.

---

## ⚡ Instalação Rápida Universal (Linux & Mac)

Se já clonou o repositório, execute o instalador universal que deteta automaticamente o seu sistema operativo e configura as dependências:

```bash
git clone https://github.com/AfonsoBitoque/yoot-mail.git
cd yoot-mail
./install.sh
```

---

## 🐧 1. Arch Linux (e derivados: Manjaro, EndeavourOS, CachyOS)

O Corvo dispõe de suporte nativo de primeira classe para Arch Linux.

### Opção A: Script de Instalação Automática (Recomendado)
Um único comando que valida as dependências via `pacman`, pergunta se pretende aceleração por GPU (CUDA/Vulkan) ou CPU, compila e adiciona o Corvo ao seu menu de aplicações:

```bash
./scripts/install-arch.sh
```

### Opção B: Via `PKGBUILD` (`makepkg`)
Se prefere que a instalação seja gerida como um pacote nativo do `pacman`:

```bash
cd packaging/arch
makepkg -si
```
Isto compilará e criará o pacote `.pkg.tar.zst`, instalando os binários em `/usr/bin/`, o ficheiro `.desktop` em `/usr/share/applications/` e os respetivos ícones.

### Dependências Manuais (se preferir compilar manualmente)
```bash
sudo pacman -S --needed base-devel cmake webkit2gtk-4.1 gtk3 glib2 openssl nodejs npm rust gnome-keyring
npm install && npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release
```

---

## 🍏 2. macOS (Apple Silicon M1/M2/M3/M4 & Intel)

No macOS, o Corvo utiliza a API Metal nativa para inferência gráfica ultra-rápida e o Apple Keychain para guardar credenciais OAuth.

### Opção A: Script de Instalação Automática (Recomendado)
Compila o frontend, compila o binário otimizado, monta o bundle `Corvo.app`, aplica a assinatura de segurança local e instala em `/Applications/Corvo.app`:

```bash
./scripts/install-mac.sh
```

### Opção B: Manual
```bash
npm install && npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release
npm run tauri:build
```
O executável `Corvo.app` ficará pronto em `/Applications` ou em `src-tauri/target/release/bundle/macos/Corvo.app`.

---

## 🪟 3. Windows (Windows 10 e Windows 11)

No Windows, o Corvo utiliza o **Microsoft Edge WebView2** (pré-instalado nativamente no Windows 10 e 11) e o **Windows Credential Manager** para guardar credenciais.

### Opção A: Script PowerShell Automático (Recomendado)
Abra o **PowerShell** na pasta do projeto e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

O script:
1. Valida se o Node.js e o Rust Toolchain (MSVC) estão instalados.
2. Pergunta se pretende ativar aceleração por GPU NVIDIA (CUDA) ou Vulkan.
3. Compila o cliente e o motor de IA isolado.
4. Instala a aplicação em `%LOCALAPPDATA%\Programs\Corvo`.
5. Cria atalhos no **Menu Iniciar** e no **Ambiente de Trabalho**.
6. Inicia o Corvo automaticamente.

### Opção B: Gerar Instalador Executável (.msi ou .exe)
Para criar um instalador distribuível padrão do Windows:
```powershell
npx @tauri-apps/cli build
```
O instalador NSIS ficará gerado em `src-tauri\target\release\bundle\nsis\`.

---

## 🚀 Aceleração de Hardware para o Motor de IA (Local GGUF)

O processo de inferência `corvo-llm-worker` adapta-se ao hardware disponível:

| Plataforma | Modo Padrão | Modo Acelerado por GPU |
| :--- | :--- | :--- |
| **macOS** | **Apple Metal** (Automático, zero configuração) | Totalmente acelerado pelo Neural Engine e GPU Metal |
| **Arch Linux** | **CPU Multi-thread** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |
| **Windows** | **CPU Multi-thread** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |

---

## 📂 Onde ficam guardados os dados e modelos?

A base de dados SQLite offline e os modelos locais GGUF respeitam as pastas padrão de cada sistema:

- **Linux (Arch):** `~/.local/share/pt.corvo.mail/`
  - Modelos IA: `~/.local/share/pt.corvo.mail/models/`
  - Base de dados: `~/.local/share/pt.corvo.mail/corvo_cache.sqlite3`
- **macOS:** `~/Library/Application Support/pt.corvo.mail/`
  - Modelos IA: `~/Library/Application Support/pt.corvo.mail/models/`
  - Base de dados: `~/Library/Application Support/pt.corvo.mail/corvo_cache.sqlite3`
- **Windows:** `%LOCALAPPDATA%\pt.corvo.mail\`
  - Modelos IA: `%LOCALAPPDATA%\pt.corvo.mail\models\`
  - Base de dados: `%LOCALAPPDATA%\pt.corvo.mail\corvo_cache.sqlite3`
