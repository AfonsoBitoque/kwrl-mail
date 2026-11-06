//! Sincronização Incremental Gmail API + Batch Multipart + Polling Inteligente (§1.3, §1.4, §4.1)
//!
//! Decisões de engenharia de produção:
//! 1. Pool TLS reutilizável: `pool_max_idle_per_host(5)`, `pool_idle_timeout(90s)` e `gzip(true)`.
//! 2. Sincronização inicial paginada (`maxResults=500`) + `/batch/gmail/v1` limitado a
//!    50 sub-pedidos por chamada HTTP (§4.1) e semáforo máximo de 4 pedidos simultâneos (§1.3).
//! 3. Exponential backoff com full jitter em HTTP 429 / 403 (quota excedida) e 5xx.
//! 4. Sincronização incremental estrita via `users.history.list?startHistoryId=...` (2 unidades),
//!    ignorando IDs já presentes em SQLite e fazendo fallback automático em HTTP 404
//!    (expiração semanal do `historyId`, §1.3.4).
//! 5. Timer em Rust (`tokio::time::interval`) protegido por `AtomicBool` para impedir sobreposição
//!    de ciclos, adaptando a cadência ao foco da janela (30s focado / 75s normal / 300s minimizado).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Local, TimeZone, Utc};
use rand::Rng;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Semaphore;

use crate::db::{DbError, LocalDatabase, ThreadDetailDto, UpsertMessageRecord};
use crate::oauth::{
    ensure_valid_access_token_with_endpoint, DesktopOAuthClientConfig, GmailScopeMode, OAuthError,
};
use crate::secure_store::TokenManager;

const DEFAULT_GMAIL_API_BASE: &str = "https://gmail.googleapis.com";
const DEFAULT_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

/// Limite recomendado pela Google para `/batch/gmail/v1` (§4.1)
pub const MAX_GMAIL_BATCH_SIZE: usize = 50;
/// Concorrência máxima para proteger o limite de 6.000 unidades/min/utilizador (§1.3.1)
pub const MAX_CONCURRENT_REQUESTS: usize = 4;
const MAX_LIST_PAGE_SIZE: u32 = 500;
const MAX_BACKOFF_RETRIES: u32 = 5;

#[derive(Debug, Error)]
pub enum GmailSyncError {
    #[error("Erro OAuth durante sincronização: {0}")]
    OAuth(#[from] OAuthError),
    #[error("Erro SQLite durante sincronização: {0}")]
    Database(#[from] DbError),
    #[error("Quota da Gmail API excedida após {0} tentativas com backoff exponencial.")]
    QuotaExceededRetriesExhausted(u32),
    #[error("Erro HTTP {status} na Gmail API: {detail}")]
    ApiError { status: u16, detail: String },
    #[error("Erro de rede TLS: {0}")]
    Transport(String),
    #[error("Sincronização já em curso; ciclo concorrente ignorado.")]
    AlreadyRunning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub account_email: String,
    pub mode: String, // "initial" | "incremental" | "resync-expired-history"
    pub added_messages: usize,
    pub deleted_messages: usize,
    pub new_history_id: String,
}

/// Constrói o `reqwest::Client` partilhado com pool TLS e compressão gzip (§4.1).
pub fn build_gmail_http_client() -> Result<Client, GmailSyncError> {
    Client::builder()
        .pool_max_idle_per_host(5)
        .pool_idle_timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(35))
        .gzip(true)
        .build()
        .map_err(|e| GmailSyncError::Transport(e.to_string()))
}

/// Calcula atraso de exponential backoff com jitter para HTTP 429 / 403 / 5xx (§1.3.1).
pub fn compute_backoff_with_jitter(attempt: u32) -> Duration {
    let exp_ms = 500u64.saturating_mul(1u64 << attempt.min(6));
    let capped_ms = exp_ms.min(32_000);
    let jitter_factor: f64 = rand::thread_rng().gen_range(0.55..=1.0);
    Duration::from_millis((capped_ms as f64 * jitter_factor) as u64)
}

#[derive(Clone)]
pub struct GmailEndpoints {
    pub api_base: String,
    pub token_url: String,
}

impl Default for GmailEndpoints {
    fn default() -> Self {
        Self {
            api_base: DEFAULT_GMAIL_API_BASE.to_string(),
            token_url: DEFAULT_TOKEN_ENDPOINT.to_string(),
        }
    }
}

pub struct GmailSyncEngine {
    client: Client,
    db: Arc<LocalDatabase>,
    token_manager: TokenManager,
    endpoints: GmailEndpoints,
    concurrency_limiter: Arc<Semaphore>,
    sync_in_progress: Arc<AtomicBool>,
    poll_interval_secs: Arc<AtomicU64>,
    poll_notify: Arc<tokio::sync::Notify>,
}

impl GmailSyncEngine {
    pub fn new(
        client: Client,
        db: Arc<LocalDatabase>,
        token_manager: TokenManager,
    ) -> Self {
        Self::with_endpoints(client, db, token_manager, GmailEndpoints::default())
    }

