# Corvo — Especificação de Produto, Arquitetura de Segurança & Design Anti-Slop

## 1. Tese de Produto
O **Corvo** trata a IA como **infraestrutura local silenciosa** e o desenho de interface como **tipografia editorial funcional**:
- **Zero Mocks e Zero Intermediários:** ligação direta da máquina do utilizador aos endpoints `oauth2.googleapis.com` e `gmail.googleapis.com`, com cache offline em SQLite (`WAL`) e inferência local nativa via `llama.cpp`.
- **Sem geração cega nem envio automático:** o scope `gmail.send` é deliberadamente excluído na Fase 1; qualquer rascunho assistido por IA exige confirmação explícita de revisão humana antes de poder ser copiado.
- **Defesa ativa contra conteúdo hostil:** o corpo de qualquer e-mail recebido é tratado como entrada não confiável (*untrusted input*), inspecionado antes de tocar no modelo e isolado num processo separado sem acesso a credenciais ou rede.

---

## 2. Sistema de Design Anti-Slop (Preservado Integralmente)

| Anti-Padrão Rejeitado | Decisão Deliberada no Corvo | Ficheiro |
| :--- | :--- | :--- |
| Gradientes roxos/azuis e texto `background-clip: text` | Tom de acento único e sólido (**Verde-Esteva** `#1f4d3d` em modo Papel; `#6ca893` em modo Ardósia) usado apenas em estados ativos, ação primária e proveniência de IA. | `src/styles/tokens.css` |
| `Inter`, `Roboto`, `system-ui` ou CDNs Google Fonts | Parelha editorial auto-alojada em `.woff2`: **Fraunces** (display com `opsz`) + **IBM Plex Sans** (leitura a `64ch` e UI) + **IBM Plex Mono** (`tabular-nums`). | `src/styles/fonts.css`, `src/styles/typography.css` |
| Preto `#000000` e branco `#ffffff` | Papel quente `#faf9f5` sobre carvão `#181715`. No modo Ardósia, luminância progressiva (`#0e100f` → `#131614` → `#191d1b`). | `src/styles/tokens.css` |
| Cartão dentro de cartão e barras laterais grossas | Contenção única por *hairlines* de `1px` e filete fino de `1px` para proveniência de IA. | `src/styles/layout.css` |
| Emojis como ícones de funcionalidades | Conjunto próprio de ícones geométricos vetoriais a traço contínuo de `1.25px`. | `src/components/Icons.tsx` |

---

## 3. Decisões de Engenharia e Tradeoffs Documentados

### 3.1. Privilégio Mínimo OAuth vs. Envio Direto na Fase 1
- **Decisão:** O fluxo OAuth Desktop solicita apenas `gmail.modify` + `gmail.labels` (ou `gmail.readonly`), omitindo `gmail.send`.
- **Justificação de Segurança:** Mesmo num cenário hipotético de falha total da camada aplicacional, o token OAuth emitido pela Google é criptograficamente incapaz de expedir correio em nome do utilizador, neutralizando vetores de exfiltração automática via *prompt injection*.

### 3.2. Higiene Estrita de Rede vs. Aprovisionamento do Modelo `.gguf`
- **Decisão:** A Content Security Policy (`tauri.conf.json`) bloqueia todos os domínios externos na WebView exceto `https://gmail.googleapis.com` e `https://oauth2.googleapis.com` (e `*.googleusercontent.com` apenas para imagens). Todas as fontes tipográficas foram empacotadas localmente em `public/fonts/`.
- **Tradeoff no Primeiro Arranque do Modelo:** Para cumprir rigorosamente o requisito de zero tráfego para domínios terceiros em operação normal, o Corvo privilegia o **registo local offline** (`register_local_gguf_model`) de qualquer ficheiro `.gguf` já presente no disco, validando os magic bytes `GGUF` e o SHA-256 em blocos de 64 KB. Adicionalmente, disponibiliza uma ação opcional iniciada explicitamente pelo utilizador no backend Rust (`download_verified_gguf_model`) com verificação obrigatória de checksum SHA-256 antes de renomear o ficheiro temporário.

### 3.3. Isolamento de Processo Sidecar (`corvo-llm-worker`) e Gestão de Memória
- **Decisão:** Em vez de ligar `llama.cpp` diretamente dentro do processo principal Tauri (onde um erro de memória C++ num tensor corrompido partilharia espaço de endereçamento com o `access_token` em RAM), o Corvo compila um segundo binário nativo (`corvo-llm-worker`).
- **Execução:** O supervisor (`src-tauri/src/llm.rs`) lança o worker apenas no primeiro pedido de IA (*lazy loading*) com `Command::env_clear()`, comunicando exclusivamente por JSON Lines em `stdin`/`stdout`. Na Apple Silicon, ativa Metal (`n_gpu_layers = 99`), `Flash-Attn`, cache KV `Q8_0`, `n_batch = 512`, `n_ubatch = 128` e `n_threads = min(8, physical_cpus)`. Após 10 minutos sem pedidos, o processo sidecar é terminado para devolver ~2–2.5 GB de RAM/VRAM ao sistema operativo.
