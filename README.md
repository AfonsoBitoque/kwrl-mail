# Kwrl Mail — Calm, Sovereign Desktop Email Client with Local AI (`llama.cpp`)

🌐 **[English](README.md)** | **[Português](README.pt.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri)](https://v2.tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.90%2B-orange?logo=rust)](https://www.rust-lang.org/)
[![Local AI](https://img.shields.io/badge/AI-100%25%20Local%20llama.cpp-purple)](#4-local-gguf-ai-engine-llamacpp)

**Kwrl Mail** is a native desktop email client (**Tauri v2 + Rust + React**) built around calm editorial typography, strict data sovereignty, least-privilege **OAuth 2.0 PKCE**, and a 100% offline **local AI writing & summarization engine** powered by `llama.cpp` in an isolated sidecar process.

Zero telemetry, zero cloud middlemen, zero tracking pixels: all synchronization happens directly between your machine and the **Gmail API**, with local persistence in **SQLite WAL + FTS5**, credentials secured in the native **OS Keychain**, and hardware-accelerated local inference (**Apple Metal, NVIDIA CUDA, Vulkan, or AVX2 CPU**).

---

## ✨ Key Highlights

- **100% Local & Offline AI (`llama.cpp` Sidecar)**: Summarize threads, draft replies (One-sentence, Short draft, Structured), polish tone, fix grammar, or translate emails locally using quantized `.gguf` models (`Qwen 2.5 3B`, `Phi-4 Mini`, etc.). The main Tauri process never loads C++ tensors in its own memory space; `kwrl-llm-worker` runs with `env_clear()` and unloads automatically after 10 minutes of idle time.
- **Hardened Against OWASP LLM Top 10**: Untrusted email bodies are inspected for prompt injection (`prompt_guard.rs`), wrapped in strict structural CDLR delimiters (`<EMAIL_BODY>`), stripped of control tokens, and sanitized on output.
- **Sovereign OAuth 2.0 (BYOK Model)**: Uses RFC 8252 + RFC 7636 PKCE (`S256`) with ephemeral loopback listeners (`127.0.0.1:0`). Bring your own free Google Cloud Desktop credential or configure via `.env` — no middleman servers and no shared rate limits.
- **OS Keychain Security**: Refresh tokens and OAuth secrets are stored exclusively in the operating system's native vault (**macOS Keychain**, **Linux Secret Service / GNOME Keyring**, **Windows Credential Manager**), while short-lived access tokens stay in `Zeroizing<String>` RAM.
- **Privacy Shield & Tracker Blocking**: Automatically strips spy tracking pixels (`1x1` beacons and known tracking domains) and renders HTML inside a strictly sandboxed `iframe` (`sandbox=""`).
- **Multilingual Interface & AI**: Full UI and AI support for **English** (default), **Portuguese (PT-PT)**, **French**, and **Spanish**.

---

## 1. Quick Installation by Operating System

Kwrl Mail includes one-command automated build & install scripts for **Arch Linux**, **macOS**, and **Windows**. See the full [Installation Guide (INSTALL.md)](INSTALL.md) for details.

### 🐧 Arch Linux (and derivatives: Manjaro, EndeavourOS, CachyOS)
```bash
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
./scripts/install-arch.sh
# or via native pacman PKGBUILD:
cd packaging/arch && makepkg -si
```

### 🍏 macOS (Apple Silicon & Intel)
```bash
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
./scripts/install-mac.sh
```

### 🪟 Windows (10 and 11)
In PowerShell:
```powershell
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

---

## 2. Manual Build & Development

### Prerequisites
- **macOS (Apple Silicon / Intel)**, **Linux**, or **Windows 10/11**
- **Node.js 20+** and **Rust 1.90+** (`cargo`), **CMake**, and **Clang / GCC / MSVC**

```bash
# Install frontend dependencies
npm install

# Run the Rust security, OAuth, and SQLite unit test suite
npm run test:rust

# Start native development mode (compiles sidecar + opens Tauri window)
npm run tauri:dev

# Build optimized production binaries (LTO, strip=symbols, panic=abort)
npm run tauri:build
```

---

## 3. Configuring Google OAuth 2.0 Credentials (BYOK — Free Personal Key)

Kwrl Mail embraces the **BYOK (*Bring Your Own Keys*)** model — the open-source standard for sovereign desktop email clients:
- **Why?** Google mandates expensive commercial security audits (CASA Tier 2/3) for centralized public OAuth apps requesting Gmail scopes. With BYOK, each user creates their own free personal project in Google Cloud: it costs **$0**, has dedicated API quota, never expires, and guarantees **zero intermediary servers**.

### 2-Minute Step-by-Step Setup:

1. **Enable the Gmail API:**
   - Open [Google Cloud Console — Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
   - Create a free project (e.g., `Kwrl Mail`) and click **Enable**.

2. **Configure Consent Screen & Test Users (Critical Step):**
   - Navigate to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent).
   - Select **External** user type and click *Create*.
   - Fill in the basic required fields: **App name** (`Kwrl`) and your **Support email**.
   - ⚠️ **REQUIRED STEP (Audience / Test users):**
     Because your personal project is in *Testing* mode, Google blocks sign-in from unlisted addresses.
     Under **Audience** (or **Test users**), click **"+ Add users"** and add your Gmail address (and any additional Gmail accounts you plan to connect in Kwrl).
     *(Skipping this step will result in Google Error `403: access_denied`).*

3. **Create the "Desktop app" OAuth Credential:**
   - Open [Credentials](https://console.cloud.google.com/apis/credentials).
   - Click **+ Create Credentials** → **OAuth client ID**.
   - For **Application type**, choose **Desktop app**.
   - Name it (e.g., `Kwrl Desktop`) and click **Create**.
   - Click **Download JSON** on the confirmation dialog.

4. **Connect in Kwrl Mail:**
   - Open the downloaded `.json` file in any text editor, copy its contents (starts with `{"installed": ...}`), and paste it directly into Kwrl's setup screen.
   - Click **Save and Continue with Google**: Kwrl launches your default browser for authorization and stores your tokens encrypted in your **OS Keychain**.

---

## 4. Local `.gguf` AI Engine (`llama.cpp`)

On first launch, Kwrl can automatically download and verify the recommended quantized model (`Qwen 2.5 3B Instruct Q4_K_M`), or you can register any local `.gguf` file under **Settings & Privacy**:
- **Offline Registration (Zero Network):** Point to any local 4-bit `.gguf` file. The Rust backend validates the `GGUF` magic bytes and computes a streaming SHA-256 digest in 64 KB chunks before allowing execution.
- **Verified HTTPS Download:** Provide a direct HTTPS `.gguf` URL and its expected SHA-256 checksum; if the checksum mismatches, the temporary file is purged immediately before `llama.cpp` ever touches it.

---

## 5. Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `⌘K` / `Ctrl+K` | Focus **Instant Full-Text Search** (SQLite FTS5) |
| `⌘J` / `Ctrl+J` | Toggle the **Calm Summary & AI Writing Assistant** panel |
| `C` | Compose a new email |
| `E` | Archive the selected conversation |
| `/` | Focus the quick reply composer in the active thread |
| `J` / `K` | Navigate next / previous conversation in the list |
| `Esc` | Close active modal / unfocus input |

---

## 6. Architecture Overview

- [`src-tauri/src/secure_store.rs`](src-tauri/src/secure_store.rs) — Native OS Keychain vault (`keyring`) for `refresh_token` and volatile `Zeroizing<String>` RAM cache for `access_token`.
- [`src-tauri/src/oauth.rs`](src-tauri/src/oauth.rs) — OAuth 2.0 Desktop flow (RFC 8252 + RFC 7636 PKCE `S256`), ephemeral `127.0.0.1:0` loopback listener, constant-time CSRF check, and automatic token purge on `invalid_grant`.
- [`src-tauri/src/gmail_sync.rs`](src-tauri/src/gmail_sync.rs) — Persistent HTTP client (`reqwest` with gzip), rate-paced `/batch/gmail/v1` metadata fetching, exponential backoff with jitter on `429`/`403`/`5xx`, and incremental `history.list` delta sync.
- [`src-tauri/src/db.rs`](src-tauri/src/db.rs) — `WAL`-mode SQLite engine with FTS5 full-text search index, lazy MIME body hydration, and trusted contact allowlist.
- [`src-tauri/src/prompt_guard.rs`](src-tauri/src/prompt_guard.rs) & [`src-tauri/src/ipc_validation.rs`](src-tauri/src/ipc_validation.rs) — Pre-LLM prompt injection defense (OWASP LLM01), `<EMAIL_BODY>` structural isolation, plain-text output sanitization (OWASP LLM02), and strict IPC input validation.
- [`src-tauri/src/bin/llm_worker.rs`](src-tauri/src/bin/llm_worker.rs) & [`src-tauri/src/llm.rs`](src-tauri/src/llm.rs) — Isolated sidecar process (`env_clear()`) using `llama-cpp-2` with Metal/CUDA/Vulkan acceleration, `Flash-Attn`, `Q8_0` KV cache, lazy loading, 10-minute idle auto-unload, and real-time `ai-token` streaming.

---

## 7. Contributing, Security & License

- Please read our [Contributing Guide (CONTRIBUTING.md)](CONTRIBUTING.md), [Code of Conduct (CODE_OF_CONDUCT.md)](CODE_OF_CONDUCT.md), and [Security Policy (SECURITY.md)](SECURITY.md).
- Licensed under the [MIT License](LICENSE).
