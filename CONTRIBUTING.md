# Contributing to Kwrl Mail

Thank you for your interest in contributing to **Kwrl Mail**!

Kwrl Mail is a native desktop email client built on uncompromising privacy, calm editorial design, user data sovereignty, and 100% local AI inference via `llama.cpp`.

---

## 🏛️ Core Project Principles

1. **Zero Telemetry & Absolute Privacy:** Kwrl never collects metrics, never phones home to third-party servers, and never uses cloud analytics.
2. **BYOK (*Bring Your Own Keys*):** No authentication middlemen. Users connect directly to Google using their own free Google Cloud Desktop credentials, eliminating shared rate limits and third-party token access.
3. **100% Local AI (Offline-First):** All language models run locally in an isolated sidecar process (`kwrl-llm-worker`) using verified `.gguf` files and strict prompt-injection defenses (`prompt_guard.rs`).
4. **Multilingual & Calm Design:** The UI defaults to English (`en`) and supports Portuguese (`pt`), French (`fr`), and Spanish (`es`). Every new UI string must be added to all 4 locale dictionaries in `src/i18n/translations/`.

---

## 🛠️ Development Environment Setup

### Prerequisites
- **Node.js** (v20 or newer) and **npm**
- **Rust Toolchain** (1.90 or newer): `rustup update stable`
- **CMake** and a C++ compiler (**Clang** on macOS, **GCC/Clang** on Linux, **MSVC** on Windows)

### Running Locally
```bash
# 1. Clone the repository
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail

# 2. Install frontend dependencies
npm install

# 3. Run in native desktop development mode (Tauri + Vite)
npm run tauri:dev
```

---

## 🧪 Verification & Testing

Before opening a Pull Request, ensure all checks and tests pass:

```bash
# 1. Static TypeScript type checking
npm run typecheck

# 2. Rust unit test suite (OAuth PKCE, SQLite WAL, Prompt Guard, Sync)
npm run test:rust

# 3. Production frontend build
npm run build
```

---

## 📬 Submitting Pull Requests

1. Create a feature or fix branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Keep commits focused and descriptive:
   ```bash
   git commit -m "feat(sync): improve backoff jitter on 429 responses"
   ```
3. Never commit sensitive files (`.env`, `client_secret*.json`, `.sqlite3` databases, or `.gguf` models).
4. Open a Pull Request describing the motivation, changes made, and how to test them.

---

## ⚖️ License

By contributing to Kwrl Mail, you agree that your contributions will be licensed under the [MIT License](LICENSE).
