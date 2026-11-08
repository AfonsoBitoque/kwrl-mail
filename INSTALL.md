# Installation Guide — Kwrl Mail

This guide covers automated and manual installation of **Kwrl Mail** on **Arch Linux**, **Ubuntu / Debian / Fedora**, **macOS**, and **Windows**.

---

## ⚡ Quick One-Command Install (Linux & macOS)

Clone the repository and run the universal installer or platform-specific script:

```bash
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail

# Universal auto-detecting installer (macOS / Arch Linux / Ubuntu / Fedora):
./install.sh

# Or run your platform script directly:
./scripts/install-arch.sh   # Arch Linux & derivatives
./scripts/install-mac.sh    # macOS (Apple Silicon & Intel)
```

---

## 🐧 1. Arch Linux (and derivatives: Manjaro, EndeavourOS, CachyOS)

Kwrl Mail provides first-class native support for Arch Linux.

### Option A: Automated Install Script (Recommended)
Validates system dependencies via `pacman`, lets you choose between CPU (AVX2/AVX-512), NVIDIA CUDA, or Vulkan GPU acceleration, compiles the production bundle, and registers Kwrl in your application launcher:

```bash
./scripts/install-arch.sh
```

### Option B: Via `PKGBUILD` (`makepkg`)
If you prefer managing Kwrl as a native `pacman` package:

```bash
cd packaging/arch
makepkg -si
```
This builds the `.pkg.tar.zst` package and installs `/usr/bin/kwrl`, `/usr/bin/kwrl-llm-worker`, `/usr/share/applications/kwrl.desktop`, and application icons.

### Manual Dependencies (Arch Linux)
```bash
sudo pacman -S --needed base-devel cmake clang webkit2gtk-4.1 gtk3 glib2 openssl nodejs npm rust gnome-keyring
npm install && npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
npx tauri build --no-bundle
```

---

## 🍏 2. macOS (Apple Silicon M1/M2/M3/M4 & Intel)

On macOS, Kwrl uses Apple Metal for hardware-accelerated local LLM inference and the native macOS Keychain for OAuth token storage.

### Option A: Automated Install Script (Recommended)
Builds the frontend, compiles both native Rust binaries with embedded production assets, packages `Kwrl.app`, signs it locally, and installs it to `/Applications/Kwrl.app`:

```bash
./scripts/install-mac.sh
```

### Option B: Manual Build
```bash
npm install && npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
npx tauri build --no-bundle
```

---

## 🪟 3. Windows (Windows 10 & Windows 11)

On Windows, Kwrl uses **Microsoft Edge WebView2** (pre-installed on Windows 10/11) and **Windows Credential Manager** for secure OAuth storage.

### Option A: Automated PowerShell Installer (Recommended)
Open **PowerShell** in the repository folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The script:
1. Checks for Node.js and the Rust Toolchain (MSVC).
2. Prompts for CPU, NVIDIA CUDA, or Vulkan GPU acceleration.
3. Builds the desktop client and isolated `kwrl-llm-worker.exe` sidecar.
4. Installs to `%LOCALAPPDATA%\Programs\Kwrl` and creates Start Menu & Desktop shortcuts.

---

## 🚀 Hardware Acceleration for the Local AI Engine (`.gguf`)

The isolated `kwrl-llm-worker` process adapts to your hardware:

| Platform | Default Mode | Optional GPU Acceleration |
| :--- | :--- | :--- |
| **macOS** | **Apple Metal** (Automatic, zero config) | Full Apple Silicon GPU & Unified Memory acceleration |
| **Linux** | **Multi-thread CPU** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |
| **Windows** | **Multi-thread CPU** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |

---

## 📂 Local Data & Model Storage Paths

All offline SQLite databases and `.gguf` models are stored locally in your user directory:

- **Linux:** `~/.local/share/app.kwrl.mail/`
  - AI Models: `~/.local/share/app.kwrl.mail/models/`
  - Database: `~/.local/share/app.kwrl.mail/kwrl_cache.sqlite3`
- **macOS:** `~/Library/Application Support/app.kwrl.mail/`
  - AI Models: `~/Library/Application Support/app.kwrl.mail/models/`
  - Database: `~/Library/Application Support/app.kwrl.mail/kwrl_cache.sqlite3`
- **Windows:** `%LOCALAPPDATA%\app.kwrl.mail\`
  - AI Models: `%LOCALAPPDATA%\app.kwrl.mail\models\`
  - Database: `%LOCALAPPDATA%\app.kwrl.mail\kwrl_cache.sqlite3`
