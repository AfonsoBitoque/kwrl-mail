# Guia de Instalação Rápida — Kwrl

Este documento detalha o processo de instalação fácil e automatizada do **Kwrl** nos três principais sistemas operativos: **Arch Linux**, **macOS** e **Windows**.

---

## ⚡ Instalação Rápida Universal (Linux & Mac)

Se já clonou o repositório, execute o script de instalação para o seu sistema:

```bash
git clone https://github.com/AfonsoBitoque/yoot-mail.git
cd yoot-mail

# No Arch Linux:
./scripts/install-arch.sh

# No macOS:
./scripts/install-mac.sh
```

---

## 🐧 1. Arch Linux (e derivados: Manjaro, EndeavourOS, CachyOS)

O Kwrl dispõe de suporte nativo de primeira classe para Arch Linux.

### Opção A: Script de Instalação Automática (Recomendado)
Um único comando que valida as dependências via `pacman`, pergunta se pretende aceleração por GPU (CUDA/Vulkan) ou CPU, compila e adiciona o Kwrl ao seu menu de aplicações:

```bash
./scripts/install-arch.sh
```

### Opção B: Via `PKGBUILD` (`makepkg`)
Se prefere que a instalação seja gerida como um pacote nativo do `pacman`:

```bash
cd packaging/arch
makepkg -si
```
Isto compilará e criará o pacote `.pkg.tar.zst`, instalando os binários em `/usr/bin/kwrl` e `/usr/bin/kwrl-llm-worker`, o ficheiro `.desktop` em `/usr/share/applications/` e os respetivos ícones.

### Dependências Manuais (se preferir compilar manualmente)
```bash
sudo pacman -S --needed base-devel cmake clang webkit2gtk-4.1 gtk3 glib2 openssl nodejs npm rust gnome-keyring
npm install && npm run build
npx tauri build --no-bundle
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
```

---

## 🍏 2. macOS (Apple Silicon M1/M2/M3/M4 & Intel)

No macOS, o Kwrl utiliza a API Metal nativa para inferência gráfica ultra-rápida e o Apple Keychain para guardar credenciais OAuth.

### Opção A: Script de Instalação Automática (Recomendado)
Compila o frontend, compila o binário otimizado, monta o bundle `Kwrl.app`, aplica a assinatura de segurança local e instala em `/Applications/Kwrl.app`:

```bash
./scripts/install-mac.sh
```

### Opção B: Manual
```bash
npm install && npm run build
npx tauri build --no-bundle
cargo build --manifest-path src-tauri/Cargo.toml --release --bin kwrl-llm-worker
```
O executável `Kwrl.app` ficará pronto em `/Applications` ou em `src-tauri/target/release/bundle/macos/Kwrl.app`.

---

## 🪟 3. Windows (Windows 10 e Windows 11)

No Windows, o Kwrl utiliza o **Microsoft Edge WebView2** (pré-instalado nativamente no Windows 10 e 11) e o **Windows Credential Manager** para guardar credenciais.

### Opção A: Script PowerShell Automático (Recomendado)
Abra o **PowerShell** na pasta do projeto e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

O script:
1. Valida se o Node.js e o Rust Toolchain (MSVC) estão instalados.
2. Pergunta se pretende ativar aceleração por GPU NVIDIA (CUDA) ou Vulkan.
3. Compila o cliente e o motor de IA isolado.
4. Instala a aplicação em `%LOCALAPPDATA%\Programs\Kwrl`.
5. Cria atalhos no **Menu Iniciar** e no **Ambiente de Trabalho**.
6. Inicia o Kwrl automaticamente.

