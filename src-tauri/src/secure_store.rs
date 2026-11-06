//! Armazenamento Seguro de Credenciais OAuth (§1.2)
//!
//! Garantias arquiteturais:
//! 1. O `refresh_token` de longa duração é persistido exclusivamente no cofre nativo do SO
//!    via crate `keyring` (macOS Keychain, Windows Credential Manager, Linux Secret Service).
//!    Nunca toca em `localStorage`, ficheiros JSON, SQLite ou variáveis de ambiente.
//! 2. O `access_token` de curta duração vive exclusivamente em RAM (`RwLock<HashMap>`)
//!    envolvido em `Zeroizing<String>`, sendo limpo da memória no `Drop` ou ao expirar.
//! 3. Qualquer leitura do `refresh_token` devolve `Zeroizing<String>` para minimizar a janela
//!    de exposição em memória durante a renovação TLS.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "pt.corvo.mail.oauth.refresh";
/// Margem de segurança (segundos) antes da expiração real para renovar preventivamente
const EXPIRY_SAFETY_SKEW_SECS: i64 = 60;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SecureStoreError {
    #[error("Conta inválida para acesso ao Keychain.")]
    InvalidAccountIdentifier,
    #[error("Refresh token ausente no Keychain do sistema para '{0}'. Nova autenticação necessária.")]
    RefreshTokenNotFound(String),
    #[error("Falha no cofre de credenciais do sistema operativo: {0}")]
    KeychainFailure(String),
    #[error("Falha de sincronização interna do cache de tokens em memória.")]
    PoisonedLock,
}

/// Abstração sobre o cofre nativo do SO para permitir auditoria e testes determinísticos
/// de caminhos de erro (cofre apagado, bloqueado, rotação de credenciais).
pub trait RefreshTokenVault: Send + Sync {
    fn store_refresh_token(&self, email: &str, refresh_token: &str) -> Result<(), SecureStoreError>;
    fn load_refresh_token(&self, email: &str) -> Result<Zeroizing<String>, SecureStoreError>;
    fn delete_refresh_token(&self, email: &str) -> Result<(), SecureStoreError>;
}

/// Implementação de produção apoiada no Keychain nativo do SO (`keyring` crate).
#[derive(Default)]
pub struct OsKeychainVault;

impl RefreshTokenVault for OsKeychainVault {
    fn store_refresh_token(&self, email: &str, refresh_token: &str) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, normalized.as_ref())
            .map_err(|e| SecureStoreError::KeychainFailure(e.to_string()))?;
        entry
            .set_password(refresh_token)
            .map_err(|e| SecureStoreError::KeychainFailure(e.to_string()))
    }

    fn load_refresh_token(&self, email: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, normalized.as_ref())
            .map_err(|e| SecureStoreError::KeychainFailure(e.to_string()))?;
        match entry.get_password() {
            Ok(secret) if !secret.trim().is_empty() => Ok(Zeroizing::new(secret)),
            Ok(_) | Err(keyring::Error::NoEntry) => {
                Err(SecureStoreError::RefreshTokenNotFound(normalized.into_owned()))
            }
            Err(other) => Err(SecureStoreError::KeychainFailure(other.to_string())),
        }
    }

    fn delete_refresh_token(&self, email: &str) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, normalized.as_ref())
            .map_err(|e| SecureStoreError::KeychainFailure(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(other) => Err(SecureStoreError::KeychainFailure(other.to_string())),
        }
    }
}

/// Registo efémero de `access_token` exclusivamente em RAM.
struct InMemoryAccessEntry {
    access_token: Zeroizing<String>,
    expires_at_epoch: i64,
}

/// Gestor unificado de tokens OAuth:
/// - `refresh_token`: apenas no Keychain do SO
/// - `access_token`: apenas em memória volátil com `Zeroizing`
#[derive(Clone)]
pub struct TokenManager {
    vault: Arc<dyn RefreshTokenVault>,
    access_cache: Arc<RwLock<HashMap<String, InMemoryAccessEntry>>>,
    session_cache: Arc<RwLock<HashMap<String, bool>>>,
}

impl TokenManager {
    pub fn new_os_keychain() -> Self {
        Self::with_vault(Arc::new(OsKeychainVault))
    }