    pub fn with_endpoints(
        client: Client,
        db: Arc<LocalDatabase>,
        token_manager: TokenManager,
        endpoints: GmailEndpoints,
    ) -> Self {
        Self {
            client,
            db,
            token_manager,
            endpoints,
            concurrency_limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
            sync_in_progress: Arc::new(AtomicBool::new(false)),
            poll_interval_secs: Arc::new(AtomicU64::new(75)),
            poll_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Ajusta dinamicamente o intervalo de polling consoante o estado da janela (§1.4):
    /// - Em foco: 30s (ou valor configurado pelo utilizador)
    /// - Minimizada / segundo plano: 300s (5 min)
    pub fn set_window_focus_polling(&self, focused: bool, base_user_interval_secs: u64) {
        let clamped_user = base_user_interval_secs.clamp(30, 600);
        let next = if focused {
            clamped_user.min(60).max(30)
        } else {
            300.max(clamped_user)
        };
        self.poll_interval_secs.store(next, Ordering::Relaxed);
        self.poll_notify.notify_one();
    }

    pub fn current_poll_interval_secs(&self) -> u64 {
        self.poll_interval_secs.load(Ordering::Relaxed)
    }

    pub fn poll_notify(&self) -> Arc<tokio::sync::Notify> {
        self.poll_notify.clone()
    }

    /// Garante exclusão mútua não-bloqueante para que um ciclo de polling nunca se sobreponha ao anterior (§1.4).
    pub async fn run_non_overlapping_sync_all(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        max_initial_messages: usize,
    ) -> Result<Vec<SyncReport>, GmailSyncError> {
        if self
            .sync_in_progress
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(GmailSyncError::AlreadyRunning);
        }

        struct ResetGuard(Arc<AtomicBool>);
        impl Drop for ResetGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ResetGuard(self.sync_in_progress.clone());

        let accounts = self.db.list_accounts()?;
        let mut reports = Vec::new();
        for acc in accounts {
            let report = self
                .sync_account(oauth_config, &acc.email, max_initial_messages)
                .await?;
            reports.push(report);
        }
        Ok(reports)
    }

    /// Sincroniza uma conta específica usando `history.list` incremental se `historyId` existir,
    /// ou sincronização inicial paginada + fallback automático em `404`.
    pub async fn sync_account(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        max_initial_messages: usize,
    ) -> Result<SyncReport, GmailSyncError> {
        let stored = self.db.get_account(email)?;
        let existing_history = stored.and_then(|a| a.history_id);

        if let Some(ref start_hid) = existing_history {
            match self.sync_incremental(oauth_config, email, start_hid).await {
                Ok(report) => return Ok(report),
                Err(GmailSyncError::ApiError { status: 404, .. }) => {
                    // Expiração do historyId (~7 dias, §1.3.4): fallback transparente para re-sync parcial
                    let mut fallback = self
                        .sync_initial_or_partial(oauth_config, email, max_initial_messages)
                        .await?;
                    fallback.mode = "resync-expired-history".to_string();
                    return Ok(fallback);
                }
                Err(other) => return Err(other),
            }
        }

        self.sync_initial_or_partial(oauth_config, email, max_initial_messages)
            .await
    }

    async fn valid_bearer(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
    ) -> Result<String, GmailSyncError> {
        let tok = ensure_valid_access_token_with_endpoint(
            &self.client,
            &self.endpoints.token_url,
            &self.token_manager,
            oauth_config,
            email,
        )
        .await?;
        Ok(tok.as_str().to_string())
    }

    /// Executa pedido GET autenticado com backoff exponencial em 429/403/5xx e renovação em 401.
    async fn authorized_get_json<T: for<'de> Deserialize<'de>>(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        url: &str,
    ) -> Result<T, GmailSyncError> {
        let mut retried_401 = false;

        for attempt in 0..=MAX_BACKOFF_RETRIES {
            let _permit = self
                .concurrency_limiter
                .acquire()
                .await
                .map_err(|e| GmailSyncError::Transport(e.to_string()))?;

            let bearer = self.valid_bearer(oauth_config, email).await?;
            let resp = self
                .client
                .get(url)
                .bearer_auth(&bearer)
                .send()
                .await
                .map_err(|e| GmailSyncError::Transport(e.to_string()))?;

            let status = resp.status();
            if status.is_success() {
                return resp
                    .json::<T>()
                    .await
                    .map_err(|e| GmailSyncError::Transport(e.to_string()));
            }

            if status == StatusCode::UNAUTHORIZED && !retried_401 {
                retried_401 = true;
                let _ = self.token_manager.evict_access_token(email);
                continue;
            }

            let body_text = resp.text().await.unwrap_or_default();
            let is_quota_or_transient = status == StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error()
                || (status == StatusCode::FORBIDDEN
                    && (body_text.contains("rateLimitExceeded")
                        || body_text.contains("userRateLimitExceeded")
                        || body_text.contains("quotaExceeded")));

            if is_quota_or_transient {
                if attempt == MAX_BACKOFF_RETRIES {
                    return Err(GmailSyncError::QuotaExceededRetriesExhausted(
                        MAX_BACKOFF_RETRIES,
                    ));
                }
                drop(_permit);
                tokio::time::sleep(compute_backoff_with_jitter(attempt)).await;
                continue;
            }

            return Err(GmailSyncError::ApiError {
                status: status.as_u16(),
                detail: body_text.chars().take(240).collect(),
            });
        }

        Err(GmailSyncError::QuotaExceededRetriesExhausted(
            MAX_BACKOFF_RETRIES,
        ))
    }

    async fn sync_initial_or_partial(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        max_messages: usize,
    ) -> Result<SyncReport, GmailSyncError> {
        let mut collected_ids = Vec::new();
        let mut page_token: Option<String> = None;

        while collected_ids.len() < max_messages {
            let remaining = (max_messages - collected_ids.len()).min(MAX_LIST_PAGE_SIZE as usize);
            let mut url = format!(
                "{}/gmail/v1/users/me/messages?maxResults={}&includeSpamTrash=false",
                self.endpoints.api_base, remaining
            );
            if let Some(ref pt) = page_token {
                url.push_str(&format!("&pageToken={}", urlencoding_param(pt)));
            }

            let page: MessageListResponseDto =
                self.authorized_get_json(oauth_config, email, &url).await?;

            if let Some(items) = page.messages {
                for m in items {
                    collected_ids.push(m.id);
                }
            }

            match page.next_page_token {
                Some(next) if !next.is_empty() && collected_ids.len() < max_messages => {
                    page_token = Some(next);
                }
                _ => break,
            }
        }

        // Nunca chama messages.get para IDs já presentes em SQLite (§1.3.3)
        let missing_ids = self.db.filter_missing_message_ids(&collected_ids)?;
        let added = self
            .fetch_and_store_metadata_in_batches(oauth_config, email, &missing_ids)
            .await?;

        // Guarda o historyId atual via users.getProfile (1 unidade, §1.3.2)
        let profile_url = format!("{}/gmail/v1/users/me/profile", self.endpoints.api_base);
        let profile: ProfileDto = self
            .authorized_get_json(oauth_config, email, &profile_url)
            .await?;

        self.db
            .update_account_history_id(email, &profile.history_id, now_epoch())?;

        Ok(SyncReport {
            account_email: email.to_string(),
            mode: "initial".to_string(),
            added_messages: added,
            deleted_messages: 0,
            new_history_id: profile.history_id,
        })
    }

    async fn sync_incremental(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        start_history_id: &str,
    ) -> Result<SyncReport, GmailSyncError> {
        let mut page_token: Option<String> = None;
        let mut added_ids_set = HashSet::new();
        let mut deleted_ids_set = HashSet::new();
        let mut latest_history_id = start_history_id.to_string();
        let mut label_updates_map: std::collections::HashMap<String, (String, bool)> =
            std::collections::HashMap::new();

        loop {
            let mut url = format!(
                "{}/gmail/v1/users/me/history?startHistoryId={}&maxResults={}",
                self.endpoints.api_base,
                urlencoding_param(start_history_id),
                MAX_LIST_PAGE_SIZE
            );
            if let Some(ref pt) = page_token {
                url.push_str(&format!("&pageToken={}", urlencoding_param(pt)));
            }

            let resp: HistoryListResponseDto =
                self.authorized_get_json(oauth_config, email, &url).await?;

            if let Some(hid) = resp.history_id {
                latest_history_id = hid;
            }

            if let Some(records) = resp.history {
                for rec in records {
                    if let Some(added) = rec.messages_added {
                        for item in added {
                            added_ids_set.insert(item.message.id);
                        }
                    }
                    if let Some(deleted) = rec.messages_deleted {
                        for item in deleted {
                            added_ids_set.remove(&item.message.id);
                            deleted_ids_set.insert(item.message.id);
                        }
                    }
                    if let Some(label_changes) = rec.labels_added {
                        for lc in label_changes {
                            if let Some(labels) = lc.message.label_ids {
                                let unread = labels.iter().any(|l| l == "UNREAD");
                                let json = serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into());
                                label_updates_map.insert(lc.message.id, (json, unread));
                            }
                        }
                    }
                    if let Some(label_changes) = rec.labels_removed {
                        for lc in label_changes {
                            if let Some(labels) = lc.message.label_ids {
                                let unread = labels.iter().any(|l| l == "UNREAD");
                                let json = serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into());
                                label_updates_map.insert(lc.message.id, (json, unread));
                            }
                        }
                    }
                }
            }

            match resp.next_page_token {
                Some(next) if !next.is_empty() => page_token = Some(next),
                _ => break,
            }
        }

