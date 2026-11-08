pub mod db;
pub mod gmail_sync;
pub mod ipc_validation;
pub mod llm;
pub mod oauth;
pub mod prompt_guard;
pub mod secure_store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use crate::db::{DbError, LocalDatabase, StoredAccount, ThreadDetailDto, ThreadListItemDto};
use crate::gmail_sync::{build_gmail_http_client, GmailSyncEngine, SyncReport};
use crate::ipc_validation::{
    validate_attachments_total_bytes, validate_email_address, validate_gmail_id,
    validate_non_null_bounded, validate_optional_search_query, MAX_REWRITE_TEXT_LEN,
};
use crate::llm::{
    AiBootstrapProgressPayload, InferenceCompleted, LlmSupervisor, LocalModelStatus,
    ModelRuntimeConfig, DEFAULT_CONTEXT_WINDOW,
};
use crate::oauth::{
    authenticate_desktop_google_account, ensure_valid_access_token_with_endpoint,
    DesktopOAuthClientConfig, GmailScopeMode,
};
use crate::prompt_guard::{inspect_untrusted_email, InjectionInspection};
use crate::secure_store::TokenManager;

const OAUTH_CLIENT_KEYRING_SERVICE: &str = "app.kwrl.mail.oauth.client";
const LEGACY_OAUTH_CLIENT_KEYRING_SERVICE: &str = "pt.corvo.mail.oauth.client";
const OAUTH_CLIENT_SECRET_KEY: &str = "google_desktop_client_secret";
const KV_OAUTH_CLIENT_ID: &str = "oauth_client_id";
const KV_POLL_INTERVAL_SECS: &str = "poll_interval_secs";
const KV_MASTER_AI_KILL: &str = "master_ai_kill_switch";
const KV_GGUF_PATH: &str = "gguf_model_path";
const KV_GGUF_SHA256: &str = "gguf_model_sha256";
const KV_GGUF_CTX: &str = "gguf_context_size";
const KV_ALLOW_OLLAMA_FALLBACK: &str = "allow_ollama_fallback";
const KV_OLLAMA_TAG: &str = "ollama_model_tag";
const KV_USER_SIGNATURE_NAME: &str = "user_signature_name";
const KV_CUSTOM_MAILBOXES: &str = "custom_mailboxes_json";
const KV_UI_LANGUAGE: &str = "ui_language";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMailboxDto {
    pub id: String,
    pub name: String,
    pub account_emails: Vec<String>,
    pub color: Option<String>,
}

const FINETUNED_KWRL_MODEL_FILENAME: &str = "kwrl-lm-finetuned.gguf";
const OFFICIAL_KWRL_MODEL_FILENAME: &str = "kwrl-lm-3b-q4_k_m.gguf";
const LEGACY_FINETUNED_MODEL_FILENAME: &str = "corvo-lm-finetuned.gguf";
const LEGACY_OFFICIAL_MODEL_FILENAME: &str = "corvo-lm-3b-q4_k_m.gguf";

// Aliases de compatibilidade
pub const FINETUNED_CORVO_MODEL_FILENAME: &str = FINETUNED_KWRL_MODEL_FILENAME;
pub const OFFICIAL_CORVO_MODEL_FILENAME: &str = OFFICIAL_KWRL_MODEL_FILENAME;

const OFFICIAL_KWRL_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf";
const OFFICIAL_KWRL_MODEL_SHA256: &str =
    "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d";

pub struct KwrlState {
    pub db: Arc<LocalDatabase>,
    pub token_manager: TokenManager,
    pub sync_engine: Arc<GmailSyncEngine>,
    pub llm: Arc<LlmSupervisor>,
    pub http_client: Client,
    pub app_data_dir: PathBuf,
    pub user_poll_interval_secs: Arc<AtomicU64>,
    pub master_ai_kill_switch: Arc<AtomicBool>,
    pub ai_bootstrap_in_flight: Arc<AtomicBool>,
}

/// Alias para manter compatibilidade com módulos e testes existentes
pub type CorvoState = KwrlState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountViewDto {
    pub email: String,
    pub label: String,
    pub scope_mode: GmailScopeMode,
    pub history_id: Option<String>,
    pub keychain_session_active: bool,
    pub ai_enabled: bool,
    pub suggestion_trigger: String,
    pub auto_summarize: bool,
    pub last_synced_epoch: Option<i64>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModelDto {
    pub id: String,
    pub display_name: String,
    pub subtitle: String,
    pub path: String,
    pub size_mb: u64,
    pub expected_sha256: Option<String>,
    pub recommended: bool,
    pub is_general_purpose: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStateDto {
    pub oauth_client_id: Option<String>,
    pub oauth_secret_in_keychain: bool,
    pub accounts: Vec<AccountViewDto>,
    pub poll_interval_secs: u64,
    pub master_ai_kill_switch: bool,
    pub user_signature_name: String,
    pub model_status: LocalModelStatus,
    pub available_models: Vec<DiscoveredModelDto>,
    pub custom_mailboxes: Vec<CustomMailboxDto>,
    pub ui_language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOpenPayload {
    pub thread: ThreadDetailDto,
    pub injection_inspection: InjectionInspection,
}

fn parse_google_oauth_json(raw_json: &str) -> Option<(String, String)> {
    let val: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    let container = val.get("installed").or_else(|| val.get("web"))?;
    let cid = container.get("client_id")?.as_str()?.trim().to_string();
    let csec = container.get("client_secret")?.as_str()?.trim().to_string();
    if cid.is_empty() || csec.is_empty() {
        return None;
    }
    Some((cid, csec))
}

fn parse_dotenv_oauth(contents: &str) -> Option<(String, String)> {
    let mut cid = None;
    let mut csec = None;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            if (key == "KWRL_GOOGLE_CLIENT_ID" || key == "CORVO_GOOGLE_CLIENT_ID") && !val.is_empty() {
                cid = Some(val);
            } else if (key == "KWRL_GOOGLE_CLIENT_SECRET" || key == "CORVO_GOOGLE_CLIENT_SECRET") && !val.is_empty() {
                csec = Some(val);
            }
        }
    }
    match (cid, csec) {
        (Some(i), Some(s)) => Some((i, s)),
        _ => None,
    }
}

fn try_discover_app_oauth_credentials() -> Option<(String, String)> {
    // 1. Credenciais embutidas na compilação do Kwrl via build.rs (.env)
    let env_cid = option_env!("KWRL_GOOGLE_CLIENT_ID").or(option_env!("CORVO_GOOGLE_CLIENT_ID"));
    let env_csec = option_env!("KWRL_GOOGLE_CLIENT_SECRET").or(option_env!("CORVO_GOOGLE_CLIENT_SECRET"));
    if let (Some(cid), Some(csec)) = (env_cid, env_csec) {
        if !cid.trim().is_empty() && !csec.trim().is_empty() {
            return Some((cid.trim().to_string(), csec.trim().to_string()));
        }
    }

    // 2. Descoberta automática de .env ou client_secret*.json na pasta do projeto (sem exigir recompilação)
    let mut candidate_dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(parent) = cwd.parent() {
            candidate_dirs.push(parent.to_path_buf());
        }
        candidate_dirs.push(cwd);
    }
    let workspace_fallback = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = workspace_fallback.parent() {
        candidate_dirs.push(root.to_path_buf());
    }

    for dir in candidate_dirs {
        let dotenv_path = dir.join(".env");
        if let Ok(txt) = std::fs::read_to_string(&dotenv_path) {
            if let Some(pair) = parse_dotenv_oauth(&txt) {
                return Some(pair);
            }
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("client_secret") && name.ends_with(".json") {
                    if let Ok(txt) = std::fs::read_to_string(entry.path()) {
                        if let Some(pair) = parse_google_oauth_json(&txt) {
                            return Some(pair);
                        }
                    }
                }
            }
        }
    }

    None
}

static OAUTH_CONFIG_CACHE: std::sync::RwLock<Option<DesktopOAuthClientConfig>> =
    std::sync::RwLock::new(None);

fn persist_oauth_client_to_keychain(
    db: &LocalDatabase,
    client_id: &str,
    client_secret: &str,
) -> Result<(), String> {
    let entry = keyring::Entry::new(OAUTH_CLIENT_KEYRING_SERVICE, OAUTH_CLIENT_SECRET_KEY)
        .map_err(|e| format!("Falha ao preparar Keychain: {}", e))?;
    entry
        .set_password(client_secret)
        .map_err(|e| format!("Falha ao guardar Client Secret no Keychain: {}", e))?;
    db.set_kv(KV_OAUTH_CLIENT_ID, client_id)
        .map_err(|e| e.to_string())?;

    if let Ok(mut lock) = OAUTH_CONFIG_CACHE.write() {
        *lock = Some(DesktopOAuthClientConfig {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
        });
    }

    Ok(())
}