    pub fn with_vault(vault: Arc<dyn RefreshTokenVault>) -> Self {
        Self {
            vault,
            access_cache: Arc::new(RwLock::new(HashMap::new())),
            session_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Persiste o `refresh_token` no Keychain e guarda o `access_token` inicial apenas em RAM.
    pub fn persist_initial_tokens(
        &self,
        email: &str,
        access_token: &str,
        expires_in_secs: u64,
        refresh_token: Option<&str>,
        now_epoch: i64,
    ) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        if let Some(rt) = refresh_token {
            if !rt.trim().is_empty() {
                self.vault.store_refresh_token(normalized.as_ref(), rt)?;
                if let Ok(mut sc) = self.session_cache.write() {
                    sc.insert(normalized.to_string(), true);
                }
            }
        }
        self.cache_access_token(normalized.as_ref(), access_token, expires_in_secs, now_epoch)
    }

    /// Atualiza exclusivamente o `access_token` em memória após renovação via OAuth2.
    pub fn cache_access_token(
        &self,
        email: &str,
        access_token: &str,
        expires_in_secs: u64,
        now_epoch: i64,
    ) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let expires_at_epoch = now_epoch.saturating_add(expires_in_secs as i64);
        let mut guard = self
            .access_cache
            .write()
            .map_err(|_| SecureStoreError::PoisonedLock)?;
        guard.insert(
            normalized.into_owned(),
            InMemoryAccessEntry {
                access_token: Zeroizing::new(access_token.to_string()),
                expires_at_epoch,
            },
        );
        Ok(())
    }

    /// Devolve o `access_token` em memória apenas se ainda estiver dentro da janela de validade.
    pub fn get_valid_access_token(
        &self,
        email: &str,
        now_epoch: i64,
    ) -> Result<Option<Zeroizing<String>>, SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let guard = self
            .access_cache
            .read()
            .map_err(|_| SecureStoreError::PoisonedLock)?;
        if let Some(entry) = guard.get(normalized.as_ref()) {
            if now_epoch.saturating_add(EXPIRY_SAFETY_SKEW_SECS) < entry.expires_at_epoch {
                return Ok(Some(entry.access_token.clone()));
            }
        }
        Ok(None)
    }

    /// Invalida o `access_token` em RAM (ex: quando a Gmail API devolve 401 Unauthorized).
    pub fn evict_access_token(&self, email: &str) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let mut guard = self
            .access_cache
            .write()
            .map_err(|_| SecureStoreError::PoisonedLock)?;
        guard.remove(normalized.as_ref());
        Ok(())
    }

    /// Lê o `refresh_token` do Keychain apenas no instante da renovação.
    pub fn read_refresh_token_for_renewal(
        &self,
        email: &str,
    ) -> Result<Zeroizing<String>, SecureStoreError> {
        self.vault.load_refresh_token(email)
    }

    /// Verifica se existe sessão recuperável no Keychain após reinício da aplicação.
    pub fn has_stored_session(&self, email: &str) -> bool {
        let Ok(normalized) = normalize_account_key(email) else {
            return false;
        };
        if let Ok(sc) = self.session_cache.read() {
            if let Some(&cached) = sc.get(normalized.as_ref()) {
                return cached;
            }
        }
        let exists = self.vault.load_refresh_token(normalized.as_ref()).is_ok();
        if let Ok(mut sc) = self.session_cache.write() {
            sc.insert(normalized.into_owned(), exists);
        }
        exists
    }

    /// Revoga localmente a conta: limpa RAM (zeroize) e apaga entrada do Keychain do SO.
    pub fn purge_account_tokens(&self, email: &str) -> Result<(), SecureStoreError> {
        let normalized = normalize_account_key(email)?;
        let _ = self.evict_access_token(normalized.as_ref());
        if let Ok(mut sc) = self.session_cache.write() {
            sc.insert(normalized.to_string(), false);
        }
        self.vault.delete_refresh_token(normalized.as_ref())
    }
}