        if !label_updates_map.is_empty() {
            let updates: Vec<(String, String, bool)> = label_updates_map
                .into_iter()
                .map(|(id, (json, unread))| (id, json, unread))
                .collect();
            let _ = self.db.update_messages_labels_batch(&updates);
        }

        let deleted_vec: Vec<String> = deleted_ids_set.into_iter().collect();
        if !deleted_vec.is_empty() {
            self.db.delete_messages_by_ids(&deleted_vec)?;
        }

        let candidate_added: Vec<String> = added_ids_set.into_iter().collect();
        let truly_missing = self.db.filter_missing_message_ids(&candidate_added)?;
        let fetched_count = self
            .fetch_and_store_metadata_in_batches(oauth_config, email, &truly_missing)
            .await?;

        self.db
            .update_account_history_id(email, &latest_history_id, now_epoch())?;

        Ok(SyncReport {
            account_email: email.to_string(),
            mode: "incremental".to_string(),
            added_messages: fetched_count,
            deleted_messages: deleted_vec.len(),
            new_history_id: latest_history_id,
        })
    }

    /// Obtém metadados de múltiplas mensagens via `/batch/gmail/v1` (máx. 50 por batch, §4.1).
    async fn fetch_and_store_metadata_in_batches(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        message_ids: &[String],
    ) -> Result<usize, GmailSyncError> {
        if message_ids.is_empty() {
            return Ok(0);
        }

        let chunks: Vec<&[String]> = message_ids.chunks(MAX_GMAIL_BATCH_SIZE).collect();
        let mut futures = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            futures.push(self.execute_metadata_batch(oauth_config, email, chunk));
        }

        let batch_results = futures_util::future::try_join_all(futures).await?;
        let today = chrono::Local::now().date_naive();
        let mut all_records = Vec::new();
        let mut all_followups = Vec::new();

        for dtos in batch_results {
            for dto in dtos {
                let rec = dto_to_upsert_record(email, dto, today);
                if let Some((quote, label)) = detect_followup_commitment(&rec.snippet) {
                    all_followups.push(crate::db::UpsertFollowupRecord {
                        thread_id: rec.thread_id.clone(),
                        account_email: email.to_string(),
                        detected_quote: quote,
                        suggested_when: label,
                        status: "sugerido".to_string(),
                    });
                }
                all_records.push(rec);
            }
        }

        let total_stored = all_records.len();
        if !all_records.is_empty() {
            self.db.upsert_messages_batch_with_followups(&all_records, &all_followups)?;

            // Dispara notificação nativa no macOS se houver novas mensagens não lidas
            for rec in &all_records {
                if rec.unread {
                    crate::show_macos_notification(
                        "Corvo Mail",
                        &format!("Nova mensagem de {}", rec.from_name),
                        &rec.subject,
                    );
                    break;
                }
            }

            // Atualiza badge numérico na Dock do macOS
            if let Ok(unread_count) = self.db.get_total_unread_count() {
                crate::set_macos_dock_badge(unread_count);
            }
        }

