# Corvo — Cliente de E-mail Desktop com Gmail Real, Keychain & IA Local (`llama.cpp`)

Cliente de e-mail desktop nativo (**Tauri v2 + Rust + React**) desenhado segundo princípios de *craft* editorial anti-slop, privilégio mínimo OAuth 2.0 e inferência local endurecida contra OWASP LLM Top 10.

Zero dados estáticos ou mocks: toda a sincronização ocorre diretamente contra a **Gmail API** com persistência local em **SQLite WAL**, armazenamento de credenciais no **OS Keychain** e geração em *streaming* num processo isolado **`llama.cpp` (Metal)**.

---

## 1. Instalação Rápida por Sistema Operativo

O Corvo dispõe de instaladores automatizados de um só comando para **Arch Linux**, **macOS** e **Windows**. Consulte o [Guia Completo de Instalação (INSTALL.md)](INSTALL.md).

### 🐧 Arch Linux (e derivados: Manjaro, EndeavourOS)
```bash
./scripts/install-arch.sh
# ou via PKGBUILD nativo:
cd packaging/arch && makepkg -si
```

### 🍏 macOS (Apple Silicon & Intel)
```bash
./scripts/install-mac.sh
```

### 🪟 Windows (10 e 11)
No PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

---

## 2. Compilação Manual e Testes

- **macOS (Apple Silicon / Intel)**, Windows ou Linux
- **Node.js 20+** e **Rust 1.85+** (`cargo`), **CMake** e **Clang / GCC**

```bash
# Instalar dependências frontend
npm install

# Executar suite de testes unitários de segurança e sincronização em Rust (32 testes)
npm run test:rust

# Executar em modo de desenvolvimento nativo (compila o sidecar + abre a janela Tauri)
npm run tauri:dev

# Gerar binário de produção otimizado (LTO, strip=symbols, panic=abort)
npm run tauri:build
```

---

## 2. Configurar Credenciais Google OAuth 2.0 ("Desktop app")

1. Acede à **Google Cloud Console** → **APIs & Services** → **Library** e ativa a **Gmail API**.
2. Em **OAuth consent screen**, configura a aplicação e adiciona o teu endereço Google aos utilizadores de teste (enquanto em modo *Testing*).
3. Em **Credentials** → **Create Credentials** → **OAuth client ID**, escolhe o tipo **Desktop app** (permite qualquer porta efémera em `http://127.0.0.1:<porta>` sem pré-registo de porta fixa).
4. Na janela do **Corvo**:
   - Introduz o `Client ID` e o `Client Secret` (o segredo é guardado exclusivamente no **OS Keychain** via crate `keyring`).
   - Escolhe o nível de privilégio: `gmail.modify + gmail.labels` (leitura e atualização de estado lido, **sem** `gmail.send`) ou `gmail.readonly`.
   - Clica em **Autenticar conta Google no browser do sistema**: o Corvo gera um par PKCE `S256` (32 bytes aleatórios), escuta apenas um pedido em `127.0.0.1:0`, valida `state` em tempo constante, fecha o listener imediatamente e armazena o `refresh_token` no Keychain (mantendo o `access_token` apenas em RAM volátil `Zeroizing<String>`).

---

## 3. Configurar Modelo Local `.gguf` (`llama.cpp` Nativo)

Abre **Segurança, Modelo & Contas** na barra lateral inferior:
- **Registo Offline (Zero Rede — Recomendado):** indica o caminho absoluto para um ficheiro `.gguf` quantizado em 4-bit (ex.: `Qwen2.5-3B-Instruct-Q4_K_M.gguf` ou `Phi-4-mini-instruct-Q4_K_M.gguf`). O backend valida os magic bytes `GGUF` e calcula o SHA-256 em blocos de 64 KB antes de autorizar o carregamento.
- **Transferência Verificada (Opcional):** indica um URL HTTPS direto `.gguf` e o checksum SHA-256 oficial obrigatório; se o hash divergir, o ficheiro temporário é eliminado antes de qualquer leitura pelo `llama.cpp`.

---

## 4. Atalhos de Teclado

- `⌘K` / `Ctrl+K` — Focar **Pesquisa Semântica** sobre o cache SQLite (ex.: `e-mails do João sobre orçamento Q3`)
- `⌘J` / `Ctrl+J` — Mostrar ou ocultar a coluna lateral discreta de **Resumo Calmo & Sugestões CDLR**
- `⌘\` / `Ctrl+\` — Alternar **Modo Foco** (recolhe navegação lateral, dedicando >80% do ecrã à leitura)
- `J` / `K` — Percorrer conversas na lista sem tirar as mãos do teclado

---

## 5. Estrutura do Código

- `src-tauri/src/secure_store.rs` — Cofre OS Keychain (`keyring`) para `refresh_token` e cache volátil em RAM (`Zeroizing<String>`) para `access_token`.
- `src-tauri/src/oauth.rs` — Fluxo OAuth 2.0 Desktop (RFC 8252 + RFC 7636 PKCE `S256`), listener loopback efémero `127.0.0.1:0`, validação CSRF constante e purga automática em `invalid_grant`.
- `src-tauri/src/gmail_sync.rs` — Cliente HTTP reutilizável (`reqwest` com pool persistente e gzip), multipart batching `/batch/gmail/v1` (máx. 50), semáforo de concorrência (4), backoff exponencial com jitter em `429`/`403`/`5xx`, sincronização incremental `history.list` e fallback automático em `404`.
- `src-tauri/src/db.rs` — Motor SQLite em modo `WAL` com listagem leve para IPC (sem corpos completos), hidratação diferida MIME `text/plain` e allowlist de contactos conhecidos.
- `src-tauri/src/prompt_guard.rs` & `src-tauri/src/ipc_validation.rs` — Defesa pré-LLM contra *prompt injection* (OWASP LLM01), isolamento estrutural `<EMAIL_BODY>`, sanitização de saída como texto puro (OWASP LLM02) e validação estrita de parâmetros IPC.
- `src-tauri/src/bin/corvo_llm_worker.rs` & `src-tauri/src/llm.rs` — Processo sidecar isolado (`env_clear()`) com `llama-cpp-2` + Metal (`n_gpu_layers = 99`), `Flash-Attn`, cache KV `Q8_0`, *lazy loading*, descarga automática após 10 min de inatividade e *streaming* de eventos `ai-token`.
- `src-tauri/tauri.conf.json` & `src-tauri/capabilities/` — Hardening Tauri v2 (`freezePrototype: true`, CSP estrita sem CDNs externos e *capabilities* separadas por janela).
- `public/fonts/` & `src/styles/` — Tipografia auto-alojada (`Fraunces`, `IBM Plex Sans`, `IBM Plex Mono`) e sistema de design editorial anti-slop.