fn normalize_account_key(email: &str) -> Result<Cow<'_, str>, SecureStoreError> {
    let trimmed = email.trim();
    if trimmed.len() < 5
        || trimmed.len() > 254
        || !trimmed.contains('@')
        || trimmed.contains('\0')
    {
        return Err(SecureStoreError::InvalidAccountIdentifier);
    }
    if trimmed.bytes().all(|b| !b.is_ascii_uppercase()) {
        Ok(Cow::Borrowed(trimmed))
    } else {
        Ok(Cow::Owned(trimmed.to_ascii_lowercase()))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[derive(Default)]
    pub struct InMemoryTestVault {
        entries: RwLock<HashMap<String, Zeroizing<String>>>,
    }

    impl RefreshTokenVault for InMemoryTestVault {
        fn store_refresh_token(
            &self,
            email: &str,
            refresh_token: &str,
        ) -> Result<(), SecureStoreError> {
            let key = normalize_account_key(email)?;
            self.entries
                .write()
                .unwrap()
                .insert(key.into_owned(), Zeroizing::new(refresh_token.to_string()));
            Ok(())
        }

        fn load_refresh_token(&self, email: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            let key = normalize_account_key(email)?;
            self.entries
                .read()
                .unwrap()
                .get(key.as_ref())
                .cloned()
                .ok_or_else(|| SecureStoreError::RefreshTokenNotFound(key.into_owned()))
        }

        fn delete_refresh_token(&self, email: &str) -> Result<(), SecureStoreError> {
            let key = normalize_account_key(email)?;
            self.entries.write().unwrap().remove(key.as_ref());
            Ok(())
        }
    }

    #[test]
    fn access_token_lives_in_ram_and_expires_with_safety_skew() {
        let vault = Arc::new(InMemoryTestVault::default());
        let mgr = TokenManager::with_vault(vault);

        mgr.persist_initial_tokens(
            "Ines.Marques@Atelier-Norte.pt",
            "ya29.short_lived",
            3600,
            Some("1//0g_refresh_secret"),
            1_000,
        )
        .unwrap();

        // Válido no instante t=2000
        let valid = mgr
            .get_valid_access_token("ines.marques@atelier-norte.pt", 2_000)
            .unwrap();
        assert_eq!(valid.as_deref().map(|s| s.as_str()), Some("ya29.short_lived"));

        // Expirado dentro da janela de segurança de 60s (t = 1000 + 3600 - 30 = 4570)
        let expired = mgr
            .get_valid_access_token("ines.marques@atelier-norte.pt", 4_570)
            .unwrap();
        assert!(expired.is_none());

        // Mas o refresh_token persiste no cofre seguro para renovação silenciosa
        let refresh = mgr
            .read_refresh_token_for_renewal("ines.marques@atelier-norte.pt")
            .unwrap();
        assert_eq!(refresh.as_str(), "1//0g_refresh_secret");
    }

    #[test]
    fn restart_recovers_refresh_token_and_keychain_deletion_forces_reauth() {
        let shared_os_vault = Arc::new(InMemoryTestVault::default());

        // Execução 1 da aplicação
        {
            let mgr_first_run = TokenManager::with_vault(shared_os_vault.clone());
            mgr_first_run
                .persist_initial_tokens(
                    "user@gmail.com",
                    "ya29.first_boot",
                    3600,
                    Some("1//refresh_persisted"),
                    10_000,
                )
                .unwrap();
        }

        // Execução 2 (reinício: RAM vazia, mas Keychain mantém refresh_token)
        let mgr_after_restart = TokenManager::with_vault(shared_os_vault.clone());
        assert!(
            mgr_after_restart
                .get_valid_access_token("user@gmail.com", 10_010)
                .unwrap()
                .is_none()
        );
        assert!(mgr_after_restart.has_stored_session("user@gmail.com"));

        // Apagar entrada do Keychain exige nova autenticação (§5 Teste 2)
        mgr_after_restart
            .purge_account_tokens("user@gmail.com")
            .unwrap();
        assert!(!mgr_after_restart.has_stored_session("user@gmail.com"));
        assert_eq!(
            mgr_after_restart.read_refresh_token_for_renewal("user@gmail.com"),
            Err(SecureStoreError::RefreshTokenNotFound(
                "user@gmail.com".into()
            ))
        );
    }

    #[test]
    fn rejects_malformed_or_null_byte_identifiers() {
        let mgr = TokenManager::with_vault(Arc::new(InMemoryTestVault::default()));
        assert_eq!(
            mgr.persist_initial_tokens("bad\0email@gmail.com", "tok", 60, None, 0),
            Err(SecureStoreError::InvalidAccountIdentifier)
        );
        assert_eq!(
            mgr.persist_initial_tokens("sem-arroba", "tok", 60, None, 0),
            Err(SecureStoreError::InvalidAccountIdentifier)
        );
    }
}
