# Security Policy — Kwrl Mail

Security and data sovereignty are foundational to **Kwrl Mail**. Because an email client handles sensitive personal communications, OAuth 2.0 credentials, and untrusted remote content (HTML emails and LLM inputs), we treat security vulnerabilities with the highest priority.

---

## 🛡️ Security Architecture Overview

1. **Credential Storage (`secure_store.rs`):**
   - Long-lived OAuth 2.0 `refresh_token` and `client_secret` values are stored exclusively in the operating system's native credential vault (**macOS Keychain**, **Linux Secret Service / GNOME Keyring**, **Windows Credential Manager**).
   - Short-lived `access_token` values are held only in volatile memory wrapped in `zeroize::Zeroizing<String>` so they are wiped from RAM on drop.

2. **OAuth 2.0 Flow (`oauth.rs`):**
   - Implements RFC 8252 + RFC 7636 PKCE (`S256`) with an ephemeral loopback listener (`127.0.0.1:0`) and constant-time CSRF `state` verification.

3. **Prompt Injection & LLM Isolation (`prompt_guard.rs` & `llm.rs`):**
   - Untrusted email subjects and bodies are scanned for prompt-injection heuristics (OWASP LLM01) before inference.
   - Email content is isolated inside structural `<EMAIL_BODY>` delimiters with special chat template tokens (`<|im_start|>`, `<|im_end|>`, etc.) stripped.
   - The `kwrl-llm-worker` sidecar process is spawned with `env_clear()` and communicates strictly via standard pipes (`stdin`/`stdout`).
   - All `.gguf` model files are verified against `GGUF` magic bytes and streaming SHA-256 checksums before loading.

4. **HTML Email Sandboxing (`ReadingPane.tsx`):**
   - Remote tracking pixels (`1x1` images and known spy trackers) are stripped prior to rendering.
   - HTML bodies are rendered inside an isolated `<iframe sandbox="">` with scripts, forms, and same-origin access disabled.

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability in Kwrl Mail (such as a prompt-injection bypass, HTML sanitizer bypass, IPC validation flaw, or credential leak):

1. **Do NOT open a public GitHub issue** for unpatched security vulnerabilities.
2. Please use **GitHub Private Vulnerability Reporting** (under the repository's **Security → Advisories → Report a vulnerability** tab) or contact the maintainer directly via GitHub profile contact details.
3. Include:
   - A clear description of the vulnerability and its potential impact.
   - Step-by-step reproduction instructions or a minimal proof-of-concept (PoC).
   - Affected operating system(s) and commit hash / version.

We aim to acknowledge reports within **48 hours** and provide a fix or mitigation plan within **7 days**.
