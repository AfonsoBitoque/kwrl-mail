#!/usr/bin/env python3
"""
Treino QLoRA + Exportação direta para GGUF (`corvo-lm-finetuned.gguf`, Q4_K_M)
sobre o modelo aberto `Qwen/Qwen2.5-3B-Instruct` (Licença Apache 2.0 — uso comercial livre).

Pode correr numa GPU Linux / Google Colab (T4/L4) em ~12 minutos:
    pip install unsloth datasets trl transformers peft bitsandbytes
    python3 finetune/scripts/prepare_dataset.py
    python3 finetune/scripts/train_unsloth_gguf.py
"""

import hashlib
import pathlib
from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "build"
OUT_DIR = ROOT / "outputs"
BASE_MODEL = "Qwen/Qwen2.5-3B-Instruct"
MAX_SEQ_LENGTH = 4096


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LENGTH,
        load_in_4bit=True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        lora_alpha=32,
        lora_dropout=0.0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=1337,
    )

    dataset = load_dataset(
        "json",
        data_files={
            "train": str(DATA_DIR / "train.jsonl"),
            "validation": str(DATA_DIR / "valid.jsonl"),
        },
    )

    def format_chat(batch):
        texts = [
            tokenizer.apply_chat_template(
                msgs, tokenize=False, add_generation_prompt=False
            )
            for msgs in batch["messages"]
        ]
        return {"text": texts}

    train_ds = dataset["train"].map(format_chat, batched=True)
    eval_ds = dataset["validation"].map(format_chat, batched=True)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=MAX_SEQ_LENGTH,
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            num_train_epochs=3,
            learning_rate=2e-4,
            logging_steps=5,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            seed=1337,
            output_dir=str(OUT_DIR / "checkpoints"),
        ),
    )

    trainer.train()

    gguf_dir = OUT_DIR / "gguf"
    model.save_pretrained_gguf(
        str(gguf_dir),
        tokenizer,
        quantization_method="q4_k_m",
    )

    produced = list(gguf_dir.glob("*q4_k_m*.gguf"))
    if produced:
        final_gguf = OUT_DIR / "corvo-lm-finetuned.gguf"
        produced[0].replace(final_gguf)
        digest = sha256_file(final_gguf)
        print(f"\nModelo Corvo exportado: {final_gguf}")
        print(f"SHA-256 oficial para OFFICIAL_CORVO_MODEL_SHA256: {digest}")


if __name__ == "__main__":
    main()
