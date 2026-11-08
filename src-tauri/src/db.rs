//! Camada de Persistência Local SQLite (`rusqlite`, §1.3 & §4.1 & §4.2)
//!
//! Responsabilidades:
//! 1. Arranque instantâneo e funcionamento offline para leitura após sincronização inicial.
//! 2. Guarda `historyId` por conta para sincronização incremental (`users.history.list`).
//! 3. Separa payloads leves de listagem (`ThreadListItemDto` sem `body_plain`) do detalhe
//!    completo (`ThreadDetailDto`), reduzindo serialização IPC (§4.2).
//! 4. Mantém a allowlist determinística de destinatários conhecidos (§2.3).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::oauth::GmailScopeMode;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("Erro SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Lock da base de dados interrompido.")]
    PoisonedLock,
    #[error("Erro de serialização de dados locais: {0}")]
    Json(#[from] serde_json::Error),
}

fn default_provider() -> String {
    "gmail".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub email: String,
    pub label: String,
    pub scope_mode: GmailScopeMode,
    pub history_id: Option<String>,
    pub ai_enabled: bool,
    pub suggestion_trigger: String,
    pub auto_summarize: bool,
    pub last_synced_epoch: Option<i64>,
    #[serde(default = "default_provider")]
    pub provider: String,
}

#[derive(Debug, Clone)]
pub struct UpsertFollowupRecord {
    pub thread_id: String,
    pub account_email: String,
    pub detected_quote: String,
    pub suggested_when: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct UpsertMessageRecord {
    pub id: String,
    pub thread_id: String,
    pub account_email: String,
    pub from_name: String,
    pub from_email: String,
    pub to_header: String,
    pub subject: String,
    pub snippet: String,
    pub internal_date_ms: i64,
    pub display_date: String,
    pub unread: bool,
    pub labels_json: String,
    pub body_plain: Option<String>,
    pub body_html: Option<String>,
    pub attachments_json: Option<String>,
    pub list_unsubscribe: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentDto {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub attachment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownContactDto {
    pub email: String,
    pub display_name: String,
}

/// Payload leve para listagem IPC (§4.2): exclui corpos de mensagens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListItemDto {
    pub id: String,
    pub account_email: String,
    pub account_label: String,
    pub from_name: String,
    pub from_email: String,
    pub subject: String,
    pub snippet: String,
    pub display_date: String,
    pub internal_date_ms: i64,
    pub unread: bool,
    pub message_count: usize,
    pub visual_density: String,
    pub followup_status: Option<String>,
    pub followup_label: Option<String>,
    pub is_inbox: bool,
    pub is_starred: bool,
    pub is_trash: bool,
    pub is_spam: bool,
    pub is_draft: bool,
    pub is_sent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetailDto {
    pub id: String,
    pub sender_name: String,
    pub sender_email: String,
    pub to_header: String,
    pub display_date: String,
    pub internal_date_ms: i64,
    pub snippet: String,
    pub body_plain: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<MessageAttachmentDto>,
    pub body_fetched: bool,
    #[serde(default)]
    pub list_unsubscribe: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpDto {
    pub detected_quote: String,
    pub suggested_when: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailDto {
    pub id: String,
    pub account_email: String,
    pub subject: String,
    pub unread: bool,
    pub messages: Vec<MessageDetailDto>,
    pub follow_up: Option<FollowUpDto>,
}

pub struct LocalDatabase {
    write_conn: Mutex<Connection>,
    read_conn: Mutex<Connection>,
}

impl LocalDatabase {
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let write_conn = Connection::open(path)?;
        let read_conn = Connection::open(path)?;
        let db = Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
        };
        db.init_schema()?;
        db.apply_read_pragmas()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, DbError> {
        static MEM_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = MEM_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let uri = format!("file:kwrl_mem_{}?mode=memory&cache=shared", id);
        let write_conn = Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        let read_conn = Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        let db = Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
        };
        db.init_schema()?;
        db.apply_read_pragmas()?;
        Ok(db)
    }

    fn apply_read_pragmas(&self) -> Result<(), DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA temp_store = MEMORY;
            PRAGMA mmap_size = 268435456;
            PRAGMA cache_size = -64000;
            PRAGMA busy_timeout = 5000;
            ",
        )?;
        Ok(())
    }

    fn init_schema(&self) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA temp_store = MEMORY;
            PRAGMA mmap_size = 268435456;
            PRAGMA cache_size = -64000;
            PRAGMA busy_timeout = 5000;
            ",
        )?;

