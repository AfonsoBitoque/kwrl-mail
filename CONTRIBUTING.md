# Guia de Contribuição — Kwrl

Obrigado pelo teu interesse em contribuir para o **Kwrl**!

O Kwrl é um cliente de e-mail desktop nativo desenhado segundo princípios de privacidade inegociável, design editorial calmo, soberania de dados e inferência local de inteligência artificial via `llama.cpp`.

---

## 🏛️ Filosofia e Princípios do Projeto

1. **Zero Telemetria & Privacidade Inegociável:** O código nunca recolhe métricas, nunca envia dados para servidores terceiros e não utiliza serviços analíticos na cloud.
2. **Modelo BYOK (*Bring Your Own Keys*):** Sem intermediários de autenticação. Os utilizadores trazem as suas credenciais gratuitas da Google Cloud, eliminando riscos de quotas partilhadas ou suspensão de chaves.
3. **IA 100% Local (Offline-first):** Todos os modelos correm localmente em processos isolados (`llama.cpp`) com quantizações GGUF seguras e sanitização anti-injeção de prompt.
4. **Português Europeu (PT-PT) Editorial:** O tom da interface e dos modelos deve manter o rigor gramatical, concisão e naturalidade de Portugal, sem recurso a clichês burocráticos ou variantes linguísticas incorretas.

---

## 🛠️ Configuração do Ambiente de Desenvolvimento

### Pré-requisitos
- **Node.js** (versão 20 ou superior) e **npm**
- **Rust Toolchain** (1.85 ou superior): `rustup update`
- **CMake** e compilador C++ (**Clang** no macOS, **GCC** no Linux, **MSVC** no Windows)

### Instalação e Execução
```bash
# 1. Clonar o repositório
git clone https://github.com/AfonsoBitoque/yoot-mail.git
cd yoot-mail

# 2. Instalar dependências de frontend
npm install

# 3. Executar em modo de desenvolvimento desktop (Tauri + Vite)
npm run tauri:dev
```

---

## 🧪 Verificação e Testes

Antes de submeteres um Pull Request, assegura-te de que todos os testes e verificações passam com sucesso:

```bash
# 1. Verificação estática de tipos TypeScript
npm run typecheck

# 2. Suite de testes unitários de segurança, OAuth e SQLite em Rust
npm run test:rust

# 3. Compilação do frontend
npm run build
```

---

## 📬 Submissão de Pull Requests

1. Cria um ramo (*branch*) temático a partir de `main`:
   ```bash
   git checkout -b feature/minha-melhoria
   ```
2. Mantém os commits limpos e descritivos:
   ```bash
   git commit -m "feat(oauth): adiciona suporte para validação de porta efémera"
   ```
3. Garante que não adicionas ficheiros sensíveis (`.env`, `client_secret*.json`, bases de dados locais `.sqlite3` ou modelos `.gguf`). O `.gitignore` já se encontra configurado para proteger estes ficheiros.
4. Submete o Pull Request descrevendo a motivação da alteração, o que foi testado e como reproduzir o comportamento.

---

## ⚖️ Licença

Ao contribuir para o Kwrl, concordas que as tuas contribuições serão licenciadas sob a licença [MIT](LICENSE).
