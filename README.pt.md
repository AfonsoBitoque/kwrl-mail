# Kwrl Mail — Cliente de E-mail Desktop com Gmail Real, Keychain & IA Local (`llama.cpp`)

🌐 **[English](README.md)** | **[Português](README.pt.md)**

Cliente de e-mail desktop nativo (**Tauri v2 + Rust + React**) desenhado segundo princípios de *craft* editorial calmo, privilégio mínimo OAuth 2.0 e inferência local endurecida contra OWASP LLM Top 10.

Zero dados estáticos ou servidores intermediários: toda a sincronização ocorre diretamente contra a **Gmail API** com persistência local em **SQLite WAL**, armazenamento de credenciais no **OS Keychain** e geração em *streaming* num processo isolado **`llama.cpp` (Metal/CUDA/Vulkan)**. Disponível em **Inglês, Português, Francês e Espanhol**.

---

## 1. Instalação Rápida por Sistema Operativo

O Kwrl Mail dispõe de instaladores automatizados de um só comando para **Arch Linux**, **macOS** e **Windows**. Consulte o [Guia Completo de Instalação (INSTALL.md)](INSTALL.md).

### 🐧 Arch Linux (e derivados: Manjaro, EndeavourOS)
```bash
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
./scripts/install-arch.sh
# ou via PKGBUILD nativo:
cd packaging/arch && makepkg -si
```

### 🍏 macOS (Apple Silicon & Intel)
```bash
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
./scripts/install-mac.sh
```

### 🪟 Windows (10 e 11)
No PowerShell:
```powershell
git clone https://github.com/AfonsoBitoque/kwrl-mail.git
cd kwrl-mail
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

---

## 2. Compilação Manual e Testes

- **macOS (Apple Silicon / Intel)**, Windows ou Linux
- **Node.js 20+** e **Rust 1.90+** (`cargo`), **CMake** e **Clang / GCC**

```bash
# Instalar dependências frontend
npm install

# Executar suite de testes unitários de segurança e sincronização em Rust
npm run test:rust

# Executar em modo de desenvolvimento nativo (compila o sidecar + abre a janela Tauri)
npm run tauri:dev

# Gerar binário de produção otimizado (LTO, strip=symbols, panic=abort)
npm run tauri:build
```

---

## 3. Configurar Credenciais Google OAuth 2.0 (Modelo BYOK — Chave Própria Gratuita)

O Kwrl Mail adota o modelo **BYOK (*Bring Your Own Keys*)**, o padrão da indústria para aplicações de e-mail de código aberto e privacidade soberana (utilizado pelo *Thunderbird*, *Mailspring*, *Himalaya* e *Mutt*):
- **Porquê?** A Google exige auditorias de segurança comerciais (CASA Tier 2/3) que custam milhares de euros anuais para aplicações públicas centralizadas. Com o modelo BYOK, cada utilizador cria o seu próprio projeto pessoal gratuito na Google Cloud: custa **0 €**, tem quota dedicada, nunca expira e garante **zero servidores intermediários**.

### Passo a Passo Detalhado (2 Minutos):

1. **Ativar a Gmail API:**
   - Acede à [Google Cloud Console — Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
   - Cria um projeto gratuito (ex.: `Kwrl Mail`) e clica em **Ativar** (*Enable*).

2. **Configurar o Ecrã de Consentimento & Público-Alvo (Passo Crítico):**
   - No menu lateral esquerdo, acede a [OAuth consent screen (Ecrã de consentimento OAuth)](https://console.cloud.google.com/apis/credentials/consent).
   - Seleciona o tipo de utilizador **Externo** (*External*) e clica em *Criar*.
   - Preenche os campos obrigatórios básicos: **Nome da app** (`Kwrl`) e o teu **E-mail de apoio**.
   - ⚠️ **PASSO OBRIGATÓRIO (Público-alvo / Utilizadores de Teste):**
     Como a app está em modo de desenvolvimento pessoal (*Testing*), a Google bloqueia o login de qualquer conta não registada.
     No separador **Público-alvo** (*Audience*) ou **Utilizadores de teste** (*Test users*), clica obrigatoriamente em **"+ Adicionar utilizadores"** (*+ Add users*) e insere o teu endereço Gmail (e qualquer outra conta que queiras ligar no Kwrl).
     *(Se saltares este passo, a Google recusará o início de sessão com o erro `403: access_denied`).*

3. **Criar a Credencial OAuth "Desktop app":**
   - Acede a [Credentials (Credenciais)](https://console.cloud.google.com/apis/credentials).
   - Clica em **+ Criar Credenciais** (*+ Create Credentials*) → **ID do cliente OAuth** (*OAuth client ID*).
   - No campo **Tipo de aplicação**, escolhe obrigatoriamente **Aplicação de Computador** (*Desktop app*).
   - Dá um nome (ex.: `Kwrl Desktop`) e clica em **Criar**.
   - Na janela de confirmação que abre, clica no botão **Transferir JSON** (*Download JSON*).

4. **Ligar no Kwrl:**
   - Abre o ficheiro `.json` descarregado num editor de texto (Bloco de Notas, VS Code, etc.).
   - Copia todo o texto (começa por `{"installed": ...}`) e cola na caixa de texto inicial do Kwrl.
   - Clica em **Guardar e Continuar com Google**: o Kwrl abre o teu browser habitual para autorização e guarda o segredo com encriptação nativa no **Keychain do sistema operativo**.

---

## 4. Configurar Modelo Local `.gguf` (`llama.cpp` Nativo)

Abre **Definições & Privacidade** na barra lateral inferior:
- **Registo Offline (Zero Rede — Recomendado):** indica o caminho absoluto para um ficheiro `.gguf` quantizado em 4-bit (ex.: `Qwen2.5-3B-Instruct-Q4_K_M.gguf` ou `Phi-4-mini-instruct-Q4_K_M.gguf`). O backend valida os magic bytes `GGUF` e calcula o SHA-256 em blocos de 64 KB antes de autorizar o carregamento.
- **Transferência Verificada (Opcional):** indica um URL HTTPS direto `.gguf` e o checksum SHA-256 oficial obrigatório; se o hash divergir, o ficheiro temporário é eliminado antes de qualquer leitura pelo `llama.cpp`.

---

## 5. Atalhos de Teclado

- `⌘K` / `Ctrl+K` — Focar **Pesquisa Rápida** sobre o cache SQLite local (FTS5)
- `⌘J` / `Ctrl+J` — Mostrar ou ocultar a coluna lateral de **Resumo & Assistente IA**
- `C` — Compor novo e-mail
- `E` — Arquivar conversa selecionada
- `/` — Focar resposta rápida na conversa aberta
- `J` / `K` — Percorrer conversas na lista sem tirar as mãos do teclado

---

## 6. Contribuição, Segurança e Licença

- Consulta o [Guia de Contribuição (CONTRIBUTING.md)](CONTRIBUTING.md) e a [Política de Segurança (SECURITY.md)](SECURITY.md).
- Este projeto está licenciado sob a [Licença MIT](LICENSE).