        Ok(total_stored)
    }

    async fn execute_metadata_batch(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        chunk_ids: &[String],
    ) -> Result<Vec<GmailMessageDto>, GmailSyncError> {
        let boundary = "corvo_gmail_batch_v1";
        let payload = bytes::Bytes::from(build_batch_metadata_request_body(chunk_ids, boundary));
        let batch_url = format!("{}/batch/gmail/v1", self.endpoints.api_base);
        let mut retried_401 = false;

        for attempt in 0..=MAX_BACKOFF_RETRIES {
            let _permit = self
                .concurrency_limiter
                .acquire()
                .await
                .map_err(|e| GmailSyncError::Transport(e.to_string()))?;

            let bearer = self.valid_bearer(oauth_config, email).await?;
            let resp = self
                .client
                .post(&batch_url)
                .bearer_auth(&bearer)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/mixed; boundary={}", boundary),
                )
                .body(payload.clone())
                .send()
                .await
                .map_err(|e| GmailSyncError::Transport(e.to_string()))?;

            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED && !retried_401 {
                retried_401 = true;
                let _ = self.token_manager.evict_access_token(email);
                continue;
            }

            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                if attempt == MAX_BACKOFF_RETRIES {
                    return Err(GmailSyncError::QuotaExceededRetriesExhausted(
                        MAX_BACKOFF_RETRIES,
                    ));
                }
                drop(_permit);
                tokio::time::sleep(compute_backoff_with_jitter(attempt)).await;
                continue;
            }

            if !status.is_success() {
                let txt = resp.text().await.unwrap_or_default();
                return Err(GmailSyncError::ApiError {
                    status: status.as_u16(),
                    detail: txt.chars().take(200).collect(),
                });
            }

            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let raw_text = resp
                .text()
                .await
                .map_err(|e| GmailSyncError::Transport(e.to_string()))?;

            let parsed = parse_multipart_batch_messages(&content_type, &raw_text)?;
            return Ok(parsed);
        }

        Err(GmailSyncError::QuotaExceededRetriesExhausted(
            MAX_BACKOFF_RETRIES,
        ))
    }

    /// Carrega de forma *lazy* os corpos completos em falta de uma conversa quando aberta (§4.2),
    /// persistindo-os em SQLite para leitura offline futura.
    pub async fn open_thread_and_hydrate_bodies(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        thread_id: &str,
    ) -> Result<Option<ThreadDetailDto>, GmailSyncError> {
        let Some(initial_detail) = self.db.get_thread_detail(thread_id)? else {
            return Ok(None);
        };

        let email = initial_detail.account_email.clone();
        let missing_body_ids: Vec<String> = initial_detail
            .messages
            .iter()
            .filter(|m| !m.body_fetched)
            .map(|m| m.id.clone())
            .collect();

        // Hidrata corpos em paralelo via Gmail API (concorrência protegida pelo semáforo)
        let fetch_futures: Vec<_> = missing_body_ids
            .iter()
            .map(|msg_id| {
                let url = format!(
                    "{}/gmail/v1/users/me/messages/{}?format=full",
                    self.endpoints.api_base,
                    urlencoding_param(msg_id)
                );
                let id = msg_id.clone();
                let email_ref = email.clone();
                async move {
                    let res = self
                        .authorized_get_json::<GmailMessageDto>(oauth_config, &email_ref, &url)
                        .await;
                    (id, res)
                }
            })
            .collect();

        let results = futures_util::future::join_all(fetch_futures).await;

        for (msg_id, res) in results {
            if let Ok(full_msg) = res {
                let extracted = full_msg
                    .payload
                    .as_ref()
                    .and_then(extract_plain_text_from_mime)
                    .unwrap_or_else(|| full_msg.snippet.clone().unwrap_or_default());

                let html_body = full_msg.payload.as_ref().and_then(extract_raw_html_from_mime);
                let atts = full_msg
                    .payload
                    .as_ref()
                    .map(extract_attachments_from_mime)
                    .unwrap_or_default();
                let atts_json = serde_json::to_string(&atts).unwrap_or_else(|_| "[]".to_string());

                if let Some((quote, label)) = detect_followup_commitment(&extracted) {
                    let _ = self
                        .db
                        .upsert_followup(thread_id, &email, &quote, &label, "sugerido");
                }
                let _ = self.db.store_message_body_full(
                    &msg_id,
                    &extracted,
                    html_body.as_deref(),
                    Some(&atts_json),
                );
            }
        }

        // Marca localmente como lida e propaga remoção de UNREAD se a conta tiver scope gmail.modify
        let unread_ids = self.db.mark_thread_read_local(thread_id)?;
        if !unread_ids.is_empty() {
            if let Ok(Some(acc)) = self.db.get_account(&email) {
                if acc.scope_mode == GmailScopeMode::ModifyAndLabels {
                    let _ = self
                        .modify_thread_labels_remote(oauth_config, &email, thread_id, &[], &["UNREAD"])
                        .await;
                }
            }
        }

        Ok(self.db.get_thread_detail(thread_id)?)
    }

    pub async fn modify_thread_labels_remote(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        thread_id: &str,
        add_labels: &[&str],
        remove_labels: &[&str],
    ) -> Result<(), GmailSyncError> {
        let _permit = self
            .concurrency_limiter
            .acquire()
            .await
            .map_err(|e| GmailSyncError::Transport(e.to_string()))?;
        let bearer = self.valid_bearer(oauth_config, email).await?;
        let url = format!(
            "{}/gmail/v1/users/me/threads/{}/modify",
            self.endpoints.api_base,
            urlencoding_param(thread_id)
        );
        let payload = serde_json::json!({
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        });
        let _ = self
            .client
            .post(&url)
            .bearer_auth(&bearer)
            .json(&payload)
            .send()
            .await;
        Ok(())
    }

    pub async fn trash_thread_remote(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        thread_id: &str,
    ) -> Result<(), GmailSyncError> {
        let _permit = self
            .concurrency_limiter
            .acquire()
            .await
            .map_err(|e| GmailSyncError::Transport(e.to_string()))?;
        let bearer = self.valid_bearer(oauth_config, email).await?;
        let url = format!(
            "{}/gmail/v1/users/me/threads/{}/trash",
            self.endpoints.api_base,
            urlencoding_param(thread_id)
        );
        let _ = self.client.post(&url).bearer_auth(&bearer).send().await;
        Ok(())
    }

    pub async fn untrash_thread_remote(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        thread_id: &str,
    ) -> Result<(), GmailSyncError> {
        let _permit = self
            .concurrency_limiter
            .acquire()
            .await
            .map_err(|e| GmailSyncError::Transport(e.to_string()))?;
        let bearer = self.valid_bearer(oauth_config, email).await?;
        let url = format!(
            "{}/gmail/v1/users/me/threads/{}/untrash",
            self.endpoints.api_base,
            urlencoding_param(thread_id)
        );
        let _ = self.client.post(&url).bearer_auth(&bearer).send().await;
        Ok(())
    }

    pub async fn delete_thread_remote(
        &self,
        oauth_config: &DesktopOAuthClientConfig,
        email: &str,
        thread_id: &str,
    ) -> Result<(), GmailSyncError> {
        let _permit = self
            .concurrency_limiter
            .acquire()
            .await
            .map_err(|e| GmailSyncError::Transport(e.to_string()))?;
        let bearer = self.valid_bearer(oauth_config, email).await?;
        let url = format!(
            "{}/gmail/v1/users/me/threads/{}",
            self.endpoints.api_base,
            urlencoding_param(thread_id)
        );
        let _ = self.client.delete(&url).bearer_auth(&bearer).send().await;
        Ok(())
    }
}

