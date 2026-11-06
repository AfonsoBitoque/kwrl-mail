# Motor Corvo — Pipeline de Fine-Tune Próprio (`Qwen2.5-3B-Instruct` · Apache 2.0)

Esta pasta contém toda a infraestrutura para gerar dados sintéticos de alta fidelidade em português de Portugal (PT-PT), afinar os adaptadores LoRA e distribuir a **IA própria do Corvo** (`corvo-lm-finetuned.gguf`), mantendo **~1.9 GB** em disco (`Q4_K_M`) para correr com máxima rapidez em qualquer computador a partir de 8 GB de RAM com aceleração nativa por GPU (Apple Metal, CUDA ou Vulkan).

## O que foi melhorado na V2 do Motor Corvo
1. **Identificação Dinâmica de Remetente (`extract_friendly_sender_name`):**
   - Extrai automaticamente o nome próprio do remetente a partir da assinatura do corpo (`Ass: Jonh`, `Ass.: Pedro`, `Cumprimentos,\nMarta`, `Abraço,\nTiago`, `Sent from my iPhone`) ou do cabeçalho `From`.
   - Saúda de forma calorosa e humana (ex: `"Olá Jonh,"` ou `"Boa tarde Jonh,"`), eliminando definitivamente qualquer marcador genérico ou placeholder robótico.
2. **Personalização da Assinatura do Utilizador (`resolve_friendly_user_name`):**
   - Persistência no SQLite (`user_signature_name`) editável diretamente nas definições da aplicação (Painel "Privacidade & Preferências").
   - Deteta o primeiro nome real do utilizador no sistema operativo ou endereço de correio, garantindo assinaturas naturais (ex: `"Um abraço,\nAfonso"` ou `"Com os melhores cumprimentos,\nAfonso"`) sem expor identificadores técnicos ou números de utilizador.
3. **Respostas Afirmativas e Claras em Português Europeu:**
   - Elimina hesitações e dúvidas artificiais (como `"não é? se for esse o caso..."`).
   - Confirmação direta de disponibilidades, orçamentos, faturas e reuniões com tom profissional e acolhedor.

## Estrutura de Ficheiros
- `scripts/generate_synthetic_dataset.py`: Gerador de 240+ exemplos sintéticos realistas cobrindo reuniões, orçamentos, faturas, contratos, design, RH e apoio técnico nos 4 níveis CDLR (`frase`, `rascunho-curto`, `rascunho-estruturado`, `resumo-calmo`).
- `build/train.jsonl` e `build/valid.jsonl`: Datasets formatados em formato ChatML compatível com Qwen 2.5 / Corvo LM.
- `scripts/train_mlx_mac.sh`: Script de treino LoRA em Apple Silicon com Apple Metal via `mlx_lm.lora`.
- `scripts/train_unsloth_gguf.py`: Script para treino em Cloud GPU / Google Colab com exportação direta para `.gguf` quantizado (`Q4_K_M`).
- `outputs/adapters/`: Pesos LoRA afinados.

## Prioridade Automática no Binário Tauri do Corvo
O backend do Corvo (`src-tauri/src/lib.rs`) verifica prioritariamente se existe um modelo afinado:
1. Caminhos suportados:
   - **macOS**: `~/Library/Application Support/pt.corvo.mail/models/corvo-lm-finetuned.gguf`
   - **Linux**: `~/.local/share/pt.corvo.mail/models/corvo-lm-finetuned.gguf` (ou `$XDG_DATA_HOME/pt.corvo.mail/models/`)
   - **Windows**: `%LOCALAPPDATA%\pt.corvo.mail\models\corvo-lm-finetuned.gguf`
2. Se presente, a interface exibe **`Motor Corvo (Fine-Tune)`** e ativa-o com prioridade máxima.
3. Caso contrário, utiliza o motor oficial padrão (`corvo-lm-3b-q4_k_m.gguf`).
