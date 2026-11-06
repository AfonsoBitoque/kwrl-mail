#!/usr/bin/env python3
"""
Prepara e valida o dataset de Fine-Tune do Motor Corvo (PT-PT) garantindo 100% de alinhamento
com o contrato de prompt em `src-tauri/src/prompt_guard.rs` (`CORVO_SYSTEM_PROMPT_PT` + `<EMAIL_BODY>`).
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEED_FILE = ROOT / "dataset" / "seed_pt_pt.jsonl"
OUT_DIR = ROOT / "build"
CONTRACT_FILE = ROOT / "contracts" / "system_prompt_contract.json"

with open(CONTRACT_FILE, "r", encoding="utf-8") as f:
    CONTRACT = json.load(f)

CORVO_SYSTEM_PROMPT_TEMPLATE = CONTRACT["system_prompt_template"]
FORBIDDEN_CLICHES = CONTRACT["forbidden_cliches"]


def build_tier_instruction(tier: str, user_account: str, sender: str) -> str:
    if tier == "frase":
        return (
            f"Escreve APENAS uma única frase completa, direta e natural em português de Portugal "
            f"para responder ao ponto central da última mensagem de {sender}. "
            f"Não coloques saudação inicial nem despedida. Termina com ponto final."
        )
    if tier == "rascunho-curto":
        return (
            f"Escreve uma resposta curta e natural (2 a 3 frases completas) em português de Portugal, "
            f"escrita por {user_account} para responder diretamente a {sender}. "
            f"Vai direto ao ponto central da conversa e fecha com uma despedida curta."
        )
    if tier == "resumo-calmo":
        return (
            "Resume esta conversa de forma clara, neutra e concisa em português de Portugal "
            "usando exatamente estas três secções curtas:\n"
            "Factos principais:\n"
            "Decisões ou estado atual:\n"
            "Próximos passos:"
        )
    return (
        f"Escreve uma resposta completa, bem estruturada e natural em português de Portugal, "
        f"escrita por {user_account} para responder a {sender}. Inclui uma saudação breve, "
        f"responde de forma organizada aos pontos concretos da conversa (usando parágrafos claros "
        f"ou pontos numerados) e conclui com uma despedida cordial completa."
    )


def main() -> int:
    if not SEED_FILE.exists():
        print(f"Ficheiro não encontrado: {SEED_FILE}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    formatted = []

    with SEED_FILE.open("r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            row = json.loads(raw)
            out_lower = row["assistant_output"].lower()
            for cliche in FORBIDDEN_CLICHES:
                if cliche in out_lower:
                    raise ValueError(f"Linha {line_no} contém cliché proibido: {cliche}")

            tier_instr = build_tier_instruction(
                row["tier"], row["user_account"], row["sender"]
            )
            user_prompt = (
                f"Titular da conta (quem vai responder): {row['user_account']}\n"
                f"Última mensagem recebida de: {row['sender']}\n"
                f"Assunto da conversa: {row['subject']}\n"
                f"<EMAIL_BODY>\n"
                f"{row['email_body']}\n"
                f"</EMAIL_BODY>\n"
                f"Instrução de escrita: {tier_instr}"
            )

            sender_name = row["sender"].split()[0] if row["sender"] else "o remetente"
            greeting_hint = f"'Olá {sender_name},' ou 'Boa tarde {sender_name},'"
            sys_prompt = CORVO_SYSTEM_PROMPT_TEMPLATE.format(
                user_name=row["user_account"].split("@")[0].capitalize(),
                greeting_hint=greeting_hint,
                sender_display=sender_name,
                doc_rule=""
            )

            formatted.append(
                {
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": user_prompt},
                        {"role": "assistant", "content": row["assistant_output"]},
                    ]
                }
            )

    split_idx = max(1, int(len(formatted) * 0.85))
    train_rows = formatted[:split_idx]
    valid_rows = formatted[split_idx:] or formatted[-1:]

    for path, rows in [
        (OUT_DIR / "train.jsonl", train_rows),
        (OUT_DIR / "valid.jsonl", valid_rows),
    ]:
        with path.open("w", encoding="utf-8") as out_fh:
            out_fh.writelines(json.dumps(item, ensure_ascii=False) + "\n" for item in rows)

    print(
        f"Dataset validado com sucesso: {len(train_rows)} treino / {len(valid_rows)} validação em {OUT_DIR}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