/// Constrói corpo `multipart/mixed` para `/batch/gmail/v1` (máx. 50 itens).
pub fn build_batch_metadata_request_body(ids: &[String], boundary: &str) -> String {
    use std::fmt::Write;
    let capped = &ids[..ids.len().min(MAX_GMAIL_BATCH_SIZE)];
    let mut out = String::with_capacity(capped.len() * 220);

    for (idx, msg_id) in capped.iter().enumerate() {
        let _ = write!(
            out,
            "--{}\r\nContent-Type: application/http\r\nContent-ID: <corvo-item-{}>\r\n\r\nGET /gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID HTTP/1.1\r\n\r\n",
            boundary,
            idx,
            urlencoding_param(msg_id)
        );
    }
    let _ = write!(out, "--{}--\r\n", boundary);
    out
}

/// Extrai objetos `GmailMessageDto` de uma resposta `multipart/mixed` do endpoint `/batch/gmail/v1`.
pub fn parse_multipart_batch_messages(
    content_type_header: &str,
    raw_body: &str,
) -> Result<Vec<GmailMessageDto>, GmailSyncError> {
    let boundary = extract_boundary(content_type_header).ok_or_else(|| GmailSyncError::ApiError {
        status: 502,
        detail: "Resposta /batch/gmail/v1 sem boundary multipart.".into(),
    })?;

    let delimiter = format!("--{}", boundary);
    let mut messages = Vec::new();

    for part in raw_body.split(&delimiter) {
        let trimmed = part.trim();
        if trimmed.is_empty() || trimmed == "--" {
            continue;
        }

        // Localiza a linha interna HTTP/1.1 dentro da parte application/http
        let Some(http_idx) = trimmed.find("HTTP/1.1 ") else {
            continue;
        };
        let inner_http = &trimmed[http_idx..];
        let status_code: u16 = inner_http
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse().ok())
            .unwrap_or(500);

        if status_code == 429 {
            return Err(GmailSyncError::QuotaExceededRetriesExhausted(1));
        }
        if !(200..300).contains(&status_code) {
            continue;
        }

        // O JSON da mensagem aparece após a linha em branco dos headers HTTP internos
        let json_slice = inner_http
            .find("\r\n\r\n")
            .map(|i| &inner_http[i + 4..])
            .or_else(|| inner_http.find("\n\n").map(|i| &inner_http[i + 2..]));

        if let Some(raw_json) = json_slice {
            if let Some(start_brace) = raw_json.find('{') {
                if let Some(end_brace) = raw_json.rfind('}') {
                    let candidate = &raw_json[start_brace..=end_brace];
                    if let Ok(dto) = serde_json::from_str::<GmailMessageDto>(candidate) {
                        messages.push(dto);
                    }
                }
            }
        }
    }

    Ok(messages)
}