        let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version == 0 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS app_kv (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS accounts (
                    email TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    scope_mode TEXT NOT NULL,
                    history_id TEXT,
                    ai_enabled INTEGER NOT NULL DEFAULT 1,
                    suggestion_trigger TEXT NOT NULL DEFAULT 'on-open',
                    auto_summarize INTEGER NOT NULL DEFAULT 1,
                    last_synced_epoch INTEGER,
                    provider TEXT NOT NULL DEFAULT 'gmail'
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    account_email TEXT NOT NULL,
                    from_name TEXT NOT NULL,
                    from_email TEXT NOT NULL,
                    to_header TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    snippet TEXT NOT NULL,
                    internal_date_ms INTEGER NOT NULL,
                    display_date TEXT NOT NULL,
                    unread INTEGER NOT NULL DEFAULT 0,
                    labels_json TEXT NOT NULL DEFAULT '[]',
                    body_plain TEXT,
                    body_html TEXT,
                    attachments_json TEXT NOT NULL DEFAULT '[]',
                    body_fetched INTEGER NOT NULL DEFAULT 0,
                    list_unsubscribe TEXT,
                    FOREIGN KEY (account_email) REFERENCES accounts(email) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_messages_thread
                    ON messages(thread_id, internal_date_ms ASC);
                CREATE INDEX IF NOT EXISTS idx_messages_account_date
                    ON messages(account_email, internal_date_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_acc_thread_date
                    ON messages(account_email, thread_id, internal_date_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_unread
                    ON messages(unread) WHERE unread = 1;
                CREATE INDEX IF NOT EXISTS idx_messages_thread_unread
                    ON messages(thread_id, unread);

                CREATE TABLE IF NOT EXISTS known_contacts (
                    email TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    source TEXT NOT NULL,
                    updated_epoch INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_known_contacts_updated
                    ON known_contacts(updated_epoch DESC);

                CREATE TABLE IF NOT EXISTS thread_followups (
                    thread_id TEXT PRIMARY KEY,
                    account_email TEXT NOT NULL,
                    detected_quote TEXT NOT NULL,
                    suggested_when TEXT NOT NULL,
                    status TEXT NOT NULL
                );

                PRAGMA user_version = 1;
                ",
            )?;
        }

        // Migrações incrementais seguras e retrocompatíveis
        let _ = conn.execute("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail'", []);
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT", []);
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                message_id UNINDEXED,
                thread_id UNINDEXED,
                account_email UNINDEXED,
                subject,
                snippet,
                body_plain,
                from_name,
                from_email,
                tokenize='unicode61 remove_diacritics 2'
            );"
        )?;

        Ok(())
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute(
            "INSERT INTO app_kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_kv(&self, key: &str) -> Result<Option<String>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached("SELECT value FROM app_kv WHERE key = ?1")?;
        let val = stmt
            .query_row(params![key], |row| row.get(0))
            .optional()?;
        Ok(val)
    }

    pub fn upsert_account(
        &self,
        email: &str,
        label: &str,
        scope_mode: GmailScopeMode,
        initial_history_id: Option<&str>,
    ) -> Result<(), DbError> {
        self.upsert_account_with_provider(email, label, scope_mode, initial_history_id, None)
    }

    pub fn upsert_account_with_provider(
        &self,
        email: &str,
        label: &str,
        scope_mode: GmailScopeMode,
        initial_history_id: Option<&str>,
        provider: Option<&str>,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let scope_json = serde_json::to_string(&scope_mode)?;
        let prov = provider.unwrap_or("gmail");
        conn.execute(
            "INSERT INTO accounts (email, label, scope_mode, history_id, provider)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(email) DO UPDATE SET
                label = excluded.label,
                scope_mode = excluded.scope_mode,
                history_id = COALESCE(excluded.history_id, accounts.history_id),
                provider = excluded.provider",
            params![email.to_ascii_lowercase(), label, scope_json, initial_history_id, prov],
        )?;
        Ok(())
    }

    pub fn update_account_policy(
        &self,
        email: &str,
        ai_enabled: bool,
        suggestion_trigger: &str,
        auto_summarize: bool,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute(
            "UPDATE accounts
             SET ai_enabled = ?2, suggestion_trigger = ?3, auto_summarize = ?4
             WHERE email = ?1",
            params![
                email.to_ascii_lowercase(),
                ai_enabled as i32,
                suggestion_trigger,
                auto_summarize as i32
            ],
        )?;
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<StoredAccount>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "SELECT email, label, scope_mode, history_id, ai_enabled,
                    suggestion_trigger, auto_summarize, last_synced_epoch, provider
             FROM accounts
             ORDER BY email ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            let scope_raw: String = row.get(2)?;
            let scope_mode: GmailScopeMode =
                serde_json::from_str(&scope_raw).unwrap_or(GmailScopeMode::ModifyAndLabels);
            Ok(StoredAccount {
                email: row.get(0)?,
                label: row.get(1)?,
                scope_mode,
                history_id: row.get(3)?,
                ai_enabled: row.get::<_, i32>(4)? != 0,
                suggestion_trigger: row.get(5)?,
                auto_summarize: row.get::<_, i32>(6)? != 0,
                last_synced_epoch: row.get(7)?,
                provider: row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "gmail".to_string()),
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_account(&self, email: &str) -> Result<Option<StoredAccount>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "SELECT email, label, scope_mode, history_id, ai_enabled,
                    suggestion_trigger, auto_summarize, last_synced_epoch, provider
             FROM accounts WHERE email = ?1",
        )?;
        let acc = stmt
            .query_row(params![email.to_ascii_lowercase()], |row| {
                let scope_raw: String = row.get(2)?;
                let scope_mode: GmailScopeMode =
                    serde_json::from_str(&scope_raw).unwrap_or(GmailScopeMode::ModifyAndLabels);
                Ok(StoredAccount {
                    email: row.get(0)?,
                    label: row.get(1)?,
                    scope_mode,
                    history_id: row.get(3)?,
                    ai_enabled: row.get::<_, i32>(4)? != 0,
                    suggestion_trigger: row.get(5)?,
                    auto_summarize: row.get::<_, i32>(6)? != 0,
                    last_synced_epoch: row.get(7)?,
                    provider: row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "gmail".to_string()),
                })
            })
            .optional()?;
        Ok(acc)
    }

