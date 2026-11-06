#!/usr/bin/env bash
# Treino LoRA nativo em Apple Silicon (Mac M1/M2/M3/M4) via MLX + ativação imediata no Corvo
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$ROOT_DIR/scripts/prepare_dataset.py"

echo "1/3 · A treinar adaptadores LoRA (Qwen2.5-3B-Instruct 4-bit) em Apple Metal..."
python3 -m mlx_lm.lora \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --train \
  --data "$ROOT_DIR/build" \
  --iters 300 \
  --batch-size 1 \
  --num-layers 8 \
  --adapter-path "$ROOT_DIR/outputs/adapters"

echo "2/3 · A fundir pesos (fuse) para modelo autónomo..."
python3 -m mlx_lm.fuse \
  --model Qwen/Qwen2.5-3B-Instruct \
  --adapter-path "$ROOT_DIR/outputs/adapters" \
  --save-path "$ROOT_DIR/outputs/merged-hf" \
  --de-quantize

echo "3/3 · Converte merged-hf para Q4_K_M .gguf com llama.cpp e copia para:"
echo "      ~/Library/Application Support/pt.corvo.mail/models/corvo-lm-finetuned.gguf"
echo "O Corvo deteta automaticamente 'corvo-lm-finetuned.gguf' com prioridade máxima no arranque!"