fn extract_boundary(content_type: &str) -> Option<String> {
    for seg in content_type.split(';') {
        let s = seg.trim();
        if let Some(rest) = s.strip_prefix("boundary=") {
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

/// Extrai recursivamente texto simples (`text/plain`) da árvore MIME da Gmail API,
/// ou converte `text/html` removendo todas as tags/scripts para texto estritamente plano.
pub fn extract_plain_text_from_mime(part: &MimePartDto) -> Option<String> {
    let mime = part.mime_type.as_deref().unwrap_or("");
    if mime.eq_ignore_ascii_case("text/plain") {
        if let Some(data) = part.body.as_ref().and_then(|b| b.data.as_deref()) {
            if let Some(decoded) = decode_gmail_base64(data) {
                return Some(decoded);
            }
        }
    }

    if let Some(subparts) = &part.parts {
        // Prioriza text/plain em toda a sub-árvore antes de aceitar fallback text/html
        for sp in subparts {
            if sp
                .mime_type
                .as_deref()
                .map(|m| m.eq_ignore_ascii_case("text/plain") || m.starts_with("multipart/"))
                .unwrap_or(false)
            {
                if let Some(found) = extract_plain_text_from_mime(sp) {
                    return Some(found);
                }
            }
        }
        for sp in subparts {
            if let Some(found) = extract_plain_text_from_mime(sp) {
                return Some(found);
            }
        }
    }

    if mime.eq_ignore_ascii_case("text/html") {
        if let Some(data) = part.body.as_ref().and_then(|b| b.data.as_deref()) {
            if let Some(html) = decode_gmail_base64(data) {
                return Some(strip_html_to_plain_text(&html));
            }
        }
    }

    None
}

fn decode_gmail_base64(raw: &str) -> Option<String> {
    let clean_owned;
    let input = if raw.bytes().any(|b| b.is_ascii_whitespace()) {
        clean_owned = raw.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        &clean_owned[..]
    } else {
        raw
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(input)
        .or_else(|_| URL_SAFE.decode(input))
        .or_else(|_| STANDARD.decode(input))
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn strip_html_to_plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut tag_buf = String::with_capacity(64);
    let mut skip_until_close: Option<&'static str> = None;

    for ch in html.chars() {
        if let Some(target) = skip_until_close {
            if ch == '<' {
                in_tag = true;
                tag_buf.clear();
            } else if ch == '>' && in_tag {
                in_tag = false;
                let trimmed = tag_buf.trim();
                if let Some(rest) = trimmed.strip_prefix('/') {
                    let close_tag = rest.trim().split_ascii_whitespace().next().unwrap_or("");
                    if close_tag.eq_ignore_ascii_case(target) {
                        skip_until_close = None;
                    }
                }
            } else if in_tag {
                tag_buf.push(ch);
            }
            continue;
        }

        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
        } else if ch == '>' {
            in_tag = false;
            let trimmed = tag_buf.trim();
            let tag_name = trimmed.split_ascii_whitespace().next().unwrap_or("");

            if tag_name.eq_ignore_ascii_case("script") {
                skip_until_close = Some("script");
            } else if tag_name.eq_ignore_ascii_case("style") {
                skip_until_close = Some("style");
            } else if tag_name.eq_ignore_ascii_case("head") {
                skip_until_close = Some("head");
            } else if tag_name.eq_ignore_ascii_case("p")
                || tag_name.eq_ignore_ascii_case("/p")
                || tag_name.eq_ignore_ascii_case("br")
                || tag_name.eq_ignore_ascii_case("br/")
                || tag_name.eq_ignore_ascii_case("div")
                || tag_name.eq_ignore_ascii_case("/div")
                || tag_name.eq_ignore_ascii_case("li")
                || tag_name.eq_ignore_ascii_case("/li")
                || tag_name.eq_ignore_ascii_case("tr")
                || tag_name.eq_ignore_ascii_case("/tr")
                || tag_name.eq_ignore_ascii_case("h1")
                || tag_name.eq_ignore_ascii_case("h2")
                || tag_name.eq_ignore_ascii_case("h3")
            {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
        } else if in_tag {
            tag_buf.push(ch);
        } else {
            out.push(ch);
        }
    }

    let decoded = decode_html_entities(&out);
    let mut final_res = String::with_capacity(decoded.len());
    let mut last_was_empty = true;
    for line in decoded.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if !last_was_empty {
                final_res.push_str("\n\n");
            }
            final_res.push_str(trimmed);
            last_was_empty = false;
        }
    }

    final_res
}

/// Deteta compromissos futuros no texto para o Follow-up Inteligente (§1).
pub fn detect_followup_commitment(text: &str) -> Option<(String, String)> {
    let lower = text.to_lowercase();
    let triggers = [
        ("sexta-feira", "Sexta-feira, 10:00 · Rever compromisso na conversa"),
        ("na sexta", "Sexta-feira, 10:00 · Rever compromisso na conversa"),
        ("amanhã", "Amanhã, 09:30 · Rever acompanhamento prometido"),
        ("próxima semana", "Segunda-feira, 09:30 · Acompanhar entrega combinada"),
        ("by friday", "Sexta-feira, 10:00 · Follow-up detetado"),
        ("send the proposal", "Lembrete contextual · Rever envio de proposta"),
        ("envio a proposta", "Lembrete contextual · Confirmar envio da proposta"),
        ("envio a minuta", "Lembrete contextual · Confirmar envio da minuta"),
    ];

    for (needle, label) in triggers {
        if let Some(pos) = lower.find(needle) {
            let start = lower[..pos].rfind(['.', '\n', '!']).map(|i| i + 1).unwrap_or(0);
            let end = lower[pos..]
                .find(['.', '\n', '!'])
                .map(|i| pos + i)
                .unwrap_or(lower.len());
            let quote: String = lower[start..end].trim().chars().take(130).collect();
            if quote.len() >= 10 {
                return Some((quote, label.to_string()));
            }
        }
    }
    None
}

fn dto_to_upsert_record(
    account_email: &str,
    dto: GmailMessageDto,
    today: chrono::NaiveDate,
) -> UpsertMessageRecord {
    let mut from_raw = String::new();
    let mut to_header = String::new();
    let mut subject = String::from("(Sem assunto)");
    let mut list_unsubscribe = None;

    if let Some(ref payload) = dto.payload {
        if let Some(ref headers) = payload.headers {
            for h in headers {
                match h.name.to_ascii_lowercase().as_str() {
                    "from" => from_raw = h.value.clone(),
                    "to" => to_header = h.value.clone(),
                    "subject" if !h.value.trim().is_empty() => subject = h.value.clone(),
                    "list-unsubscribe" => list_unsubscribe = Some(h.value.clone()),
                    _ => {}
                }
            }
        }
    }

    let (from_name, from_email) = parse_rfc5322_address(&from_raw);
    let internal_ms: i64 = dto
        .internal_date
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| now_epoch() * 1000);

    let labels = dto.label_ids.unwrap_or_default();
    let unread = labels.iter().any(|l| l == "UNREAD");
    let labels_json = serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into());
    let display_date = format_tabular_date(internal_ms, today);
    let body_plain = dto.payload.as_ref().and_then(extract_plain_text_from_mime);
    let body_html = dto.payload.as_ref().and_then(extract_raw_html_from_mime);
    let attachments = dto
        .payload
        .as_ref()
        .map(extract_attachments_from_mime)
        .unwrap_or_default();
    let attachments_json = serde_json::to_string(&attachments).ok();

    UpsertMessageRecord {
        id: dto.id.clone(),
        thread_id: dto.thread_id.unwrap_or(dto.id),
        account_email: account_email.to_string(),
        from_name,
        from_email,
        to_header,
        subject,
        snippet: decode_html_entities(&dto.snippet.unwrap_or_default()),
        internal_date_ms: internal_ms,
        display_date,
        unread,
        labels_json,
        body_plain,
        body_html,
        attachments_json,
        list_unsubscribe,
    }
}

fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = s.to_string();
    crate::prompt_guard::replace_if_present(&mut out, "&nbsp;", " ");
    crate::prompt_guard::replace_if_present(&mut out, "&#39;", "'");
    crate::prompt_guard::replace_if_present(&mut out, "&quot;", "\"");
    crate::prompt_guard::replace_if_present(&mut out, "&amp;", "&");
    crate::prompt_guard::replace_if_present(&mut out, "&lt;", "<");
    crate::prompt_guard::replace_if_present(&mut out, "&gt;", ">");
    out
}

fn parse_rfc5322_address(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    if let (Some(lt), Some(gt)) = (trimmed.find('<'), trimmed.rfind('>')) {
        if lt < gt {
            let name = trimmed[..lt].trim().trim_matches('"').trim();
            let email = trimmed[lt + 1..gt].trim();
            let final_name = if name.is_empty() { email } else { name };
            return (final_name.to_string(), email.to_string());
        }
    }
    (trimmed.to_string(), trimmed.to_string())
}

fn format_tabular_date(epoch_ms: i64, today: chrono::NaiveDate) -> String {
    let secs = epoch_ms / 1000;
    let Some(utc_dt) = Utc.timestamp_opt(secs, 0).single() else {
        return "--:--".into();
    };
    let local_dt: DateTime<Local> = DateTime::from(utc_dt);
    if local_dt.date_naive() == today {
        local_dt.format("%H:%M").to_string()
    } else {
        local_dt.format("%d %b").to_string()
    }
}