    pub fn remove_account(&self, email: &str) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute(
            "DELETE FROM accounts WHERE email = ?1",
            params![email.to_ascii_lowercase()],
        )?;
        Ok(())
    }

    pub fn update_account_history_id(
        &self,
        email: &str,
        history_id: &str,
        synced_epoch: i64,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        conn.execute(
            "UPDATE accounts
             SET history_id = ?2, last_synced_epoch = ?3
             WHERE email = ?1",
            params![email.to_ascii_lowercase(), history_id, synced_epoch],
        )?;
        Ok(())
    }

    /// Verifica quais dos IDs candidatos ainda NÃO existem em SQLite (§1.3.3:
    /// "Nunca chames messages.get para IDs que já tens localmente").
    /// Otimizado com chunk fixo de 200 e prepare_cached para reutilização do plano SQLite.
    pub fn filter_missing_message_ids(
        &self,
        candidate_ids: &[String],
    ) -> Result<Vec<String>, DbError> {
        if candidate_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut existing_set = std::collections::HashSet::with_capacity(candidate_ids.len());

        const CHUNK_SIZE: usize = 200;
        static QUERY_SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let sql = QUERY_SQL.get_or_init(|| {
            let mut s = String::from("SELECT id FROM messages WHERE id IN (?");
            for _ in 1..CHUNK_SIZE {
                s.push_str(",?");
            }
            s.push(')');
            s
        });

        for chunk in candidate_ids.chunks(CHUNK_SIZE) {
            let mut stmt = conn.prepare_cached(sql)?;
            let first = &chunk[0];
            let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(CHUNK_SIZE);
            for id in chunk {
                params_vec.push(id as &dyn rusqlite::ToSql);
            }
            while params_vec.len() < CHUNK_SIZE {
                params_vec.push(first as &dyn rusqlite::ToSql);
            }
            let mut rows = stmt.query(&params_vec[..])?;
            while let Some(row) = rows.next()? {
                existing_set.insert(row.get::<_, String>(0)?);
            }
        }

        let mut missing = Vec::with_capacity(candidate_ids.len());
        for id in candidate_ids {
            if !existing_set.contains(id) {
                missing.push(id.clone());
            }
        }
        Ok(missing)
    }

    pub fn upsert_messages_batch_with_followups(
        &self,
        batch: &[UpsertMessageRecord],
        followups: &[UpsertFollowupRecord],
    ) -> Result<(), DbError> {
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;

        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO messages (
                    id, thread_id, account_email, from_name, from_email, to_header,
                    subject, snippet, internal_date_ms, display_date, unread, labels_json,
                    body_plain, body_fetched, body_html, attachments_json, list_unsubscribe
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                    unread = excluded.unread,
                    labels_json = excluded.labels_json,
                    snippet = excluded.snippet,
                    body_plain = COALESCE(excluded.body_plain, messages.body_plain),
                    body_html = COALESCE(excluded.body_html, messages.body_html),
                    list_unsubscribe = COALESCE(excluded.list_unsubscribe, messages.list_unsubscribe),
                    attachments_json = CASE
                        WHEN excluded.attachments_json != '[]' AND excluded.attachments_json IS NOT NULL THEN excluded.attachments_json
                        ELSE messages.attachments_json
                    END,
                    body_fetched = CASE
                        WHEN excluded.body_plain IS NOT NULL THEN 1
                        ELSE messages.body_fetched
                    END",
            )?;

            let mut fts_del = tx.prepare_cached("DELETE FROM messages_fts WHERE message_id = ?1")?;
            let mut fts_ins = tx.prepare_cached(
                "INSERT INTO messages_fts (message_id, thread_id, account_email, subject, snippet, body_plain, from_name, from_email)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;

            let mut contact_stmt = tx.prepare_cached(
                "INSERT INTO known_contacts (email, display_name, source, updated_epoch)
                 VALUES (?1, ?2, 'gmail-header', ?3)
                 ON CONFLICT(email) DO UPDATE SET
                    display_name = excluded.display_name,
                    updated_epoch = excluded.updated_epoch",
            )?;

            let mut seen_contacts = std::collections::HashSet::new();

            for m in batch {
                let has_body = m.body_plain.is_some() as i32;
                stmt.execute(params![
                    m.id,
                    m.thread_id,
                    m.account_email.to_ascii_lowercase(),
                    m.from_name,
                    m.from_email.to_ascii_lowercase(),
                    m.to_header,
                    m.subject,
                    m.snippet,
                    m.internal_date_ms,
                    m.display_date,
                    m.unread as i32,
                    m.labels_json,
                    m.body_plain,
                    has_body,
                    m.body_html,
                    m.attachments_json.as_deref().unwrap_or("[]"),
                    m.list_unsubscribe,
                ])?;

                // Sincronização em tabela FTS5 com BM25
                let _ = fts_del.execute(params![&m.id]);
                let _ = fts_ins.execute(params![
                    &m.id,
                    &m.thread_id,
                    &m.account_email,
                    &m.subject,
                    &m.snippet,
                    m.body_plain.as_deref().unwrap_or(""),
                    &m.from_name,
                    &m.from_email,
                ]);

                if m.from_email.contains('@') {
                    let norm_email = m.from_email.to_ascii_lowercase();
                    if seen_contacts.insert(norm_email.clone()) {
                        let _ = contact_stmt.execute(params![
                            norm_email,
                            m.from_name,
                            m.internal_date_ms / 1000
                        ]);
                    }
                }
            }

            if !followups.is_empty() {
                let mut fup_stmt = tx.prepare_cached(
                    "INSERT INTO thread_followups (thread_id, account_email, detected_quote, suggested_when, status)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(thread_id) DO UPDATE SET
                        detected_quote = excluded.detected_quote,
                        suggested_when = excluded.suggested_when,
                        status = excluded.status",
                )?;
                for f in followups {
                    fup_stmt.execute(params![
                        f.thread_id,
                        f.account_email.to_ascii_lowercase(),
                        f.detected_quote,
                        f.suggested_when,
                        f.status
                    ])?;
                }
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn upsert_messages_batch(&self, batch: &[UpsertMessageRecord]) -> Result<(), DbError> {
        self.upsert_messages_batch_with_followups(batch, &[])
    }

    pub fn delete_messages_by_ids(&self, ids: &[String]) -> Result<(), DbError> {
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM messages WHERE id = ?1")?;
            for id in ids {
                stmt.execute(params![id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_message_labels_and_unread(
        &self,
        message_id: &str,
        labels_json: &str,
        unread: bool,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached("UPDATE messages SET labels_json = ?2, unread = ?3 WHERE id = ?1")?;
        stmt.execute(params![message_id, labels_json, unread as i32])?;
        Ok(())
    }

    /// Atualiza etiquetas e estado de leitura de múltiplas mensagens numa única transação atómica
    pub fn update_messages_labels_batch(
        &self,
        updates: &[(String, String, bool)],
    ) -> Result<(), DbError> {
        if updates.is_empty() {
            return Ok(());
        }
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE messages SET labels_json = ?2, unread = ?3 WHERE id = ?1",
            )?;
            for (id, labels_json, unread) in updates {
                stmt.execute(params![id, labels_json, *unread as i32])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn store_message_body_full(
        &self,
        message_id: &str,
        body_plain: &str,
        body_html: Option<&str>,
        attachments_json: Option<&str>,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "UPDATE messages
             SET body_plain = ?2,
                 body_html = COALESCE(?3, body_html),
                 attachments_json = COALESCE(?4, attachments_json),
                 body_fetched = 1
             WHERE id = ?1",
        )?;
        stmt.execute(params![message_id, body_plain, body_html, attachments_json])?;
        Ok(())
    }

    pub fn store_message_body(&self, message_id: &str, body_plain: &str) -> Result<(), DbError> {
        self.store_message_body_full(message_id, body_plain, None, None)
    }

    pub fn update_threads_unread_batch(
        &self,
        thread_ids: &[&str],
        unread: bool,
    ) -> Result<(), DbError> {
        if thread_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("UPDATE messages SET unread = ?2 WHERE thread_id = ?1")?;
            let unread_val = unread as i32;
            for tid in thread_ids {
                stmt.execute(params![tid, unread_val])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_thread_unread(&self, thread_id: &str, unread: bool) -> Result<(), DbError> {
        self.update_threads_unread_batch(&[thread_id], unread)
    }

    pub fn update_threads_labels_batch(
        &self,
        thread_updates: &[(&str, &[&str], &[&str])],
    ) -> Result<(), DbError> {
        if thread_updates.is_empty() {
            return Ok(());
        }
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;

        {
            let mut select_stmt = tx.prepare_cached("SELECT id, labels_json FROM messages WHERE thread_id = ?1")?;
            let mut update_stmt = tx.prepare_cached("UPDATE messages SET labels_json = ?2 WHERE id = ?1")?;

            for (thread_id, add_labels, remove_labels) in thread_updates {
                let mut msgs: Vec<(String, String)> = Vec::new();
                {
                    let mut rows = select_stmt.query(params![thread_id])?;
                    while let Some(row) = rows.next()? {
                        msgs.push((row.get(0)?, row.get(1)?));
                    }
                }

                for (id, json_str) in msgs {
                    let mut labels: Vec<String> = serde_json::from_str(&json_str).unwrap_or_default();
                    for add in *add_labels {
                        if !labels.iter().any(|l| l == *add) {
                            labels.push((*add).to_string());
                        }
                    }
                    labels.retain(|l| !remove_labels.contains(&l.as_str()));
                    let new_json = serde_json::to_string(&labels).unwrap_or_else(|_| "[]".to_string());
                    update_stmt.execute(params![id, new_json])?;
                }
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn update_thread_labels(
        &self,
        thread_id: &str,
        add_labels: &[&str],
        remove_labels: &[&str],
    ) -> Result<(), DbError> {
        self.update_threads_labels_batch(&[(thread_id, add_labels, remove_labels)])
    }

    pub fn delete_threads_local_batch(&self, thread_ids: &[&str]) -> Result<(), DbError> {
        if thread_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let tx = conn.transaction()?;
        {
            let mut del_msg = tx.prepare_cached("DELETE FROM messages WHERE thread_id = ?1")?;
            let mut del_fup = tx.prepare_cached("DELETE FROM thread_followups WHERE thread_id = ?1")?;
            let mut del_fts = tx.prepare_cached("DELETE FROM messages_fts WHERE thread_id = ?1")?;
            for tid in thread_ids {
                del_msg.execute(params![tid])?;
                del_fup.execute(params![tid])?;
                let _ = del_fts.execute(params![tid]);
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_thread_local(&self, thread_id: &str) -> Result<(), DbError> {
        self.delete_threads_local_batch(&[thread_id])
    }

    pub fn list_known_contacts(&self) -> Result<Vec<KnownContactDto>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "SELECT email, display_name FROM known_contacts
             WHERE email != '' AND email NOT LIKE '%@desktop%'
             ORDER BY updated_epoch DESC LIMIT 150",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(KnownContactDto {
                email: row.get(0)?,
                display_name: row.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn mark_thread_read_local(&self, thread_id: &str) -> Result<Vec<String>, DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "UPDATE messages SET unread = 0 WHERE thread_id = ?1 AND unread = 1 RETURNING id",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| r.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for r in rows {
            ids.push(r?);
        }
        Ok(ids)
    }

    /// Lista conversas em formato leve para IPC (§4.2): sem carregar `body_plain`.
    /// Otimizado com índices compostos, unicidade estrita por max_id e filtragem SQL nativa.
    pub fn list_threads_lightweight(
        &self,
        account_filter: Option<&str>,
        search_query: Option<&str>,
        view_filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ThreadListItemDto>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let q_norm = search_query
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let acc_param = account_filter.map(|s| s.to_ascii_lowercase());

        let (where_clause, param_count) = match (&acc_param, &q_norm) {
            (Some(_), Some(_)) => (
                "WHERE account_email = ?1 AND (subject LIKE ?2 OR snippet LIKE ?2 OR from_name LIKE ?2 OR from_email LIKE ?2)",
                2,
            ),
            (Some(_), None) => ("WHERE account_email = ?1", 1),
            (None, Some(_)) => (
                "WHERE (subject LIKE ?1 OR snippet LIKE ?1 OR from_name LIKE ?1 OR from_email LIKE ?1)",
                1,
            ),
            (None, None) => ("", 0),
        };

        let outer_where = match view_filter {
            Some("view-unread") => "WHERE agg.has_unread = 1",
            Some("view-followups") => "WHERE f.status IS NOT NULL AND f.status != 'dispensado'",
            Some("view-feedback") => "WHERE (m.subject LIKE '%?%' OR m.snippet LIKE '%?%' OR m.subject LIKE '%feedback%' OR m.snippet LIKE '%feedback%' OR m.subject LIKE '%revis%' OR m.snippet LIKE '%revis%' OR m.subject LIKE '%aprov%' OR m.snippet LIKE '%aprov%' OR m.subject LIKE '%confirm%' OR m.snippet LIKE '%confirm%' OR m.subject LIKE '%review%' OR m.snippet LIKE '%review%')",
            _ => "",
        };

        let sql = format!(
            "
            SELECT
                m.thread_id,
                m.account_email,
                COALESCE(a.label, m.account_email) AS account_label,
                m.from_name,
                m.from_email,
                m.subject,
                m.snippet,
                m.display_date,
                m.internal_date_ms,
                agg.has_unread,
                agg.msg_count,
                f.status,
                f.suggested_when,
                agg.is_inbox,
                agg.is_starred,
                agg.is_trash,
                agg.is_spam,
                agg.is_draft,
                agg.is_sent
            FROM (
                SELECT
                    thread_id,
                    MAX(internal_date_ms) AS max_date,
                    MAX(id) AS max_id,
                    MAX(unread) AS has_unread,
                    COUNT(*) AS msg_count,
                    MAX(CASE WHEN labels_json LIKE '%\"INBOX\"%' THEN 1 ELSE 0 END) AS is_inbox,
                    MAX(CASE WHEN labels_json LIKE '%\"STARRED\"%' THEN 1 ELSE 0 END) AS is_starred,
                    MAX(CASE WHEN labels_json LIKE '%\"TRASH\"%' THEN 1 ELSE 0 END) AS is_trash,
                    MAX(CASE WHEN labels_json LIKE '%\"SPAM\"%' THEN 1 ELSE 0 END) AS is_spam,
                    MAX(CASE WHEN labels_json LIKE '%\"DRAFT\"%' THEN 1 ELSE 0 END) AS is_draft,
                    MAX(CASE WHEN labels_json LIKE '%\"SENT\"%' THEN 1 ELSE 0 END) AS is_sent
                FROM messages
                {where_clause}
                GROUP BY thread_id
            ) agg
            JOIN messages m
              ON m.id = agg.max_id
            LEFT JOIN accounts a
              ON a.email = m.account_email
            LEFT JOIN thread_followups f
              ON f.thread_id = m.thread_id
            {outer_where}
            ORDER BY agg.max_date DESC
            LIMIT ?{}
            ",
            param_count + 1
        );

        let map_row = |row: &rusqlite::Row| -> Result<ThreadListItemDto, rusqlite::Error> {
            let msg_count: usize = row.get::<_, i64>(10)? as usize;
            let snippet: String = row.get(6)?;
            let density = if msg_count == 1 && (snippet.len() < 110 || snippet.chars().count() < 110) {
                "compacta"
            } else if msg_count >= 3 {
                "densa"
            } else {
                "padrao"
            };

            Ok(ThreadListItemDto {
                id: row.get(0)?,
                account_email: row.get(1)?,
                account_label: row.get(2)?,
                from_name: row.get(3)?,
                from_email: row.get(4)?,
                subject: row.get(5)?,
                snippet,
                display_date: row.get(7)?,
                internal_date_ms: row.get(8)?,
                unread: row.get::<_, i32>(9)? != 0,
                message_count: msg_count,
                visual_density: density.to_string(),
                followup_status: row.get(11)?,
                followup_label: row.get(12)?,
                is_inbox: row.get::<_, i32>(13)? != 0,
                is_starred: row.get::<_, i32>(14)? != 0,
                is_trash: row.get::<_, i32>(15)? != 0,
                is_spam: row.get::<_, i32>(16)? != 0,
                is_draft: row.get::<_, i32>(17)? != 0,
                is_sent: row.get::<_, i32>(18)? != 0,
            })
        };

        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = match (&acc_param, &q_norm) {
            (Some(acc), Some(q)) => {
                let like_pattern = format!("%{}%", q);
                stmt.query_map(params![acc, like_pattern, limit as i64], map_row)?
            }
            (Some(acc), None) => {
                stmt.query_map(params![acc, limit as i64], map_row)?
            }
            (None, Some(q)) => {
                let like_pattern = format!("%{}%", q);
                stmt.query_map(params![like_pattern, limit as i64], map_row)?
            }
            (None, None) => {
                stmt.query_map(params![limit as i64], map_row)?
            }
        };

        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok(items)
    }

    pub fn get_thread_detail(&self, thread_id: &str) -> Result<Option<ThreadDetailDto>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "SELECT id, account_email, from_name, from_email, to_header,
                    subject, snippet, display_date, internal_date_ms, unread,
                    body_plain, body_fetched, body_html, attachments_json, list_unsubscribe
             FROM messages
             WHERE thread_id = ?1
             ORDER BY internal_date_ms ASC",
        )?;

        let rows = stmt.query_map(params![thread_id], |row| {
            let atts_raw: String = row.get(13).unwrap_or_else(|_| "[]".to_string());
            let attachments: Vec<MessageAttachmentDto> =
                serde_json::from_str(&atts_raw).unwrap_or_default();

            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(5)?,
                row.get::<_, i32>(9)? != 0,
                MessageDetailDto {
                    id: row.get(0)?,
                    sender_name: row.get(2)?,
                    sender_email: row.get(3)?,
                    to_header: row.get(4)?,
                    display_date: row.get(7)?,
                    internal_date_ms: row.get(8)?,
                    snippet: row.get(6)?,
                    body_plain: row.get(10)?,
                    body_html: row.get(12).ok(),
                    attachments,
                    body_fetched: row.get::<_, i32>(11)? != 0,
                    list_unsubscribe: row.get(14).ok(),
                },
            ))
        })?;

        let mut account_email = String::new();
        let mut subject = String::new();
        let mut any_unread = false;
        let mut messages = Vec::new();

        for r in rows {
            let (acc, subj, unread, msg) = r?;
            if account_email.is_empty() {
                account_email = acc;
            }
            if subject.is_empty() {
                subject = subj;
            }
            if unread {
                any_unread = true;
            }
            messages.push(msg);
        }

        if messages.is_empty() {
            return Ok(None);
        }

        let mut fup_stmt = conn.prepare_cached(
            "SELECT detected_quote, suggested_when, status
             FROM thread_followups WHERE thread_id = ?1",
        )?;
        let follow_up = fup_stmt
            .query_row(params![thread_id], |r| {
                Ok(FollowUpDto {
                    detected_quote: r.get(0)?,
                    suggested_when: r.get(1)?,
                    status: r.get(2)?,
                })
            })
            .optional()?;

        Ok(Some(ThreadDetailDto {
            id: thread_id.to_string(),
            account_email,
            subject,
            unread: any_unread,
            messages,
            follow_up,
        }))
    }

    pub fn upsert_followup(
        &self,
        thread_id: &str,
        account_email: &str,
        detected_quote: &str,
        suggested_when: &str,
        status: &str,
    ) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "INSERT INTO thread_followups (thread_id, account_email, detected_quote, suggested_when, status)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(thread_id) DO UPDATE SET
                detected_quote = excluded.detected_quote,
                suggested_when = excluded.suggested_when,
                status = excluded.status",
        )?;
        stmt.execute(params![thread_id, account_email.to_ascii_lowercase(), detected_quote, suggested_when, status])?;
        Ok(())
    }

    /// Verifica se um destinatário pertence à allowlist local de contactos conhecidos (§2.3).
    pub fn is_recipient_allowlisted(&self, email: &str) -> Result<bool, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached("SELECT 1 FROM known_contacts WHERE email = ?1")?;
        let exists = stmt.exists(params![email.trim().to_ascii_lowercase()])?;
        Ok(exists)
    }

    pub fn add_manual_trusted_contact(&self, email: &str, display_name: &str, now_epoch: i64) -> Result<(), DbError> {
        let conn = self.write_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "INSERT INTO known_contacts (email, display_name, source, updated_epoch)
             VALUES (?1, ?2, 'manual-human', ?3)
             ON CONFLICT(email) DO UPDATE SET source = 'manual-human', updated_epoch = excluded.updated_epoch",
        )?;
        stmt.execute(params![email.trim().to_ascii_lowercase(), display_name, now_epoch])?;
        Ok(())
    }

    pub fn get_total_unread_count(&self) -> Result<i64, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let mut stmt = conn.prepare_cached(
            "SELECT COUNT(DISTINCT thread_id) FROM messages WHERE unread = 1",
        )?;
        let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap_or(0);
        Ok(count)
    }

    pub fn search_threads_fts(
        &self,
        raw_query: &str,
        account_email: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ThreadListItemDto>, DbError> {
        let conn = self.read_conn.lock().map_err(|_| DbError::PoisonedLock)?;
        let clean_query = sanitize_fts5_query(raw_query);
        if clean_query.is_empty() {
            return Ok(Vec::new());
        }

        let sql = if account_email.is_some() {
            "SELECT m.thread_id, m.account_email, COALESCE(a.label, m.account_email), m.from_name, m.from_email,
                    m.subject, m.snippet, m.display_date, m.internal_date_ms, m.unread,
                    COUNT(m.id) as msg_count, f.status, f.suggested_when,
                    MAX(CASE WHEN m.labels_json LIKE '%\"INBOX\"%' THEN 1 ELSE 0 END) AS is_inbox,
                    MAX(CASE WHEN m.labels_json LIKE '%\"STARRED\"%' THEN 1 ELSE 0 END) AS is_starred,
                    MAX(CASE WHEN m.labels_json LIKE '%\"TRASH\"%' THEN 1 ELSE 0 END) AS is_trash,
                    MAX(CASE WHEN m.labels_json LIKE '%\"SPAM\"%' THEN 1 ELSE 0 END) AS is_spam,
                    MAX(CASE WHEN m.labels_json LIKE '%\"DRAFT\"%' THEN 1 ELSE 0 END) AS is_draft,
                    MAX(CASE WHEN m.labels_json LIKE '%\"SENT\"%' THEN 1 ELSE 0 END) AS is_sent
             FROM (
                 SELECT message_id, bm25(messages_fts) AS rank
                 FROM messages_fts
                 WHERE messages_fts MATCH ?1
                 ORDER BY rank ASC
                 LIMIT 200
             ) hits
             JOIN messages m ON m.id = hits.message_id
             LEFT JOIN accounts a ON a.email = m.account_email
             LEFT JOIN thread_followups f ON f.thread_id = m.thread_id
             WHERE m.account_email = ?2
             GROUP BY m.thread_id
             ORDER BY hits.rank ASC, m.internal_date_ms DESC
             LIMIT ?3"
        } else {
            "SELECT m.thread_id, m.account_email, COALESCE(a.label, m.account_email), m.from_name, m.from_email,
                    m.subject, m.snippet, m.display_date, m.internal_date_ms, m.unread,
                    COUNT(m.id) as msg_count, f.status, f.suggested_when,
                    MAX(CASE WHEN m.labels_json LIKE '%\"INBOX\"%' THEN 1 ELSE 0 END) AS is_inbox,
                    MAX(CASE WHEN m.labels_json LIKE '%\"STARRED\"%' THEN 1 ELSE 0 END) AS is_starred,
                    MAX(CASE WHEN m.labels_json LIKE '%\"TRASH\"%' THEN 1 ELSE 0 END) AS is_trash,
                    MAX(CASE WHEN m.labels_json LIKE '%\"SPAM\"%' THEN 1 ELSE 0 END) AS is_spam,
                    MAX(CASE WHEN m.labels_json LIKE '%\"DRAFT\"%' THEN 1 ELSE 0 END) AS is_draft,
                    MAX(CASE WHEN m.labels_json LIKE '%\"SENT\"%' THEN 1 ELSE 0 END) AS is_sent
             FROM (
                 SELECT message_id, bm25(messages_fts) AS rank
                 FROM messages_fts
                 WHERE messages_fts MATCH ?1
                 ORDER BY rank ASC
                 LIMIT 200
             ) hits
             JOIN messages m ON m.id = hits.message_id
             LEFT JOIN accounts a ON a.email = m.account_email
             LEFT JOIN thread_followups f ON f.thread_id = m.thread_id
             GROUP BY m.thread_id
             ORDER BY hits.rank ASC, m.internal_date_ms DESC
             LIMIT ?2"
        };

        let mut stmt = conn.prepare_cached(sql)?;
        let map_row = |row: &rusqlite::Row| -> Result<ThreadListItemDto, rusqlite::Error> {
            let msg_count: usize = row.get::<_, i64>(10).unwrap_or(1) as usize;
            let snippet: String = row.get(6)?;
            let density = if msg_count == 1 && snippet.len() < 110 {
                "compacta"
            } else if msg_count >= 3 {
                "densa"
            } else {
                "padrao"
            };

            Ok(ThreadListItemDto {
                id: row.get(0)?,
                account_email: row.get(1)?,
                account_label: row.get(2)?,
                from_name: row.get(3)?,
                from_email: row.get(4)?,
                subject: row.get(5)?,
                snippet,
                display_date: row.get(7)?,
                internal_date_ms: row.get(8)?,
                unread: row.get::<_, i32>(9)? != 0,
                message_count: msg_count,
                visual_density: density.to_string(),
                followup_status: row.get(11)?,
                followup_label: row.get(12)?,
                is_inbox: row.get::<_, i32>(13).unwrap_or(1) != 0,
                is_starred: row.get::<_, i32>(14).unwrap_or(0) != 0,
                is_trash: row.get::<_, i32>(15).unwrap_or(0) != 0,
                is_spam: row.get::<_, i32>(16).unwrap_or(0) != 0,
                is_draft: row.get::<_, i32>(17).unwrap_or(0) != 0,
                is_sent: row.get::<_, i32>(18).unwrap_or(0) != 0,
            })
        };

        let rows = if let Some(acc) = account_email {
            stmt.query_map(params![clean_query, acc.to_ascii_lowercase(), limit as i64], map_row)?
        } else {
            stmt.query_map(params![clean_query, limit as i64], map_row)?
        };

        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok(items)
    }
}

pub fn sanitize_fts5_query(raw: &str) -> String {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .map(|w| {
            let cleaned: String = w
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '@' || *c == '.')
                .collect();
            cleaned
        })
        .filter(|s| !s.is_empty())
        .map(|s| format!("{}*", s))
        .collect();
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fts5_availability() {
        let db = LocalDatabase::open_in_memory().unwrap();
        let conn = db.write_conn.lock().unwrap();
        let res = conn.execute_batch("CREATE VIRTUAL TABLE test_fts USING fts5(content);");
        assert!(res.is_ok(), "FTS5 should be available: {:?}", res.err());
    }

    #[test]
    fn offline_cache_persists_threads_and_filters_already_synced_ids() {
        let db = LocalDatabase::open_in_memory().unwrap();
        db.upsert_account(
            "ines@atelier.pt",
            "Atelier",
            GmailScopeMode::ModifyAndLabels,
            Some("9001"),
        )
        .unwrap();

        db.upsert_messages_batch(&[
            UpsertMessageRecord {
                id: "m1".into(),
                thread_id: "t1".into(),
                account_email: "ines@atelier.pt".into(),
                from_name: "João Vasconcelos".into(),
                from_email: "joao@matriz.pt".into(),
                to_header: "ines@atelier.pt".into(),
                subject: "Orçamento Q3".into(),
                snippet: "Envio proposta consolidada na sexta-feira".into(),
                internal_date_ms: 1_700_000_000_000,
                display_date: "14:10".into(),
                unread: true,
                labels_json: "[\"INBOX\",\"UNREAD\"]".into(),
                body_plain: None,
                body_html: None,
                attachments_json: None,
                list_unsubscribe: None,
            },
        ])
        .unwrap();

        // Nunca pedir messages.get para IDs já em cache (§1.3.3)
        let missing = db
            .filter_missing_message_ids(&["m1".into(), "m2_new".into()])
            .unwrap();
        assert_eq!(missing, vec!["m2_new".to_string()]);

        // Listagem leve funciona 100% offline a partir de SQLite
        let threads = db.list_threads_lightweight(None, None, None, 50).unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].subject, "Orçamento Q3");

        // Pesquisa local em SQLite com LIKE indexado
        let matching = db.list_threads_lightweight(None, Some("Orçamento"), None, 50).unwrap();
        assert_eq!(matching.len(), 1);
        let empty_search = db.list_threads_lightweight(None, Some("inexistente"), None, 50).unwrap();
        assert_eq!(empty_search.len(), 0);

        // Pesquisa global instantânea em FTS5 com BM25 e tolerância diacrítica
        let fts_results = db.search_threads_fts("orçamento", None, 10).unwrap();
        assert_eq!(fts_results.len(), 1);
        assert_eq!(fts_results[0].subject, "Orçamento Q3");

        let fts_diacritics = db.search_threads_fts("orcamento", None, 10).unwrap();
        assert_eq!(fts_diacritics.len(), 1);
        assert_eq!(fts_diacritics[0].subject, "Orçamento Q3");

        // Filtro por conta
        let acc_threads = db.list_threads_lightweight(Some("ines@atelier.pt"), None, None, 50).unwrap();
        assert_eq!(acc_threads.len(), 1);
        let other_acc = db.list_threads_lightweight(Some("outra@conta.pt"), None, None, 50).unwrap();
        assert_eq!(other_acc.len(), 0);

        // Remetente foi registado automaticamente na allowlist de contactos conhecidos
        assert!(db.is_recipient_allowlisted("joao@matriz.pt").unwrap());
        assert!(!db.is_recipient_allowlisted("attacker@evil.com").unwrap());

        // Testar batch labels e batch unread
        db.update_threads_labels_batch(&[("t1", &["STARRED"], &["INBOX"])]).unwrap();
        let detail = db.get_thread_detail("t1").unwrap().unwrap();
        assert_eq!(detail.messages.len(), 1);

        db.update_threads_unread_batch(&["t1"], false).unwrap();
        let detail_read = db.get_thread_detail("t1").unwrap().unwrap();
        assert!(!detail_read.unread);

        // Testar batch delete
        db.delete_threads_local_batch(&["t1"]).unwrap();
        assert!(db.get_thread_detail("t1").unwrap().is_none());
    }
}