fn load_oauth_client_config(db: &LocalDatabase) -> Result<DesktopOAuthClientConfig, String> {
    if let Ok(guard) = OAUTH_CONFIG_CACHE.read() {
        if let Some(ref cached) = *guard {
            return Ok(cached.clone());
        }
    }

    // Primeiro verifica Keychain + SQLite; se ainda vazio, importa automaticamente de build/.env/JSON
    if let Ok(Some(cid)) = db.get_kv(KV_OAUTH_CLIENT_ID) {
        if !cid.trim().is_empty() {
            // Tenta o serviço atual do Kwrl
            let secret_opt = keyring::Entry::new(OAUTH_CLIENT_KEYRING_SERVICE, OAUTH_CLIENT_SECRET_KEY)
                .ok()
                .and_then(|e| e.get_password().ok())
                .filter(|s| !s.trim().is_empty())
                // Fallback para serviço anterior do Corvo
                .or_else(|| {
                    keyring::Entry::new(LEGACY_OAUTH_CLIENT_KEYRING_SERVICE, OAUTH_CLIENT_SECRET_KEY)
                        .ok()
                        .and_then(|e| e.get_password().ok())
                        .filter(|s| !s.trim().is_empty())
                });

            if let Some(secret) = secret_opt {
                let cfg = DesktopOAuthClientConfig {
                    client_id: cid,
                    client_secret: secret,
                };
                if let Ok(mut lock) = OAUTH_CONFIG_CACHE.write() {
                    *lock = Some(cfg.clone());
                }
                return Ok(cfg);
            }
        }
    }

    if let Some((discovered_id, discovered_secret)) = try_discover_app_oauth_credentials() {
        let cfg = DesktopOAuthClientConfig {
            client_id: discovered_id,
            client_secret: discovered_secret,
        };
        if let Ok(mut lock) = OAUTH_CONFIG_CACHE.write() {
            *lock = Some(cfg.clone());
        }
        return Ok(cfg);
    }

    Err("Falta registar 1 única vez a chave gratuita da app Kwrl na Google (vê os 4 passos rápidos abaixo).".to_string())
}

fn has_oauth_client_secret_in_keychain() -> bool {
    if let Ok(guard) = OAUTH_CONFIG_CACHE.read() {
        if guard.is_some() {
            return true;
        }
    }
    keyring::Entry::new(OAUTH_CLIENT_KEYRING_SERVICE, OAUTH_CLIENT_SECRET_KEY)
        .and_then(|e| e.get_password())
        .map(|s| !s.trim().is_empty())
        .or_else(|_| {
            keyring::Entry::new(LEGACY_OAUTH_CLIENT_KEYRING_SERVICE, OAUTH_CLIENT_SECRET_KEY)
                .and_then(|e| e.get_password())
                .map(|s| !s.trim().is_empty())
        })
        .unwrap_or(false)
}

fn map_account_dto(acc: StoredAccount, token_mgr: &TokenManager) -> AccountViewDto {
    let keychain_ok = token_mgr.has_stored_session(&acc.email);
    AccountViewDto {
        email: acc.email,
        label: acc.label,
        scope_mode: acc.scope_mode,
        history_id: acc.history_id,
        keychain_session_active: keychain_ok,
        ai_enabled: acc.ai_enabled,
        suggestion_trigger: acc.suggestion_trigger,
        auto_summarize: acc.auto_summarize,
        last_synced_epoch: acc.last_synced_epoch,
        provider: acc.provider,
    }
}