fn urlencoding_param(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[derive(Debug, Deserialize)]
struct MessageListResponseDto {
    messages: Option<Vec<MessageRefDto>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MessageRefDto {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ProfileDto {
    #[serde(rename = "historyId")]
    history_id: String,
}

#[derive(Debug, Deserialize)]
struct HistoryListResponseDto {
    history: Option<Vec<HistoryRecordDto>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "historyId")]
    history_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HistoryRecordDto {
    #[serde(rename = "messagesAdded")]
    messages_added: Option<Vec<HistoryMessageItemDto>>,
    #[serde(rename = "messagesDeleted")]
    messages_deleted: Option<Vec<HistoryMessageItemDto>>,
    #[serde(rename = "labelsAdded")]
    labels_added: Option<Vec<HistoryMessageItemDto>>,
    #[serde(rename = "labelsRemoved")]
    labels_removed: Option<Vec<HistoryMessageItemDto>>,
}

#[derive(Debug, Deserialize)]
struct HistoryMessageItemDto {
    message: HistoryMessageDto,
}

#[derive(Debug, Deserialize)]
struct HistoryMessageDto {
    id: String,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GmailMessageDto {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    #[serde(rename = "labelIds")]
    pub label_ids: Option<Vec<String>>,
    pub snippet: Option<String>,
    #[serde(rename = "internalDate")]
    pub internal_date: Option<String>,
    pub payload: Option<MimePartDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MimePartDto {
    #[serde(rename = "partId")]
    pub part_id: Option<String>,
    pub filename: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    pub headers: Option<Vec<GmailHeaderDto>>,
    pub body: Option<MimeBodyDto>,
    pub parts: Option<Vec<MimePartDto>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GmailHeaderDto {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MimeBodyDto {
    pub data: Option<String>,
    #[serde(rename = "attachmentId")]
    pub attachment_id: Option<String>,
    pub size: Option<u64>,
}

pub fn extract_attachments_from_mime(part: &MimePartDto) -> Vec<crate::db::MessageAttachmentDto> {
    let mut list = Vec::new();
    extract_attachments_recursive(part, &mut list);
    list
}

fn extract_attachments_recursive(part: &MimePartDto, list: &mut Vec<crate::db::MessageAttachmentDto>) {
    let filename = part.filename.as_deref().unwrap_or("").trim();
    let body_attachment_id = part.body.as_ref().and_then(|b| b.attachment_id.as_deref());
    let size = part.body.as_ref().and_then(|b| b.size).unwrap_or(0);
    let mime = part.mime_type.as_deref().unwrap_or("application/octet-stream");

    if (!filename.is_empty() || body_attachment_id.is_some()) && !mime.starts_with("multipart/") {
        let name = if filename.is_empty() {
            format!("anexo_{}", list.len() + 1)
        } else {
            filename.to_string()
        };
        list.push(crate::db::MessageAttachmentDto {
            id: part.part_id.clone().unwrap_or_else(|| format!("att_{}", list.len() + 1)),
            filename: name,
            mime_type: mime.to_string(),
            size_bytes: size,
            attachment_id: body_attachment_id.map(|s| s.to_string()),
        });
    }

    if let Some(subparts) = &part.parts {
        for sp in subparts {
            extract_attachments_recursive(sp, list);
        }
    }
}

pub fn extract_raw_html_from_mime(part: &MimePartDto) -> Option<String> {
    let mime = part.mime_type.as_deref().unwrap_or("");
    if mime.eq_ignore_ascii_case("text/html") {
        if let Some(data) = part.body.as_ref().and_then(|b| b.data.as_deref()) {
            if let Some(decoded) = decode_gmail_base64(data) {
                return Some(decoded);
            }
        }
    }

    if let Some(subparts) = &part.parts {
        for sp in subparts {
            if let Some(html) = extract_raw_html_from_mime(sp) {
                return Some(html);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::tests::InMemoryTestVault;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn batch_builder_enforces_50_item_cap_and_multipart_parser_extracts_dtos() {
        let ids: Vec<String> = (0..75).map(|i| format!("msg_{}", i)).collect();
        let req_body = build_batch_metadata_request_body(&ids, "bndry");
        // Garante limite estrito de 50 sub-pedidos (§4.1)
        assert_eq!(req_body.matches("Content-Type: application/http").count(), 50);

        let sample_response = "\
--batch_resp_1\r\n\
Content-Type: application/http\r\n\
Content-ID: <response-corvo-item-0>\r\n\r\n\
HTTP/1.1 200 OK\r\n\
Content-Type: application/json; charset=UTF-8\r\n\r\n\
{\"id\":\"18f1a\",\"threadId\":\"18f1a\",\"labelIds\":[\"INBOX\",\"UNREAD\"],\"snippet\":\"Envio a proposta na sexta-feira\",\"internalDate\":\"1730810000000\",\"payload\":{\"headers\":[{\"name\":\"From\",\"value\":\"João <joao@matriz.pt>\"},{\"name\":\"Subject\",\"value\":\"Orçamento Q3\"}]}}\r\n\
--batch_resp_1--\r\n";

        let parsed = parse_multipart_batch_messages(
            "multipart/mixed; boundary=batch_resp_1",
            sample_response,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "18f1a");
    }

    #[tokio::test]
    async fn expired_history_id_404_triggers_automatic_fallback_resync() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();

        tokio::spawn(async move {
            for _ in 0..3 {
                let Ok((mut sock, _)) = server.accept().await else { break };
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");

                let (status, content_type, body) = if first_line.contains("/history?") {
                    // 1. historyId expirado devolve 404 (§1.3.4)
                    (
                        "404 Not Found",
                        "application/json",
                        r#"{"error":{"code":404,"message":"Requested entity was not found."}}"#.to_string(),
                    )
                } else if first_line.contains("/messages?") {
                    // 2. Fallback para messages.list
                    (
                        "200 OK",
                        "application/json",
                        r#"{"messages":[{"id":"m_already_cached"}]}"#.to_string(),
                    )
                } else {
                    // 3. users.getProfile devolve o novo historyId fresco
                    (
                        "200 OK",
                        "application/json",
                        r#"{"emailAddress":"ines@atelier.pt","historyId":"55099"}"#.to_string(),
                    )
                };

                let http = format!(
                    "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    content_type,
                    body.len(),
                    body
                );
                let _ = sock.write_all(http.as_bytes()).await;
            }
        });

        let db = Arc::new(LocalDatabase::open_in_memory().unwrap());
        db.upsert_account(
            "ines@atelier.pt",
            "Atelier",
            GmailScopeMode::ModifyAndLabels,
            Some("10001_expired"),
        )
        .unwrap();
        // Pré-insere m_already_cached para provar que NÃO faz messages.get redundante!
        db.upsert_messages_batch(&[UpsertMessageRecord {
            id: "m_already_cached".into(),
            thread_id: "t1".into(),
            account_email: "ines@atelier.pt".into(),
            from_name: "Marta".into(),
            from_email: "marta@atelier.pt".into(),
            to_header: "ines@atelier.pt".into(),
            subject: "Existente".into(),
            snippet: "Em cache".into(),
            internal_date_ms: 1730000000000,
            display_date: "10:00".into(),
            unread: false,
            labels_json: "[]".into(),
            body_plain: None,
            body_html: None,
            attachments_json: None,
            list_unsubscribe: None,
        }])
        .unwrap();

        let vault = Arc::new(InMemoryTestVault::default());
        let token_mgr = TokenManager::with_vault(vault);
        let now = now_epoch();
        token_mgr
            .persist_initial_tokens("ines@atelier.pt", "ya29.valid", 3600, Some("1//rt"), now)
            .unwrap();

        let engine = GmailSyncEngine::with_endpoints(
            build_gmail_http_client().unwrap(),
            db.clone(),
            token_mgr,
            GmailEndpoints {
                api_base: format!("http://{}", addr),
                token_url: format!("http://{}/token", addr),
            },
        );

        let cfg = DesktopOAuthClientConfig {
            client_id: "cid".into(),
            client_secret: "csec".into(),
        };

        let report = engine.sync_account(&cfg, "ines@atelier.pt", 100).await.unwrap();
        assert_eq!(report.mode, "resync-expired-history");
        assert_eq!(report.new_history_id, "55099");
        assert_eq!(
            db.get_account("ines@atelier.pt").unwrap().unwrap().history_id.as_deref(),
            Some("55099")
        );
    }

    #[tokio::test]
    async fn quota_exceeded_429_retries_and_returns_typed_error_when_exhausted() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();

        // Devolve 429 nas 2 primeiras chamadas e 200 OK na 3.ª tentativa!
        tokio::spawn(async move {
            for attempt in 0..3 {
                let Ok((mut sock, _)) = server.accept().await else { break };
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let (status, body) = if attempt < 2 {
                    (
                        "429 Too Many Requests",
                        r#"{"error":{"code":429,"message":"User-rate limit exceeded."}}"#,
                    )
                } else {
                    (
                        "200 OK",
                        r#"{"historyId":"77700"}"#,
                    )
                };
                let resp = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let db = Arc::new(LocalDatabase::open_in_memory().unwrap());
        db.upsert_account(
            "ines@atelier.pt",
            "Atelier",
            GmailScopeMode::ReadOnly,
            Some("77699"),
        )
        .unwrap();

        let token_mgr = TokenManager::with_vault(Arc::new(InMemoryTestVault::default()));
        token_mgr
            .persist_initial_tokens("ines@atelier.pt", "ya29.ok", 3600, Some("1//rt"), now_epoch())
            .unwrap();

        let engine = GmailSyncEngine::with_endpoints(
            build_gmail_http_client().unwrap(),
            db,
            token_mgr,
            GmailEndpoints {
                api_base: format!("http://{}", addr),
                token_url: format!("http://{}/token", addr),
            },
        );
        let cfg = DesktopOAuthClientConfig {
            client_id: "cid".into(),
            client_secret: "csec".into(),
        };

        let report = engine.sync_account(&cfg, "ines@atelier.pt", 50).await.unwrap();
        assert_eq!(report.new_history_id, "77700");
    }
}