### Opção B: Gerar Instalador Executável (.msi ou .exe)
Para criar um instalador distribuível padrão do Windows:
```powershell
npx @tauri-apps/cli build
```
O instalador NSIS ficará gerado em `src-tauri\target\release\bundle\nsis\`.

---

## 🚀 Aceleração de Hardware para o Motor de IA (Local GGUF)

O processo de inferência `kwrl-llm-worker` adapta-se ao hardware disponível:

| Plataforma | Modo Padrão | Modo Acelerado por GPU |
| :--- | :--- | :--- |
| **macOS** | **Apple Metal** (Automático, zero configuração) | Totalmente acelerado pelo Neural Engine e GPU Metal |
| **Arch Linux** | **CPU Multi-thread** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |
| **Windows** | **CPU Multi-thread** (AVX2/AVX-512) | **CUDA**: `--features cuda` <br> **Vulkan**: `--features vulkan` |

---

## 📂 Onde ficam guardados os dados e modelos?

A base de dados SQLite offline e os modelos locais GGUF respeitam as pastas padrão de cada sistema:

- **Linux (Arch):** `~/.local/share/app.kwrl.mail/`
  - Modelos IA: `~/.local/share/app.kwrl.mail/models/`
  - Base de dados: `~/.local/share/app.kwrl.mail/kwrl_cache.sqlite3`
  *(Migração transparente: caso já existam dados do Corvo em `pt.corvo.mail`, são migrados automaticamente sem qualquer perda).*
- **macOS:** `~/Library/Application Support/app.kwrl.mail/`
  - Modelos IA: `~/Library/Application Support/app.kwrl.mail/models/`
  - Base de dados: `~/Library/Application Support/app.kwrl.mail/kwrl_cache.sqlite3`
- **Windows:** `%LOCALAPPDATA%\app.kwrl.mail\`
  - Modelos IA: `%LOCALAPPDATA%\app.kwrl.mail\models\`
  - Base de dados: `%LOCALAPPDATA%\app.kwrl.mail\kwrl_cache.sqlite3`

---

## 🔑 Configuração das Credenciais Google Cloud (Modelo BYOK — Chave Própria Gratuita)

O Kwrl adota o modelo **BYOK (*Bring Your Own Keys*)**: para garantir privacidade total sem intermediários e sem necessidade de pagar auditorias anuais comerciais à Google (CASA), cada utilizador cria a sua própria credencial gratuita no Google Cloud:

1. **Ativar a Gmail API:**
   - Acede à [Google Cloud Console — Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
   - Cria um projeto gratuito (ex.: `Kwrl Mail`) e clica em **Ativar** (*Enable*).

2. **Ecrã de Consentimento & Público-Alvo / Utilizadores de Teste (Passo Crítico):**
   - No menu lateral, entra em [OAuth consent screen (Ecrã de consentimento OAuth)](https://console.cloud.google.com/apis/credentials/consent).
   - Seleciona **Externo** (*External*) e preenche o nome da app (`Kwrl`) e o teu e-mail.
   - ⚠️ **MUITO IMPORTANTE (Público-alvo / Utilizadores de Teste):**
     Na secção **Público-alvo** (*Audience*) ou **Utilizadores de teste** (*Test users*), clica obrigatoriamente em **"+ Adicionar utilizadores"** (*+ Add users*) e introduz todos os endereços Gmail que pretendes utilizar no Kwrl.
     *(Se não adicionares o teu e-mail nesta lista de utilizadores de teste, a Google recusará a ligação com `Erro 403: access_denied`).*

3. **Criar Credencial do tipo "Aplicação de Computador" (Desktop app):**
   - Vai a [Credentials (Credenciais)](https://console.cloud.google.com/apis/credentials).
   - Clica em **+ Criar Credenciais** → **ID do cliente OAuth**.
   - Tipo de aplicação: escolhe **Aplicação de Computador** (*Desktop app*).
   - Clica em **Criar** e depois no botão de **Transferir JSON** (*Download JSON*).

4. **Colar no Kwrl:**
   - Abre o ficheiro `.json` descarregado com qualquer editor de texto.
   - Copia todo o conteúdo (começa por `{"installed": ...}`) e cola diretamente na janela do Kwrl.
   - Clica em **Guardar e Continuar com Google**: a tua sessão fica autenticada e as chaves protegidas no cofre do sistema operativo (Keychain / Secret Service).