fn format_thread_for_ai(detail: &ThreadDetailDto) -> (String, String) {
    let last_sender = detail
        .messages
        .last()
        .map(|m| format!("{} <{}>", m.sender_name, m.sender_email))
        .unwrap_or_default();

    let combined_body = detail
        .messages
        .iter()
        .map(|m| {
            format!(
                "[{} - {}]:\n{}",
                m.sender_name,
                m.display_date,
                m.body_plain.as_deref().unwrap_or(&m.snippet)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    (last_sender, combined_body)
}

fn has_valid_gguf_header_and_size(path: &std::path::Path) -> Option<u64> {
    use std::io::Read;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let size_mb = meta.len() / (1024 * 1024);
    // Filtra ficheiros truncados (<50 MB) ou pesados demais para 8 GB de RAM (>6500 MB)
    if !(50..=6_500).contains(&size_mb) {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).ok()?;
    if &magic == b"GGUF" {
        Some(size_mb)
    } else {
        None
    }
}

fn resolve_installed_official_corvo_model(
    app_data_dir: &std::path::Path,
    db: &LocalDatabase,
) -> Option<(PathBuf, String)> {
    let models_dir = app_data_dir.join("models");
    let saved_path = db.get_kv(KV_GGUF_PATH).ok().flatten();
    let saved_sha = db.get_kv(KV_GGUF_SHA256).ok().flatten();

    // 1. Prioridade máxima: modelo próprio do Kwrl com Fine-Tune (`kwrl-lm-finetuned.gguf` ou legado `corvo-lm-finetuned.gguf`)
    let finetuned_path = if models_dir.join(FINETUNED_KWRL_MODEL_FILENAME).exists() {
        models_dir.join(FINETUNED_KWRL_MODEL_FILENAME)
    } else {
        models_dir.join(LEGACY_FINETUNED_MODEL_FILENAME)
    };
    if has_valid_gguf_header_and_size(&finetuned_path).is_some() {
        let ft_str = finetuned_path.to_string_lossy().to_string();
        if saved_path.as_deref() == Some(ft_str.as_str()) {
            if let Some(sha) = saved_sha.as_ref().filter(|s| s.len() == 64) {
                return Some((finetuned_path, sha.clone()));
            }
        }
        if let Ok(verified_hash) = crate::llm::verify_gguf_file_sha256(&finetuned_path, None) {
            let _ = db.set_kv(KV_GGUF_PATH, &ft_str);
            let _ = db.set_kv(KV_GGUF_SHA256, &verified_hash);
            return Some((finetuned_path, verified_hash));
        }
    }

    // 2. Motor oficial padrão do Kwrl (`kwrl-lm-3b-q4_k_m.gguf` ou legado `corvo-lm-3b-q4_k_m.gguf`, Apache 2.0)
    let official_path = if models_dir.join(OFFICIAL_KWRL_MODEL_FILENAME).exists() {
        models_dir.join(OFFICIAL_KWRL_MODEL_FILENAME)
    } else {
        models_dir.join(LEGACY_OFFICIAL_MODEL_FILENAME)
    };
    if has_valid_gguf_header_and_size(&official_path).is_some() {
        let off_str = official_path.to_string_lossy().to_string();
        if saved_path.as_deref() == Some(off_str.as_str())
            && saved_sha.as_deref() == Some(OFFICIAL_KWRL_MODEL_SHA256)
        {
            return Some((official_path, OFFICIAL_KWRL_MODEL_SHA256.to_string()));
        }
        if let Ok(verified_hash) =
            crate::llm::verify_gguf_file_sha256(&official_path, Some(OFFICIAL_KWRL_MODEL_SHA256))
        {
            let _ = db.set_kv(KV_GGUF_PATH, &off_str);
            let _ = db.set_kv(KV_GGUF_SHA256, &verified_hash);
            return Some((official_path, verified_hash));
        }
    }

    None
}

fn discover_local_gguf_models(app_data_dir: &std::path::Path) -> Vec<DiscoveredModelDto> {
    let models_dir = app_data_dir.join("models");
    let mut out = Vec::new();

    let finetuned_path = if models_dir.join(FINETUNED_KWRL_MODEL_FILENAME).exists() {
        models_dir.join(FINETUNED_KWRL_MODEL_FILENAME)
    } else {
        models_dir.join(LEGACY_FINETUNED_MODEL_FILENAME)
    };
    if let Some(size_mb) = has_valid_gguf_header_and_size(&finetuned_path) {
        out.push(DiscoveredModelDto {
            id: FINETUNED_KWRL_MODEL_FILENAME.into(),
            display_name: "Motor Kwrl (Fine-Tune)".into(),
            subtitle: "Afinado para português de Portugal".into(),
            path: finetuned_path.to_string_lossy().to_string(),
            size_mb,
            expected_sha256: None,
            recommended: true,
            is_general_purpose: true,
        });
        return out;
    }

    let official_path = if models_dir.join(OFFICIAL_KWRL_MODEL_FILENAME).exists() {
        models_dir.join(OFFICIAL_KWRL_MODEL_FILENAME)
    } else {
        models_dir.join(LEGACY_OFFICIAL_MODEL_FILENAME)
    };
    if let Some(size_mb) = has_valid_gguf_header_and_size(&official_path) {
        out.push(DiscoveredModelDto {
            id: OFFICIAL_KWRL_MODEL_FILENAME.into(),
            display_name: "Motor Kwrl".into(),
            subtitle: "Instalado localmente neste computador".into(),
            path: official_path.to_string_lossy().to_string(),
            size_mb,
            expected_sha256: Some(OFFICIAL_KWRL_MODEL_SHA256.into()),
            recommended: true,
            is_general_purpose: true,
        });
    }

    out
}

fn spawn_silent_official_model_bootstrap(
    app: AppHandle,
    llm: Arc<LlmSupervisor>,
    db: Arc<LocalDatabase>,
    http_client: Client,
    app_data_dir: PathBuf,
    in_flight: Arc<AtomicBool>,
) {
    if in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let dest = app_data_dir.join("models").join(OFFICIAL_KWRL_MODEL_FILENAME);
        let app_for_progress = app.clone();
        let res = llm
            .download_gguf_with_progress_and_sha256(
                &http_client,
                OFFICIAL_KWRL_MODEL_URL,
                &dest,
                OFFICIAL_KWRL_MODEL_SHA256,
                move |evt| {
                    let _ = app_for_progress.emit("ai-bootstrap-progress", &evt);
                },
            )
            .await;

        match res {
            Ok(verified_hash) => {
                let _ = db.set_kv(KV_GGUF_PATH, &dest.to_string_lossy());
                let _ = db.set_kv(KV_GGUF_SHA256, &verified_hash);
            }
            Err(err) => {
                let msg = format!(
                    "Sem ligação para concluir a preparação inicial da IA ({}). Liga-te à internet e tenta novamente.",
                    err
                );
                llm.set_bootstrap_progress("error", None, Some(msg.clone()))
                    .await;
                let _ = app.emit(
                    "ai-bootstrap-progress",
                    &AiBootstrapProgressPayload {
                        phase: "error".into(),
                        percent: None,
                        error: Some(msg),
                    },
                );
            }
        }

        in_flight.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
async fn get_bootstrap_state(state: State<'_, CorvoState>) -> Result<BootstrapStateDto, String> {
    let resolved_oauth = load_oauth_client_config(&state.db).ok();
    let oauth_client_id = resolved_oauth
        .as_ref()
        .map(|c| c.client_id.clone())
        .or_else(|| state.db.get_kv(KV_OAUTH_CLIENT_ID).ok().flatten());
    let oauth_ready = resolved_oauth.is_some() || has_oauth_client_secret_in_keychain();

    let stored_accounts = state.db.list_accounts().map_err(|e| e.to_string())?;
    let user_signature_name = state
        .db
        .get_kv(KV_USER_SIGNATURE_NAME)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            let primary_email = stored_accounts.first().map(|a| a.email.as_str()).unwrap_or("");
            crate::prompt_guard::resolve_friendly_user_name(primary_email, None)
        });

    let accounts = stored_accounts
        .into_iter()
        .map(|a| map_account_dto(a, &state.token_manager))
        .collect();

    let available_models = discover_local_gguf_models(&state.app_data_dir);

    let raw_mailboxes = state.db.get_kv(KV_CUSTOM_MAILBOXES).ok().flatten();
    let custom_mailboxes: Vec<CustomMailboxDto> = raw_mailboxes
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let ui_language = state
        .db
        .get_kv(KV_UI_LANGUAGE)
        .ok()
        .flatten()
        .unwrap_or_else(|| "en".to_string());

    Ok(BootstrapStateDto {
        oauth_client_id,
        oauth_secret_in_keychain: oauth_ready,
        accounts,
        poll_interval_secs: state.user_poll_interval_secs.load(Ordering::Relaxed),
        master_ai_kill_switch: state.master_ai_kill_switch.load(Ordering::Relaxed),
        user_signature_name,
        model_status: state.llm.status().await,
        available_models,
        custom_mailboxes,
        ui_language,
    })
}

#[tauri::command]
async fn save_oauth_client_credentials(
    state: State<'_, CorvoState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    // Permite colar diretamente o ficheiro JSON descarregado da Google Cloud Console
    if client_id.trim_start().starts_with('{') {
        let bounded_json = validate_non_null_bounded("oauth_json", &client_id, 8192)
            .map_err(|e| e.to_string())?;
        let (parsed_id, parsed_secret) = parse_google_oauth_json(bounded_json).ok_or_else(|| {
            "JSON inválido. Descarrega o JSON de um cliente do tipo 'Desktop app' na Google Cloud.".to_string()
        })?;
        return persist_oauth_client_to_keychain(&state.db, &parsed_id, &parsed_secret);
    }

    let clean_id = validate_non_null_bounded("client_id", &client_id, 512)
        .map_err(|e| e.to_string())?;
    let clean_secret = validate_non_null_bounded("client_secret", &client_secret, 512)
        .map_err(|e| e.to_string())?;

    persist_oauth_client_to_keychain(&state.db, clean_id, clean_secret)
}

#[tauri::command]
async fn start_gmail_oauth(
    app: AppHandle,
    state: State<'_, CorvoState>,
    scope_mode: GmailScopeMode,
    custom_label: Option<String>,
) -> Result<AccountViewDto, String> {
    let cfg = load_oauth_client_config(&state.db)?;
    let session = authenticate_desktop_google_account(
        &state.http_client,
        &state.token_manager,
        &cfg,
        scope_mode,
    )
    .await
    .map_err(|e| e.to_string())?;

    let label = custom_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('\0') && s.len() <= 80)
        .map(String::from)
        .unwrap_or_else(|| {
            session
                .email
                .split('@')
                .next()
                .unwrap_or(&session.email)
                .to_string()
        });

    // Regista conta sem history_id ainda para que o primeiro sync execute a recolha inicial paginada
    state
        .db
        .upsert_account(&session.email, &label, session.scope_mode, None)
        .map_err(|e| e.to_string())?;

    // Dispara sincronização inicial imediata das mensagens reais da caixa Gmail
    if let Ok(report) = state.sync_engine.sync_account(&cfg, &session.email, 250).await {
        let _ = app.emit("gmail-sync-state", &report);
    }

    let acc = state
        .db
        .get_account(&session.email)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Conta autenticada não encontrada em SQLite.".to_string())?;

    Ok(map_account_dto(acc, &state.token_manager))
}

#[tauri::command]
async fn disconnect_gmail_account(
    state: State<'_, CorvoState>,
    email: String,
) -> Result<(), String> {
    let clean_email = validate_email_address(&email).map_err(|e| e.to_string())?;
    state
        .token_manager
        .purge_account_tokens(&clean_email)
        .map_err(|e| e.to_string())?;
    state
        .db
        .remove_account(&clean_email)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn sync_gmail_now(
    app: AppHandle,
    state: State<'_, CorvoState>,
    email: Option<String>,
) -> Result<Vec<SyncReport>, String> {
    let cfg = load_oauth_client_config(&state.db)?;

    let reports = if let Some(target_email) = email {
        let clean = validate_email_address(&target_email).map_err(|e| e.to_string())?;
        let single = state
            .sync_engine
            .sync_account(&cfg, &clean, 250)
            .await
            .map_err(|e| e.to_string())?;
        vec![single]
    } else {
        state
            .sync_engine
            .run_non_overlapping_sync_all(&cfg, 250)
            .await
            .map_err(|e| e.to_string())?
    };

    for rep in &reports {
        let _ = app.emit("gmail-sync-state", rep);
    }
    Ok(reports)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    pub name: String,
    pub content_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendEmailParams {
    pub account_email: String,
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub bcc: Option<Vec<String>>,
    pub subject: String,
    pub body: String,
    pub body_html: Option<String>,
    pub thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<AttachmentPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendEmailResult {
    pub message_id: String,
    pub thread_id: String,
    pub success: bool,
}

pub fn build_rfc2822_raw_message(
    from: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body: &str,
    body_html: Option<&str>,
    in_reply_to: Option<&str>,
    references: Option<&str>,
    attachments: &[AttachmentPayload],
) -> String {
    use std::fmt::Write;
    let now_date = chrono::Utc::now().to_rfc2822();
    let rand_id = rand::random::<u64>();
    let encoded_subject = STANDARD.encode(subject.as_bytes());
    let body_b64 = STANDARD.encode(body.as_bytes());

    let est_capacity = 512 + body_b64.len() + body_html.map(|h| h.len() * 4 / 3).unwrap_or(0)
        + attachments.iter().map(|a| a.data_base64.len() + 256).sum::<usize>();
    let mut out = String::with_capacity(est_capacity);

    let _ = write!(out, "From: {}\r\nTo: {}\r\nSubject: =?UTF-8?B?{}?=\r\nDate: {}\r\nMessage-ID: <{}.kwrl@desktop>\r\n", from, to.join(", "), encoded_subject, now_date, rand_id);

    if !cc.is_empty() {
        let _ = write!(out, "Cc: {}\r\n", cc.join(", "));
    }
    if !bcc.is_empty() {
        let _ = write!(out, "Bcc: {}\r\n", bcc.join(", "));
    }

    if let Some(reply_to) = in_reply_to {
        let clean_reply = reply_to.trim();
        if !clean_reply.is_empty() {
            if clean_reply.starts_with('<') && clean_reply.ends_with('>') {
                let _ = write!(out, "In-Reply-To: {}\r\n", clean_reply);
            } else {
                let _ = write!(out, "In-Reply-To: <{}>\r\n", clean_reply);
            }
            let ref_hdr = references.unwrap_or(clean_reply).trim();
            if ref_hdr.starts_with('<') && ref_hdr.ends_with('>') {
                let _ = write!(out, "References: {}\r\n", ref_hdr);
            } else {
                let _ = write!(out, "References: <{}>\r\n", ref_hdr);
            }
        }
    }

    let _ = write!(out, "MIME-Version: 1.0\r\n");

    if attachments.is_empty() {
        if let Some(html) = body_html {
            let alt_boundary = format!("===alt_kwrl_{}===", rand::random::<u64>());
            let html_b64 = STANDARD.encode(html.as_bytes());
            let _ = write!(
                out,
                "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n--{}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}--\r\n",
                alt_boundary, alt_boundary, body_b64, alt_boundary, html_b64, alt_boundary
            );
        } else {
            let _ = write!(
                out,
                "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
                body_b64
            );
        }
    } else {
        let mixed_boundary = format!("===mixed_kwrl_{}===", rand::random::<u64>());
        let _ = write!(
            out,
            "Content-Type: multipart/mixed; boundary=\"{}\"\r\n\r\n",
            mixed_boundary
        );

        if let Some(html) = body_html {
            let alt_boundary = format!("===alt_kwrl_{}===", rand::random::<u64>());
            let html_b64 = STANDARD.encode(html.as_bytes());
            let _ = write!(
                out,
                "--{}\r\nContent-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n--{}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{}--\r\n",
                mixed_boundary, alt_boundary, alt_boundary, body_b64, alt_boundary, html_b64, alt_boundary
            );
        } else {
            let _ = write!(
                out,
                "--{}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
                mixed_boundary, body_b64
            );
        }

        for att in attachments {
            let clean_name = att.name.replace(['\r', '\n', '"'], "_");
            let ctype = if att.content_type.trim().is_empty() {
                "application/octet-stream"
            } else {
                att.content_type.trim()
            };
            let _ = write!(
                out,
                "--{}\r\nContent-Type: {}; name=\"{}\"\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
                mixed_boundary,
                ctype,
                clean_name,
                clean_name,
                att.data_base64.trim()
            );
        }

        let _ = write!(out, "--{}--\r\n", mixed_boundary);
    }

    out
}

async fn get_authenticated_bearer(
    state: &State<'_, CorvoState>,
    account_email: &str,
) -> Result<String, String> {
    let clean_email = validate_email_address(account_email).map_err(|e| e.to_string())?;
    let cfg = load_oauth_client_config(&state.db)?;
    let access_token = ensure_valid_access_token_with_endpoint(
        &state.http_client,
        "https://oauth2.googleapis.com/token",
        &state.token_manager,
        &cfg,
        &clean_email,
    )
    .await
    .map_err(|e| format!("Falha de autenticação ao comunicar com o Gmail: {}", e))?;
    Ok(access_token.as_str().to_string())
}

#[tauri::command]
async fn send_gmail_message(
    app: AppHandle,
    state: State<'_, CorvoState>,
    params: SendEmailParams,
) -> Result<SendEmailResult, String> {
    let clean_from = validate_email_address(&params.account_email).map_err(|e| e.to_string())?;

    let clean_to: Vec<String> = params
        .to
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if clean_to.is_empty() {
        return Err("Pelo menos um destinatário (Para:) é obrigatório.".into());
    }

    let clean_cc: Vec<String> = params
        .cc
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let clean_bcc: Vec<String> = params
        .bcc
        .unwrap_or_default()
        .into_iter()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect();

    let clean_subject = validate_non_null_bounded("subject", &params.subject, 500).map_err(|e| e.to_string())?;
    let clean_body = validate_non_null_bounded("body", &params.body, 1_000_000).map_err(|e| e.to_string())?;

    let clean_thread_id = match params.thread_id {
        Some(ref tid) if !tid.trim().is_empty() => {
            Some(validate_gmail_id("thread_id", tid).map_err(|e| e.to_string())?)
        }
        _ => None,
    };

    let total_attachment_bytes: usize = params
        .attachments
        .iter()
        .map(|a| a.data_base64.len())
        .sum();
    validate_attachments_total_bytes(total_attachment_bytes).map_err(|e| e.to_string())?;

    let cfg = load_oauth_client_config(&state.db)?;
    let access_token = ensure_valid_access_token_with_endpoint(
        &state.http_client,
        "https://oauth2.googleapis.com/token",
        &state.token_manager,
        &cfg,
        &clean_from,
    )
    .await
    .map_err(|e| format!("Falha de autenticação ao enviar e-mail: {}", e))?;

    let rfc2822_msg = build_rfc2822_raw_message(
        &clean_from,
        &clean_to,
        &clean_cc,
        &clean_bcc,
        &clean_subject,
        &clean_body,
        params.body_html.as_deref(),
        params.in_reply_to.as_deref(),
        params.references.as_deref(),
        &params.attachments,
    );

    let raw_base64url = URL_SAFE_NO_PAD.encode(rfc2822_msg.as_bytes());

    let mut send_payload = serde_json::json!({
        "raw": raw_base64url
    });
    if let Some(ref tid) = clean_thread_id {
        send_payload["threadId"] = serde_json::Value::String(tid.clone());
    }

    let resp = state
        .http_client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(access_token.as_str())
        .json(&send_payload)
        .send()
        .await
        .map_err(|e| format!("Erro de ligação ao contactar a API do Gmail: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("O Gmail recusou o envio (HTTP {}): {}", status, err_body));
    }

    let result_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta ilegível do Gmail: {}", e))?;

    let sent_msg_id = result_json["id"].as_str().unwrap_or("").to_string();
    let sent_thread_id = result_json["threadId"].as_str().unwrap_or("").to_string();

    let sync_engine = state.sync_engine.clone();
    let cfg_clone = cfg.clone();
    let email_clone = clean_from.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        if let Ok(rep) = sync_engine.sync_account(&cfg_clone, &email_clone, 50).await {
            let _ = app_clone.emit("gmail-sync-state", &rep);
        }
    });

    Ok(SendEmailResult {
        message_id: sent_msg_id,
        thread_id: sent_thread_id,
        success: true,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResultDto {
    pub succeeded_ids: Vec<String>,
    pub failed_ids: Vec<String>,
    pub error: Option<String>,
}

#[tauri::command]
async fn mark_threads_read_status(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
    read: bool,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let (add, rem): (&[&str], &[&str]) = if read {
        (&[], &["UNREAD"])
    } else {
        (&["UNREAD"], &[])
    };

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.modify_thread_labels_remote(cfg, email, tid, add, rem).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || -> Result<(), DbError> {
            let tids: Vec<&str> = succ_refs.iter().map(|s| s.as_str()).collect();
            db.update_threads_unread_batch(&tids, !read)?;
            let updates: Vec<(&str, &[&str], &[&str])> = tids.iter().map(|&tid| (tid, add, rem)).collect();
            db.update_threads_labels_batch(&updates)?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if let Ok(unread) = state.db.get_total_unread_count() {
            set_macos_dock_badge(unread);
        }
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn archive_threads(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.modify_thread_labels_remote(cfg, email, tid, &[], &["INBOX"]).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let updates: Vec<(&str, &[&str], &[&str])> = succ_refs
                .iter()
                .map(|tid| (tid.as_str(), [].as_slice(), ["INBOX"].as_slice()))
                .collect();
            db.update_threads_labels_batch(&updates)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn unarchive_threads(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.modify_thread_labels_remote(cfg, email, tid, &["INBOX"], &[]).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let updates: Vec<(&str, &[&str], &[&str])> = succ_refs
                .iter()
                .map(|tid| (tid.as_str(), ["INBOX"].as_slice(), [].as_slice()))
                .collect();
            db.update_threads_labels_batch(&updates)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn trash_threads(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.trash_thread_remote(cfg, email, tid).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let updates: Vec<(&str, &[&str], &[&str])> = succ_refs
                .iter()
                .map(|tid| (tid.as_str(), ["TRASH"].as_slice(), ["INBOX"].as_slice()))
                .collect();
            db.update_threads_labels_batch(&updates)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn untrash_threads(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.untrash_thread_remote(cfg, email, tid).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let updates: Vec<(&str, &[&str], &[&str])> = succ_refs
                .iter()
                .map(|tid| (tid.as_str(), ["INBOX"].as_slice(), ["TRASH"].as_slice()))
                .collect();
            db.update_threads_labels_batch(&updates)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn mark_threads_spam(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
    is_spam: bool,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let (add, rem): (&[&str], &[&str]) = if is_spam {
        (&["SPAM"], &["INBOX"])
    } else {
        (&["INBOX"], &["SPAM"])
    };

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.modify_thread_labels_remote(cfg, email, tid, add, rem).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let updates: Vec<(&str, &[&str], &[&str])> = succ_refs
                .iter()
                .map(|tid| (tid.as_str(), add, rem))
                .collect();
            db.update_threads_labels_batch(&updates)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn star_thread(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_id: String,
    starred: bool,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;
    let (add, rem): (&[&str], &[&str]) = if starred {
        (&["STARRED"], &[])
    } else {
        (&[], &["STARRED"])
    };

    let mut last_error = None;
    let mut succeeded = false;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        match state
            .sync_engine
            .modify_thread_labels_remote(&cfg, &clean_email, &thread_id, add, rem)
            .await
        {
            Ok(()) => {
                succeeded = true;
            }
            Err(e) => {
                last_error = Some(format!("Falha ao atualizar estrela no Gmail: {}", e));
            }
        }
    } else {
        succeeded = true;
    }

    if succeeded {
        let db = state.db.clone();
        let tid_clone = thread_id.clone();
        tokio::task::spawn_blocking(move || {
            db.update_thread_labels(&tid_clone, add, rem)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        Ok(MutationResultDto {
            succeeded_ids: vec![thread_id],
            failed_ids: Vec::new(),
            error: None,
        })
    } else {
        Ok(MutationResultDto {
            succeeded_ids: Vec::new(),
            failed_ids: vec![thread_id],
            error: last_error,
        })
    }
}

#[tauri::command]
async fn delete_threads_permanently(
    state: State<'_, CorvoState>,
    account_email: String,
    thread_ids: Vec<String>,
) -> Result<MutationResultDto, String> {
    let clean_email = validate_email_address(&account_email).map_err(|e| e.to_string())?;

    let mut succeeded_ids = Vec::with_capacity(thread_ids.len());
    let mut failed_ids = Vec::new();
    let mut last_error = None;

    if let Ok(cfg) = load_oauth_client_config(&state.db) {
        let futures = thread_ids.iter().map(|tid| {
            let sync = &state.sync_engine;
            let cfg = &cfg;
            let email = &clean_email;
            async move {
                let res = sync.delete_thread_remote(cfg, email, tid).await;
                (tid.clone(), res)
            }
        });
        let results = futures_util::future::join_all(futures).await;
        for (tid, res) in results {
            match res {
                Ok(()) => succeeded_ids.push(tid),
                Err(e) => {
                    failed_ids.push(tid);
                    last_error = Some(e.to_string());
                }
            }
        }
    } else {
        succeeded_ids = thread_ids.clone();
    }

    if !succeeded_ids.is_empty() {
        let db = state.db.clone();
        let succ_refs = succeeded_ids.clone();
        tokio::task::spawn_blocking(move || {
            let tids: Vec<&str> = succ_refs.iter().map(|s| s.as_str()).collect();
            db.delete_threads_local_batch(&tids)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }

    Ok(MutationResultDto {
        succeeded_ids,
        failed_ids,
        error: last_error,
    })
}

#[tauri::command]
async fn download_attachment(
    state: State<'_, CorvoState>,
    account_email: String,
    message_id: String,
    attachment_id: String,
    filename: String,
) -> Result<String, String> {
    let bearer = get_authenticated_bearer(&state, &account_email).await?;
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/attachments/{}",
        message_id, attachment_id
    );
    let resp = state
        .http_client
        .get(&url)
        .bearer_auth(&bearer)
        .send()
        .await
        .map_err(|e| format!("Erro de rede ao descarregar anexo: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Gmail API erro {}: falha ao obter anexo", resp.status()));
    }

    #[derive(Deserialize)]
    struct AttachmentResp {
        data: Option<String>,
    }

    let payload: AttachmentResp = resp
        .json()
        .await
        .map_err(|e| format!("Erro ao processar resposta do anexo: {}", e))?;

    let raw_b64 = payload.data.ok_or_else(|| "Anexo não contém dados".to_string())?;
    let clean_owned;
    let input = if raw_b64.bytes().any(|b| b.is_ascii_whitespace()) {
        clean_owned = raw_b64.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        &clean_owned[..]
    } else {
        &raw_b64[..]
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(input)
        .or_else(|_| URL_SAFE.decode(input))
        .or_else(|_| STANDARD.decode(input))
        .map_err(|e| format!("Erro ao descodificar dados do anexo: {}", e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let downloads_dir = std::path::Path::new(&home).join("Downloads");
    let _ = tokio::fs::create_dir_all(&downloads_dir).await;
    let safe_filename = filename.replace(['/', '\\', '\0'], "_");
    let file_path = downloads_dir.join(&safe_filename);

    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| format!("Erro ao guardar anexo no disco: {}", e))?;

    let path_str = file_path.to_string_lossy().to_string();
    let _ = open::that(&file_path);

    Ok(path_str)
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        open::that(&url).map_err(|e| e.to_string())
    } else {
        Err("URL inválido: apenas HTTPS e HTTP são permitidos.".to_string())
    }
}

#[tauri::command]
async fn get_known_contacts(
    state: State<'_, CorvoState>,
) -> Result<Vec<crate::db::KnownContactDto>, String> {
    state.db.list_known_contacts().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_cached_threads(
    state: State<'_, CorvoState>,
    account_email: Option<String>,
    search_query: Option<String>,
    view_filter: Option<String>,
) -> Result<Vec<ThreadListItemDto>, String> {
    let clean_acc = match account_email {
        Some(ref e) if !e.trim().is_empty() => {
            Some(validate_email_address(e).map_err(|err| err.to_string())?)
        }
        _ => None,
    };
    let clean_query =
        validate_optional_search_query(search_query.as_deref()).map_err(|e| e.to_string())?;

    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.list_threads_lightweight(
            clean_acc.as_deref(),
            clean_query.as_deref(),
            view_filter.as_deref(),
            250,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_thread_detail(
    state: State<'_, CorvoState>,
    thread_id: String,
) -> Result<ThreadOpenPayload, String> {
    let clean_tid = validate_gmail_id("thread_id", &thread_id).map_err(|e| e.to_string())?;

    // Se houver OAuth configurado, hidrata corpos completos via Gmail API; se offline, lê SQLite
    let detail = if let Ok(cfg) = load_oauth_client_config(&state.db) {
        state
            .sync_engine
            .open_thread_and_hydrate_bodies(&cfg, &clean_tid)
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .db
            .get_thread_detail(&clean_tid)
            .map_err(|e| e.to_string())?
    }
    .ok_or_else(|| "Conversa não encontrada no cache SQLite.".to_string())?;

    let (last_sender, combined_body) = format_thread_for_ai(&detail);
    let inspection = inspect_untrusted_email(&detail.subject, &combined_body);

    // Se o sidecar já estiver ativo em RAM e a conta permitir IA, pré-avalia o prefixo KV em background
    // enquanto o utilizador lê a mensagem, reduzindo o TTFT do rascunho curto para <200ms (§4.2 & §5.4).
    if !inspection.blocked && !state.master_ai_kill_switch.load(Ordering::Relaxed) {
        let acc_allows = state
            .db
            .get_account(&detail.account_email)
            .ok()
            .flatten()
            .map(|a| a.ai_enabled)
            .unwrap_or(true);
        if acc_allows {
            let llm_clone = state.llm.clone();
            let acc_clone = detail.account_email.clone();
            let subj_clone = detail.subject.clone();
            let custom_sig = state.db.get_kv(KV_USER_SIGNATURE_NAME).ok().flatten();
            tokio::spawn(async move {
                llm_clone
                    .prewarm_if_worker_resident(
                        &acc_clone,
                        &subj_clone,
                        &last_sender,
                        &combined_body,
                        custom_sig.as_deref(),
                    )
                    .await;
            });
        }
    }

    Ok(ThreadOpenPayload {
        thread: detail,
        injection_inspection: inspection,
    })
}

#[tauri::command]
async fn update_followup_status(
    state: State<'_, CorvoState>,
    thread_id: String,
    status: String,
) -> Result<(), String> {
    let clean_tid = validate_gmail_id("thread_id", &thread_id).map_err(|e| e.to_string())?;
    let clean_status =
        validate_non_null_bounded("status", &status, 32).map_err(|e| e.to_string())?;
    if !["sugerido", "agendado", "dispensado"].contains(&clean_status) {
        return Err("Estado de lembrete inválido.".into());
    }

    if let Some(detail) = state
        .db
        .get_thread_detail(&clean_tid)
        .map_err(|e| e.to_string())?
    {
        if let Some(fup) = detail.follow_up {
            state
                .db
                .upsert_followup(
                    &clean_tid,
                    &detail.account_email,
                    &fup.detected_quote,
                    &fup.suggested_when,
                    clean_status,
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn update_account_ai_policy(
    state: State<'_, CorvoState>,
    email: String,
    ai_enabled: bool,
    suggestion_trigger: String,
    auto_summarize: bool,
) -> Result<(), String> {
    let clean_email = validate_email_address(&email).map_err(|e| e.to_string())?;
    let trigger = if suggestion_trigger == "on-demand" {
        "on-demand"
    } else {
        "on-open"
    };
    state
        .db
        .update_account_policy(&clean_email, ai_enabled, trigger, auto_summarize)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_runtime_settings(
    state: State<'_, CorvoState>,
    poll_interval_secs: u64,
    master_ai_kill_switch: bool,
    context_size: u32,
    allow_ollama_fallback: bool,
    ollama_model_tag: String,
) -> Result<LocalModelStatus, String> {
    let clamped_poll = poll_interval_secs.clamp(30, 600);
    state
        .user_poll_interval_secs
        .store(clamped_poll, Ordering::Relaxed);
    state
        .sync_engine
        .set_window_focus_polling(true, clamped_poll);
    state
        .master_ai_kill_switch
        .store(master_ai_kill_switch, Ordering::Relaxed);

    let clamped_ctx = context_size.clamp(2048, 8192);
    let clean_tag = validate_non_null_bounded("ollama_model_tag", &ollama_model_tag, 128)
        .unwrap_or("phi4-mini:latest")
        .to_string();

    let _ = state
        .db
        .set_kv(KV_POLL_INTERVAL_SECS, &clamped_poll.to_string());
    let _ = state.db.set_kv(
        KV_MASTER_AI_KILL,
        if master_ai_kill_switch { "1" } else { "0" },
    );
    let _ = state.db.set_kv(KV_GGUF_CTX, &clamped_ctx.to_string());
    let _ = state.db.set_kv(
        KV_ALLOW_OLLAMA_FALLBACK,
        if allow_ollama_fallback { "1" } else { "0" },
    );
    let _ = state.db.set_kv(KV_OLLAMA_TAG, &clean_tag);

    if master_ai_kill_switch {
        state.llm.force_unload_worker().await;
    }
    state
        .llm
        .update_preferences(clamped_ctx, allow_ollama_fallback, clean_tag)
        .await;

    Ok(state.llm.status().await)
}

#[tauri::command]
async fn update_user_signature_name(
    state: State<'_, CorvoState>,
    name: String,
) -> Result<String, String> {
    let clean = name.trim().to_string();
    let validated = validate_non_null_bounded("user_signature_name", &clean, 64)
        .map_err(|e| e.to_string())?;
    let _ = state.db.set_kv(KV_USER_SIGNATURE_NAME, validated);
    Ok(validated.to_string())
}

#[tauri::command]
async fn save_ui_language(state: State<'_, CorvoState>, language: String) -> Result<String, String> {
    let lang = match language.trim().to_lowercase().as_str() {
        "pt" => "pt",
        "fr" => "fr",
        "es" => "es",
        _ => "en",
    };
    state.db.set_kv(KV_UI_LANGUAGE, lang).map_err(|e| e.to_string())?;
    Ok(lang.to_string())
}

#[tauri::command]
async fn get_ui_language(state: State<'_, CorvoState>) -> Result<String, String> {
    let lang = state
        .db
        .get_kv(KV_UI_LANGUAGE)
        .ok()
        .flatten()
        .unwrap_or_else(|| "en".to_string());
    Ok(lang)
}

#[tauri::command]
async fn register_local_gguf_model(
    state: State<'_, CorvoState>,
    model_path: String,
    expected_sha256: Option<String>,
) -> Result<LocalModelStatus, String> {
    let clean_path =
        validate_non_null_bounded("model_path", &model_path, 1024).map_err(|e| e.to_string())?;
    let clean_sha = match expected_sha256 {
        Some(ref s) if !s.trim().is_empty() => Some(
            validate_non_null_bounded("expected_sha256", s, 128)
                .map_err(|e| e.to_string())?
                .to_string(),
        ),
        _ => None,
    };

    let ctx_size = state.llm.status().await.context_size;
    let verified_hash = state
        .llm
        .register_and_verify_gguf(
            std::path::Path::new(clean_path),
            clean_sha.as_deref(),
            ctx_size,
        )
        .await
        .map_err(|e| e.to_string())?;

    let _ = state.db.set_kv(KV_GGUF_PATH, clean_path);
    let _ = state.db.set_kv(KV_GGUF_SHA256, &verified_hash);

    Ok(state.llm.status().await)
}

#[tauri::command]
async fn download_verified_gguf_model(
    state: State<'_, CorvoState>,
    download_url: String,
    file_name: String,
    expected_sha256: String,
) -> Result<LocalModelStatus, String> {
    let clean_url =
        validate_non_null_bounded("download_url", &download_url, 1024).map_err(|e| e.to_string())?;
    if !clean_url.starts_with("https://") {
        return Err("Apenas origens HTTPS verificadas são aceites para transferência de modelos.".into());
    }
    let clean_name =
        validate_non_null_bounded("file_name", &file_name, 128).map_err(|e| e.to_string())?;
    if clean_name.contains('/') || clean_name.contains('\\') || !clean_name.ends_with(".gguf") {
        return Err("Nome de ficheiro de modelo inválido (deve terminar em .gguf).".into());
    }
    let clean_sha = validate_non_null_bounded("expected_sha256", &expected_sha256, 64)
        .map_err(|e| e.to_string())?;

    let dest = state.app_data_dir.join("models").join(clean_name);
    let verified_hash = state
        .llm
        .download_gguf_with_sha256(&state.http_client, clean_url, &dest, clean_sha)
        .await
        .map_err(|e| e.to_string())?;

    let _ = state.db.set_kv(KV_GGUF_PATH, &dest.to_string_lossy());
    let _ = state.db.set_kv(KV_GGUF_SHA256, &verified_hash);

    Ok(state.llm.status().await)
}

#[tauri::command]
async fn install_recommended_model(
    app: AppHandle,
    state: State<'_, CorvoState>,
) -> Result<LocalModelStatus, String> {
    spawn_silent_official_model_bootstrap(
        app,
        state.llm.clone(),
        state.db.clone(),
        state.http_client.clone(),
        state.app_data_dir.clone(),
        state.ai_bootstrap_in_flight.clone(),
    );
    Ok(state.llm.status().await)
}

#[tauri::command]
async fn stream_cdlr_suggestion(
    app: AppHandle,
    state: State<'_, CorvoState>,
    request_id: String,
    thread_id: String,
    tier: String,
    extra_context: Option<String>,
) -> Result<InferenceCompleted, String> {
    if state.master_ai_kill_switch.load(Ordering::Relaxed) {
        return Err("Camada de IA desativada globalmente nas definições.".into());
    }

    let clean_req_id = validate_gmail_id("request_id", &request_id).map_err(|e| e.to_string())?;
    let clean_tid = validate_gmail_id("thread_id", &thread_id).map_err(|e| e.to_string())?;
    let clean_tier = validate_non_null_bounded("tier", &tier, 32).map_err(|e| e.to_string())?;
    if !["frase", "rascunho-curto", "rascunho-estruturado", "resumo-calmo"].contains(&clean_tier) {
        return Err("Nível CDLR inválido.".into());
    }

    let detail = if let Ok(cfg) = load_oauth_client_config(&state.db) {
        state
            .sync_engine
            .open_thread_and_hydrate_bodies(&cfg, &clean_tid)
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .db
            .get_thread_detail(&clean_tid)
            .map_err(|e| e.to_string())?
    }
    .ok_or_else(|| "Conversa não encontrada.".to_string())?;

    if let Some(acc) = state
        .db
        .get_account(&detail.account_email)
        .map_err(|e| e.to_string())?
    {
        if !acc.ai_enabled {
            return Err(format!(
                "IA desativada por política na conta {}.",
                detail.account_email
            ));
        }
    }

    let (last_sender, combined_body) = format_thread_for_ai(&detail);
    let custom_sig = state.db.get_kv(KV_USER_SIGNATURE_NAME).ok().flatten();

    state
        .llm
        .stream_email_assistance_for_account_with_context(
            &clean_req_id,
            &clean_tid,
            clean_tier,
            &detail.account_email,
            &detail.subject,
            &last_sender,
            &combined_body,
            custom_sig.as_deref(),
            extra_context.as_deref(),
            move |token_evt| {
                let _ = app.emit("ai-token", &token_evt);
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rewrite_text_with_ai(
    app: AppHandle,
    state: State<'_, CorvoState>,
    request_id: String,
    text: String,
    action: String,
    recipient: Option<String>,
    target_lang: Option<String>,
    custom_instruction: Option<String>,
) -> Result<InferenceCompleted, String> {
    if state.master_ai_kill_switch.load(Ordering::Relaxed) {
        return Err("Camada de IA desativada globalmente nas definições.".into());
    }
    let clean_text = validate_non_null_bounded("text", &text, MAX_REWRITE_TEXT_LEN)
        .map_err(|e| e.to_string())?;
    let clean_action = validate_non_null_bounded("action", &action, 64)
        .map_err(|e| e.to_string())?;
    let req_id_clean = if request_id.trim().is_empty() {
        format!(
            "req_txt_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    } else {
        request_id
    };

    let user_sig = state
        .db
        .get_kv(KV_USER_SIGNATURE_NAME)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            let primary_email = state
                .db
                .list_accounts()
                .ok()
                .and_then(|accs| accs.into_iter().next().map(|a| a.email))
                .unwrap_or_default();
            crate::prompt_guard::resolve_friendly_user_name(&primary_email, None)
        });

    state
        .llm
        .stream_text_ai_action(
            &req_id_clean,
            clean_text,
            clean_action,
            recipient.as_deref(),
            Some(&user_sig),
            target_lang.as_deref(),
            custom_instruction.as_deref(),
            move |token_evt| {
                let _ = app.emit("ai-token", &token_evt);
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientVerificationResult {
    pub allowed: bool,
    pub reason: String,
}

/// Verificador determinístico de destinatários (§2.3 Allowlist de Destinatários).
#[tauri::command]
async fn verify_recipient_allowlist(
    state: State<'_, CorvoState>,
    recipient_email: String,
    manually_confirmed_by_human: bool,
) -> Result<RecipientVerificationResult, String> {
    let clean_email = validate_email_address(&recipient_email).map_err(|e| e.to_string())?;
    let in_contacts = state
        .db
        .is_recipient_allowlisted(&clean_email)
        .map_err(|e| e.to_string())?;

    if in_contacts {
        return Ok(RecipientVerificationResult {
            allowed: true,
            reason: "Destinatário presente nos contactos verificados desta conta.".into(),
        });
    }

    if manually_confirmed_by_human {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        state
            .db
            .add_manual_trusted_contact(&clean_email, &clean_email, now)
            .map_err(|e| e.to_string())?;
        return Ok(RecipientVerificationResult {
            allowed: true,
            reason: "Destinatário confirmado manualmente pelo utilizador e registado na allowlist.".into(),
        });
    }

    Ok(RecipientVerificationResult {
        allowed: false,
        reason: "Destinatário desconhecido fora da allowlist — exige introdução/confirmação manual explícita.".into(),
    })
}

#[tauri::command]
async fn get_custom_mailboxes(
    state: State<'_, CorvoState>,
) -> Result<Vec<CustomMailboxDto>, String> {
    let raw = state.db.get_kv(KV_CUSTOM_MAILBOXES).map_err(|e| e.to_string())?;
    match raw {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).map_err(|e| format!("Erro ao carregar caixas: {}", e))
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
async fn save_custom_mailboxes(
    state: State<'_, CorvoState>,
    mailboxes: Vec<CustomMailboxDto>,
) -> Result<(), String> {
    let json = serde_json::to_string(&mailboxes).map_err(|e| e.to_string())?;
    state
        .db
        .set_kv(KV_CUSTOM_MAILBOXES, &json)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn show_macos_notification(title: &str, subtitle: &str, body: &str) {
    let clean_title = title.replace('"', "\\\"");
    let clean_subtitle = subtitle.replace('"', "\\\"");
    let clean_body = body.replace('"', "\\\"");
    let script = format!(
        "display notification \"{}\" with title \"{}\" subtitle \"{}\" sound name \"Subtle\"",
        clean_body, clean_title, clean_subtitle
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn show_macos_notification(_title: &str, _subtitle: &str, _body: &str) {}

#[cfg(target_os = "macos")]
pub fn set_macos_dock_badge(count: i64) {
    let badge_str = if count > 0 { count.to_string() } else { String::new() };
    let script = format!(
        "tell application \"System Events\" to set badge label of first process whose bundle identifier is \"app.kwrl.mail\" to \"{}\"",
        badge_str
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn set_macos_dock_badge(_count: i64) {}

#[tauri::command]
async fn search_messages_fts(
    state: State<'_, CorvoState>,
    query: String,
    account_email: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ThreadListItemDto>, String> {
    let clean_q = query.trim().to_string();
    if clean_q.is_empty() {
        return Ok(Vec::new());
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.search_threads_fts(&clean_q, account_email.as_deref(), limit.unwrap_or(50))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_thread_eml(
    state: State<'_, CorvoState>,
    thread_id: String,
) -> Result<String, String> {
    let detail = state
        .db
        .get_thread_detail(&thread_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Conversa não encontrada.".to_string())?;

    let downloads_dir = if let Some(home) = std::env::var_os("HOME") {
        let dl = std::path::PathBuf::from(home).join("Downloads");
        if dl.exists() {
            dl
        } else {
            std::env::temp_dir()
        }
    } else {
        std::env::temp_dir()
    };

    let safe_subject: String = detail
        .subject
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(50)
        .collect();
    let short_id = if thread_id.len() > 8 { &thread_id[..8] } else { &thread_id };
    let filename = format!("Kwrl_{}_{}.eml", safe_subject, short_id);
    let target_path = downloads_dir.join(filename);

    let mut content = String::with_capacity(8192);
    for (idx, msg) in detail.messages.iter().enumerate() {
        if idx > 0 {
            content.push_str("\r\n---\r\n\r\n");
        }
        content.push_str(&format!("From: {} <{}>\r\n", msg.sender_name, msg.sender_email));
        content.push_str(&format!("To: {}\r\n", msg.to_header));
        content.push_str(&format!("Date: {}\r\n", msg.display_date));
        content.push_str(&format!("Subject: {}\r\n", detail.subject));
        content.push_str(&format!("Message-ID: <{}>\r\n", msg.id));
        content.push_str("MIME-Version: 1.0\r\n");
        content.push_str("Content-Type: text/plain; charset=utf-8\r\n");
        content.push_str("Content-Transfer-Encoding: 8bit\r\n");
        if let Some(unsub) = &msg.list_unsubscribe {
            content.push_str(&format!("List-Unsubscribe: {}\r\n", unsub));
        }
        content.push_str("\r\n");
        if let Some(body) = &msg.body_plain {
            content.push_str(body);
        } else {
            content.push_str(&msg.snippet);
        }
        content.push_str("\r\n");
    }

    std::fs::write(&target_path, content.as_bytes())
        .map_err(|e| format!("Falha ao gravar ficheiro .eml: {}", e))?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn add_custom_account(
    _state: State<'_, CorvoState>,
    _email: String,
    _label: String,
    provider: String,
) -> Result<AccountViewDto, String> {
    let prov = if provider.trim().is_empty() { "Outlook" } else { provider.trim() };
    Err(format!(
        "O fornecedor '{prov}' ainda não está suportado nativamente. De momento, o Kwrl opera em exclusivo com contas Google / Gmail através de autenticação oficial OAuth 2.0 PKCE."
    ))
}

fn migrate_legacy_corvo_data(app_data_dir: &std::path::Path) {
    let new_db = app_data_dir.join("kwrl_cache.sqlite3");
    let legacy_db_current = app_data_dir.join("corvo_cache.sqlite3");

    // 1. Se existir corvo_cache.sqlite3 dentro da diretoria atual e kwrl_cache.sqlite3 ainda não existir:
    if !new_db.exists() && legacy_db_current.exists() {
        let _ = std::fs::copy(&legacy_db_current, &new_db);
    }

    // 2. Se a diretoria do SO anterior (pt.corvo.mail) existir, migrar dados:
    if let Some(parent) = app_data_dir.parent() {
        let legacy_data_dir = parent.join("pt.corvo.mail");
        if legacy_data_dir.exists() && legacy_data_dir.is_dir() {
            let legacy_db = legacy_data_dir.join("corvo_cache.sqlite3");
            if !new_db.exists() && legacy_db.exists() {
                let _ = std::fs::copy(&legacy_db, &new_db);
            }
            let legacy_models = legacy_data_dir.join("models");
            let new_models = app_data_dir.join("models");
            if legacy_models.exists() && legacy_models.is_dir() {
                let _ = std::fs::create_dir_all(&new_models);
                if let Ok(entries) = std::fs::read_dir(&legacy_models) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            let file_name = entry.file_name();
                            let dest_file = new_models.join(&file_name);
                            if !dest_file.exists() {
                                let _ = std::fs::copy(&path, &dest_file);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Renomear/copiar modelos legados locais para os novos nomes oficiais
    let models_dir = app_data_dir.join("models");
    let legacy_official = models_dir.join(LEGACY_OFFICIAL_MODEL_FILENAME);
    let new_official = models_dir.join(OFFICIAL_KWRL_MODEL_FILENAME);
    if !new_official.exists() && legacy_official.exists() {
        let _ = std::fs::copy(&legacy_official, &new_official);
    }
    let legacy_finetuned = models_dir.join(LEGACY_FINETUNED_MODEL_FILENAME);
    let new_finetuned = models_dir.join(FINETUNED_KWRL_MODEL_FILENAME);
    if !new_finetuned.exists() && legacy_finetuned.exists() {
        let _ = std::fs::copy(&legacy_finetuned, &new_finetuned);
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| PathBuf::from("./kwrl-data"));
            let _ = std::fs::create_dir_all(&app_data_dir);

            // Migração transparente de dados do Corvo para o Kwrl (zero perda de dados)
            migrate_legacy_corvo_data(&app_data_dir);

            let db_path = app_data_dir.join("kwrl_cache.sqlite3");
            let db = Arc::new(
                LocalDatabase::open(&db_path)
                    .expect("Falha crítica ao abrir base de dados SQLite local do Kwrl"),
            );

            let poll_secs: u64 = db
                .get_kv(KV_POLL_INTERVAL_SECS)
                .ok()
                .flatten()
                .and_then(|s| s.parse().ok())
                .unwrap_or(75)
                .clamp(30, 600);

            let kill_switch = db
                .get_kv(KV_MASTER_AI_KILL)
                .ok()
                .flatten()
                .map(|v| v == "1")
                .unwrap_or(false);

            let ctx_size: u32 = db
                .get_kv(KV_GGUF_CTX)
                .ok()
                .flatten()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_CONTEXT_WINDOW)
                .clamp(2048, 8192);

            let allow_ollama = db
                .get_kv(KV_ALLOW_OLLAMA_FALLBACK)
                .ok()
                .flatten()
                .map(|v| v == "1")
                .unwrap_or(false);

            let ollama_tag = db
                .get_kv(KV_OLLAMA_TAG)
                .ok()
                .flatten()
                .unwrap_or_else(|| "phi4-mini:latest".into());

            let resolved_official = resolve_installed_official_corvo_model(&app_data_dir, &db);
            let (saved_gguf, saved_sha, initial_phase, initial_pct) = match resolved_official {
                Some((path, sha)) => (Some(path), Some(sha), "ready".to_string(), Some(100)),
                None if kill_switch => (None, None, "idle".to_string(), None),
                None => (None, None, "downloading".to_string(), Some(0)),
            };

            let http_client = build_gmail_http_client()
                .expect("Falha ao inicializar cliente TLS reqwest");
            let token_manager = TokenManager::new_os_keychain();
            let sync_engine = Arc::new(GmailSyncEngine::new(
                http_client.clone(),
                db.clone(),
                token_manager.clone(),
            ));
            sync_engine.set_window_focus_polling(true, poll_secs);

            // Lazy Loading (§4.3): apenas regista metadados em memória; NÃO carrega tensores no arranque!
            let llm_supervisor = LlmSupervisor::new(ModelRuntimeConfig {
                model_path: saved_gguf.clone(),
                verified_sha256: saved_sha,
                context_size: ctx_size,
                allow_ollama_fallback: allow_ollama,
                ollama_model_tag: ollama_tag,
                bootstrap_phase: initial_phase,
                bootstrap_percent: initial_pct,
                bootstrap_error: None,
            });

            let ai_bootstrap_in_flight = Arc::new(AtomicBool::new(false));
            // Se for o 1.º arranque neste computador, inicia transferência silenciosa automática do motor único do Kwrl
            if saved_gguf.is_none() && !kill_switch {
                spawn_silent_official_model_bootstrap(
                    app.handle().clone(),
                    llm_supervisor.clone(),
                    db.clone(),
                    http_client.clone(),
                    app_data_dir.clone(),
                    ai_bootstrap_in_flight.clone(),
                );
            }

            let user_poll_arc = Arc::new(AtomicU64::new(poll_secs));

            // Timer reativo de polling incremental history.list no backend Rust (§1.4)
            let bg_db = db.clone();
            let bg_sync = sync_engine.clone();
            let bg_handle = app.handle().clone();
            let poll_notify = bg_sync.poll_notify();
            tauri::async_runtime::spawn(async move {
                loop {
                    let target_interval = bg_sync.current_poll_interval_secs();
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(target_interval)) => {},
                        _ = poll_notify.notified() => {},
                    }
                    if let Ok(cfg) = load_oauth_client_config(&bg_db) {
                        match bg_sync.run_non_overlapping_sync_all(&cfg, 250).await {
                            Ok(reports) => {
                                for rep in &reports {
                                    if rep.added_messages > 0 || rep.deleted_messages > 0 {
                                        let _ = bg_handle.emit("gmail-sync-state", rep);
                                    }
                                }
                                if let Ok(unread) = bg_db.get_total_unread_count() {
                                    set_macos_dock_badge(unread);
                                }
                            }
                            Err(e) => {
                                let err_str = e.to_string();
                                let is_auth = err_str.contains("OAuth")
                                    || err_str.contains("autenticação")
                                    || err_str.contains("revoked")
                                    || err_str.contains("expired");
                                let is_quota = err_str.contains("Quota") || err_str.contains("429");
                                let _ = bg_handle.emit(
                                    "gmail-sync-error",
                                    &serde_json::json!({
                                        "error": err_str,
                                        "isAuthError": is_auth,
                                        "isQuotaError": is_quota,
                                    }),
                                );
                            }
                        }
                    }
                }
            });

            app.manage(CorvoState {
                db,
                token_manager,
                sync_engine,
                llm: llm_supervisor,
                http_client,
                app_data_dir,
                user_poll_interval_secs: user_poll_arc,
                master_ai_kill_switch: Arc::new(AtomicBool::new(kill_switch)),
                ai_bootstrap_in_flight,
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Adapta cadência de polling (30s focado / 300s segundo plano, §1.4)
            if let WindowEvent::Focused(focused) = event {
                let state = window.state::<CorvoState>();
                let user_base = state.user_poll_interval_secs.load(Ordering::Relaxed);
                state
                    .sync_engine
                    .set_window_focus_polling(*focused, user_base);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_state,
            save_oauth_client_credentials,
            start_gmail_oauth,
            disconnect_gmail_account,
            sync_gmail_now,
            list_cached_threads,
            open_thread_detail,
            update_followup_status,
            update_account_ai_policy,
            update_runtime_settings,
            update_user_signature_name,
            register_local_gguf_model,
            download_verified_gguf_model,
            install_recommended_model,
            stream_cdlr_suggestion,
            verify_recipient_allowlist,
            send_gmail_message,
            get_custom_mailboxes,
            save_custom_mailboxes,
            mark_threads_read_status,
            archive_threads,
            unarchive_threads,
            trash_threads,
            untrash_threads,
            mark_threads_spam,
            star_thread,
            delete_threads_permanently,
            download_attachment,
            get_known_contacts,
            rewrite_text_with_ai,
            search_messages_fts,
            export_thread_eml,
            add_custom_account,
            open_external_url,
            save_ui_language,
            get_ui_language,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao executar a aplicação desktop Kwrl");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_discovery_ranks_general_purpose_gguf_and_ignores_non_gguf() {
        let tmp = tempfile::tempdir().unwrap();
        let models_dir = tmp.path().join("models");
        std::fs::create_dir_all(&models_dir).unwrap();

        // Ficheiro inválido / pequeno deve ser ignorado
        std::fs::write(models_dir.join("broken.gguf"), b"NOT_GGUF").unwrap();

        let found = discover_local_gguf_models(tmp.path());
        assert!(!found.iter().any(|m| m.id == "broken.gguf"));

        // Se o sistema anfitrião tiver modelos Ollama locais, o primeiro deve ser marcado como recomendado
        if let Some(first) = found.first() {
            assert!(first.recommended);
            assert!(std::path::Path::new(&first.path).exists());
        }
    }

    #[test]
    fn build_rfc2822_raw_message_formats_plain_and_attachments() {
        let msg_plain = build_rfc2822_raw_message(
            "sender@test.com",
            &["recipient@test.com".to_string()],
            &["cc1@test.com".to_string()],
            &[],
            "Assunto de teste",
            "Corpo da mensagem com acentuação e pontuação.",
            None,
            Some("msg-1234@domain.com"),
            None,
            &[],
        );
        assert!(msg_plain.contains("From: sender@test.com"));
        assert!(msg_plain.contains("To: recipient@test.com"));
        assert!(msg_plain.contains("Cc: cc1@test.com"));
        assert!(msg_plain.contains("In-Reply-To: <msg-1234@domain.com>"));
        assert!(msg_plain.contains("References: <msg-1234@domain.com>"));
        assert!(msg_plain.contains("Content-Type: text/plain; charset=UTF-8"));

        let atts = vec![AttachmentPayload {
            name: "relatorio_final.pdf".to_string(),
            content_type: "application/pdf".to_string(),
            data_base64: "JVBERi0xLjQK...".to_string(),
        }];
        let msg_multipart = build_rfc2822_raw_message(
            "sender@test.com",
            &["recipient@test.com".to_string()],
            &[],
            &[],
            "Segue o relatório",
            "Segue em anexo o documento em PDF solicitado.",
            Some("<p>Segue em anexo o documento em PDF solicitado.</p>"),
            None,
            None,
            &atts,
        );
        assert!(msg_multipart.contains("multipart/mixed; boundary="));
        assert!(msg_multipart.contains("multipart/alternative; boundary="));
        assert!(msg_multipart.contains("Content-Disposition: attachment; filename=\"relatorio_final.pdf\""));
        assert!(msg_multipart.contains("application/pdf"));
        assert!(msg_multipart.contains("JVBERi0xLjQK..."));
    }
}
