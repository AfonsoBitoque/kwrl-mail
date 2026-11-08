//! Autenticação Google OAuth 2.0 para Aplicações Desktop (Loopback + PKCE S256, §1.1)
//!
//! Cumpre integralmente a RFC 8252 (OAuth 2.0 for Native Apps):
//! 1. PKCE S256 obrigatório (32 bytes CSPRNG -> base64url -> SHA-256).
//! 2. Consentimento aberto exclusivamente no browser padrão do sistema (`open::that`),
//!    nunca dentro da WebView do Tauri.
//! 3. Listener HTTP efémero em `127.0.0.1:0` (porta aleatória atribuída pelo kernel),
//!    encerrado imediatamente após receber o primeiro callback válido.
//! 4. Validação estrita do parâmetro `state` em tempo constante contra ataques CSRF.
//! 5. Scopes mínimos: `gmail.modify` + `gmail.labels` ou `gmail.readonly` (nunca `gmail.send` por omissão).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;
use zeroize::Zeroizing;

use crate::secure_store::{SecureStoreError, TokenManager};

const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_ENDPOINT: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const LOOPBACK_CALLBACK_PATH: &str = "/oauth2callback";
const LOOPBACK_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GmailScopeMode {
    /// Leitura + gestão de etiquetas, SEM permissão de envio (`gmail.send` excluído)
    ModifyAndLabels,
    /// Modo estritamente de leitura
    ReadOnly,
}

impl GmailScopeMode {
    pub fn as_scope_string(self) -> &'static str {
        match self {
            GmailScopeMode::ModifyAndLabels => {
                "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels"
            }
            GmailScopeMode::ReadOnly => "https://www.googleapis.com/auth/gmail.readonly",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopOAuthClientConfig {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedSessionInfo {
    pub email: String,
    pub scope_mode: GmailScopeMode,
    pub initial_history_id: String,
}

#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("Configuração OAuth Desktop inválida: {0}")]
    InvalidClientConfig(String),
    #[error("Falha ao abrir listener loopback em 127.0.0.1: {0}")]
    LoopbackBindError(String),
    #[error("Tempo limite esgotado à espera da autorização no browser do sistema.")]
    AuthorizationTimeout,
    #[error("Possível ataque CSRF detetado: parâmetro 'state' OAuth inválido.")]
    CsrfStateMismatch,
    #[error("Autorização recusada ou cancelada pelo utilizador: {0}")]
    AuthorizationDenied(String),
    #[error("Callback OAuth malformado sem código de autorização.")]
    MissingAuthorizationCode,
    #[error("Falha ao abrir o browser predefinido do sistema: {0}")]
    BrowserLaunchFailed(String),
    #[error("Sessão expirada ou revogada na conta Google (invalid_grant). Autentica novamente.")]
    TokenRevokedOrExpired,
    #[error("Erro no endpoint OAuth da Google (HTTP {status}): {detail}")]
    TokenEndpointFailure { status: u16, detail: String },
    #[error("Erro de transporte TLS: {0}")]
    NetworkError(String),
    #[error("Erro no armazenamento seguro de credenciais: {0}")]
    SecureStore(#[from] SecureStoreError),
}

pub struct PkcePair {
    pub verifier: Zeroizing<String>,
    pub challenge: String,
}

/// Gera par PKCE S256 em conformidade com RFC 7636 (32 bytes aleatórios -> base64url).
pub fn generate_pkce_pair() -> PkcePair {
    let mut raw_bytes = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut *raw_bytes);
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(*raw_bytes));
    let challenge = compute_s256_challenge(&verifier);
    PkcePair {
        verifier,
        challenge,
    }
}

pub fn compute_s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn generate_csrf_state() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Comparação em tempo constante para prevenir side-channel no parâmetro `state`.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.as_bytes().iter().zip(b.as_bytes().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn build_google_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    scope_mode: GmailScopeMode,
    state: &str,
    code_challenge: &str,
) -> Result<String, OAuthError> {
    if client_id.trim().is_empty() || client_id.contains('\0') {
        return Err(OAuthError::InvalidClientConfig(
            "client_id vazio ou inválido.".into(),
        ));
    }

    let mut url = Url::parse(GOOGLE_AUTH_ENDPOINT)
        .map_err(|e| OAuthError::InvalidClientConfig(e.to_string()))?;

    url.query_pairs_mut()
        .append_pair("client_id", client_id.trim())
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", scope_mode.as_scope_string())
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "select_account consent");

    Ok(url.into())
}

/// Aguarda exatamente um callback OAuth válido em `listener` e fecha-o imediatamente ao retornar.
pub async fn await_loopback_authorization_code(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<Zeroizing<String>, OAuthError> {
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(OAuthError::AuthorizationTimeout);
        }

        let (mut stream, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| OAuthError::AuthorizationTimeout)?
            .map_err(|e| OAuthError::LoopbackBindError(e.to_string()))?;

        let mut buf = [0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .map_err(|_| OAuthError::AuthorizationTimeout)?
            .map_err(|e| OAuthError::LoopbackBindError(e.to_string()))?;

        if n == 0 {
            continue;
        }

        let req_line = String::from_utf8_lossy(&buf[..n]);
        let first_line = req_line.lines().next().unwrap_or_default();
        let path_part = first_line.split_whitespace().nth(1).unwrap_or("/");

        // Ignora pedidos automáticos do browser a /favicon.ico sem derrubar a espera do callback
        if !path_part.starts_with(LOOPBACK_CALLBACK_PATH) {
            let _ = write_http_response(
                &mut stream,
                "404 Not Found",
                false,
                "Recurso não encontrado",
                "O endereço solicitado não é reconhecido pelo Corvo.",
            )
            .await;
            continue;
        }

        let parsed = Url::parse(&format!("http://127.0.0.1{}", path_part))
            .map_err(|_| OAuthError::MissingAuthorizationCode)?;

        let mut code: Option<String> = None;
        let mut received_state: Option<String> = None;
        let mut oauth_err: Option<String> = None;

        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => received_state = Some(v.into_owned()),
                "error" => oauth_err = Some(v.into_owned()),
                _ => {}
            }
        }

        if let Some(err_code) = oauth_err {
            let _ = write_http_response(
                &mut stream,
                "400 Bad Request",
                false,
                "Autorização cancelada",
                "A autorização no Google foi cancelada. Podes fechar este separador e voltar ao Corvo.",
            )
            .await;
            drop(listener);
            return Err(OAuthError::AuthorizationDenied(err_code));
        }

        let state_ok = received_state
            .as_deref()
            .map(|s| constant_time_eq(s, expected_state))
            .unwrap_or(false);

        if !state_ok {
            let _ = write_http_response(
                &mut stream,
                "400 Bad Request",
                false,
                "Erro de segurança",
                "A validação de segurança CSRF falhou (parâmetro state inválido). Podes fechar este separador e tentar novamente.",
            )
            .await;
            drop(listener);
            return Err(OAuthError::CsrfStateMismatch);
        }

        match code {
            Some(c) if !c.trim().is_empty() => {
                let _ = write_http_response(
                    &mut stream,
                    "200 OK",
                    true,
                    "Sessão iniciada com sucesso",
                    "A tua conta Google foi autenticada no Corvo. Podes fechar este separador e regressar à aplicação.",
                )
                .await;
                // Fecha imediatamente o socket loopback efémero (§1.1.4)
                drop(listener);
                return Ok(Zeroizing::new(c));
            }
            _ => {
                let _ = write_http_response(
                    &mut stream,
                    "400 Bad Request",
                    false,
                    "Código de autorização em falta",
                    "A Google não devolveu um código de autorização válido. Tenta novamente no Corvo.",
                )
                .await;
                drop(listener);
                return Err(OAuthError::MissingAuthorizationCode);
            }
        }
    }
}

async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    is_success: bool,
    title: &str,
    message: &str,
) -> std::io::Result<()> {
    let icon_svg = if is_success {
        r#"<svg width="26" height="26" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M3.5 15.5L9.5 4.2L16.8 8.2L11.2 11.4L14.4 15.5H3.5Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
          <circle cx="11.4" cy="7.8" r="0.9" fill="currentColor"/>
        </svg>"#
    } else {
        r#"<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>"#
    };

    let pill_badge = if is_success {
        r#"<div class="pill">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Podes fechar este separador com segurança</span>
        </div>"#
    } else {
        r#"<div class="pill pill-error">
          <span>Verifica os dados e tenta novamente no Corvo</span>
        </div>"#
    };

    let html = format!(
        r#"<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Corvo · Início de Sessão</title>
  <style>
    :root {{
      --bg: #fcfbfc;
      --card: #ffffff;
      --ink: #1e1a22;
      --mute: #5e576a;
      --line: #e6e2e8;
      --acc: #7567a3;
      --soft: #f0eef6;
      --shadow: 0 8px 30px rgba(30, 26, 34, 0.05);
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #151218;
        --card: #1c181f;
        --ink: #efeaf2;
        --mute: #aca5b4;
        --line: #2d2832;
        --acc: #b4a9d6;
        --soft: #222030;
        --shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
      }}
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background-color: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }}
    .card {{
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }}
    .icon-box {{
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: var(--soft);
      border: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--acc);
      margin-bottom: 18px;
    }}
    .kicker {{
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--acc);
      margin-bottom: 8px;
    }}
    h1 {{
      font-size: 20px;
      font-weight: 600;
      color: var(--ink);
      margin-bottom: 10px;
      line-height: 1.3;
    }}
    p {{
      font-size: 14px;
      line-height: 1.6;
      color: var(--mute);
      margin-bottom: 24px;
    }}
    .pill {{
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 16px;
      border-radius: 9999px;
      background: var(--soft);
      border: 1px solid var(--line);
      font-size: 12.5px;
      color: var(--mute);
      font-weight: 500;
    }}
    .pill-error {{
      color: #b91c1c;
      background: rgba(239, 68, 68, 0.08);
      border-color: rgba(239, 68, 68, 0.2);
    }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-box">
      {}
    </div>
    <div class="kicker">Corvo · Correio Local</div>
    <h1>{}</h1>
    <p>{}</p>
    {}
  </div>
</body>
</html>"#,
        icon_svg, title, message, pill_badge
    );

    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        status,
        html.as_bytes().len(),
        html
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

#[derive(Deserialize)]
struct TokenEndpointSuccess {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenEndpointErrorBody {
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GmailProfileDto {
    #[serde(rename = "emailAddress")]
    email_address: String,
    #[serde(rename = "historyId")]
    history_id: String,
}

/// Executa o fluxo completo Desktop OAuth 2.0 + PKCE no browser do sistema.
pub async fn authenticate_desktop_google_account(
    http_client: &Client,
    token_manager: &TokenManager,
    config: &DesktopOAuthClientConfig,
    scope_mode: GmailScopeMode,
) -> Result<AuthenticatedSessionInfo, OAuthError> {
    if config.client_id.trim().is_empty() || config.client_secret.trim().is_empty() {
        return Err(OAuthError::InvalidClientConfig(
            "Introduz o Client ID e Client Secret da aplicação Desktop (Google Cloud Console).".into(),
        ));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| OAuthError::LoopbackBindError(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| OAuthError::LoopbackBindError(e.to_string()))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}{}", port, LOOPBACK_CALLBACK_PATH);
    let pkce = generate_pkce_pair();
    let csrf_state = generate_csrf_state();
    let auth_url = build_google_authorization_url(
        &config.client_id,
        &redirect_uri,
        scope_mode,
        &csrf_state,
        &pkce.challenge,
    )?;

    // Abre exclusivamente no browser padrão do SO (§1.1.3)
    open::that(&auth_url).map_err(|e| OAuthError::BrowserLaunchFailed(e.to_string()))?;

    let auth_code = await_loopback_authorization_code(
        listener,
        &csrf_state,
        Duration::from_secs(LOOPBACK_TIMEOUT_SECS),
    )
    .await?;

    let tokens = exchange_authorization_code_at_endpoint(
        http_client,
        GOOGLE_TOKEN_ENDPOINT,
        config,
        &auth_code,
        &pkce.verifier,
        &redirect_uri,
    )
    .await?;

    // Obtém emailAddress e historyId inicial na Gmail API (custo: apenas 1 unidade de quota)
    let profile_resp = http_client
        .get(GMAIL_PROFILE_ENDPOINT)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| OAuthError::NetworkError(e.to_string()))?;

    if !profile_resp.status().is_success() {
        let status = profile_resp.status();
        let body_text = profile_resp.text().await.unwrap_or_default();
        let friendly = if status.as_u16() == 403
            && (body_text.contains("accessNotConfigured")
                || body_text.contains("SERVICE_DISABLED")
                || body_text.contains("has not been used in project"))
        {
            "A Gmail API ainda está desativada no teu projeto Google Cloud. Abre console.cloud.google.com/apis/library/gmail.googleapis.com, clica em 'Ativar (Enable)', aguarda 30 segundos e tenta novamente.".to_string()
        } else if status.as_u16() == 403 && body_text.contains("insufficientPermissions") {
            "Faltou marcar a caixa de permissão do Gmail no ecrã da Google. Clica novamente em 'Continuar com Google' e marca o visto de acesso aos e-mails.".to_string()
        } else {
            format!("HTTP {} na Gmail API: {}", status, body_text)
        };
        return Err(OAuthError::NetworkError(friendly));
    }

    let profile: GmailProfileDto = profile_resp
        .json()
        .await
        .map_err(|e| OAuthError::NetworkError(e.to_string()))?;

    let now_epoch = current_unix_epoch();
    token_manager.persist_initial_tokens(
        &profile.email_address,
        &tokens.access_token,
        tokens.expires_in,
        tokens.refresh_token.as_deref(),
        now_epoch,
    )?;

    Ok(AuthenticatedSessionInfo {
        email: profile.email_address.to_ascii_lowercase(),
        scope_mode,
        initial_history_id: profile.history_id,
    })
}

async fn exchange_authorization_code_at_endpoint(
    http_client: &Client,
    token_endpoint: &str,
    config: &DesktopOAuthClientConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenEndpointSuccess, OAuthError> {
    let params = [
        ("client_id", config.client_id.trim()),
        ("client_secret", config.client_secret.trim()),
        ("code", code),
        ("code_verifier", code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];

    let resp = http_client
        .post(token_endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| OAuthError::NetworkError(e.to_string()))?;

    parse_token_response(resp).await
}

/// Obtém um `access_token` válido em RAM, ou renova silenciosamente lendo o `refresh_token`
/// do Keychain do SO e enviando-o para `https://oauth2.googleapis.com/token`.
pub async fn ensure_valid_access_token(
    http_client: &Client,
    token_manager: &TokenManager,
    config: &DesktopOAuthClientConfig,
    email: &str,
) -> Result<Zeroizing<String>, OAuthError> {
    ensure_valid_access_token_with_endpoint(
        http_client,
        GOOGLE_TOKEN_ENDPOINT,
        token_manager,
        config,
        email,
    )
    .await
}

pub(crate) async fn ensure_valid_access_token_with_endpoint(
    http_client: &Client,
    token_endpoint: &str,
    token_manager: &TokenManager,
    config: &DesktopOAuthClientConfig,
    email: &str,
) -> Result<Zeroizing<String>, OAuthError> {
    static RENEWAL_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    let now = current_unix_epoch();
    if let Some(cached) = token_manager.get_valid_access_token(email, now)? {
        return Ok(cached);
    }

    let _lock = RENEWAL_MUTEX.lock().await;

    // Double-check: outra task pode ter acabado de renovar o token enquanto esta aguardava pelo lock
    let now_recheck = current_unix_epoch();
    if let Some(cached) = token_manager.get_valid_access_token(email, now_recheck)? {
        return Ok(cached);
    }

    // Lê refresh_token do Keychain numa variável Zeroizing temporária
    let refresh_token = token_manager.read_refresh_token_for_renewal(email)?;

    let params = [
        ("client_id", config.client_id.trim()),
        ("client_secret", config.client_secret.trim()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];

    let resp = http_client
        .post(token_endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| OAuthError::NetworkError(e.to_string()))?;

    match parse_token_response(resp).await {
        Ok(fresh) => {
            let refreshed_now = current_unix_epoch();
            // Se a Google rodar o refresh_token, atualiza no Keychain; caso contrário apenas RAM
            if let Some(new_rt) = fresh.refresh_token.as_deref() {
                token_manager.persist_initial_tokens(
                    email,
                    &fresh.access_token,
                    fresh.expires_in,
                    Some(new_rt),
                    refreshed_now,
                )?;
            } else {
                token_manager.cache_access_token(
                    email,
                    &fresh.access_token,
                    fresh.expires_in,
                    refreshed_now,
                )?;
            }
            Ok(Zeroizing::new(fresh.access_token))
        }
        Err(OAuthError::TokenRevokedOrExpired) => {
            // Limpa credencial revogada do Keychain para forçar reautenticação limpa
            let _ = token_manager.purge_account_tokens(email);
            Err(OAuthError::TokenRevokedOrExpired)
        }
        Err(other) => Err(other),
    }
}

async fn parse_token_response(resp: reqwest::Response) -> Result<TokenEndpointSuccess, OAuthError> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<TokenEndpointSuccess>()
            .await
            .map_err(|e| OAuthError::NetworkError(e.to_string()));
    }

    let status_u16 = status.as_u16();
    let raw_body = resp.text().await.unwrap_or_default();
    if let Ok(parsed_err) = serde_json::from_str::<TokenEndpointErrorBody>(&raw_body) {
        if parsed_err.error.as_deref() == Some("invalid_grant") {
            return Err(OAuthError::TokenRevokedOrExpired);
        }
        let detail = parsed_err
            .error_description
            .or(parsed_err.error)
            .unwrap_or_else(|| "erro desconhecido".into());
        return Err(OAuthError::TokenEndpointFailure {
            status: status_u16,
            detail,
        });
    }

    Err(OAuthError::TokenEndpointFailure {
        status: status_u16,
        detail: raw_body.chars().take(200).collect(),
    })
}

fn current_unix_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::tests::InMemoryTestVault;
    use std::sync::Arc;

    #[test]
    fn pkce_s256_matches_rfc7636_appendix_b_vector() {
        // Vetor oficial RFC 7636 Appendix B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(compute_s256_challenge(verifier), expected_challenge);

        let generated = generate_pkce_pair();
        assert_eq!(generated.verifier.len(), 43);
        assert!(!generated.challenge.contains('='));
    }

    #[test]
    fn minimal_scopes_never_include_gmail_send() {
        let modify_url = build_google_authorization_url(
            "123.apps.googleusercontent.com",
            "http://127.0.0.1:54321/oauth2callback",
            GmailScopeMode::ModifyAndLabels,
            "state123",
            "challenge123",
        )
        .unwrap();
        assert!(modify_url.contains("gmail.modify"));
        assert!(modify_url.contains("gmail.labels"));
        assert!(!modify_url.contains("gmail.send"));
        assert!(modify_url.contains("code_challenge_method=S256"));
    }

    #[tokio::test]
    async fn loopback_rejects_csrf_state_mismatch_and_closes_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_task = tokio::spawn(async move {
            await_loopback_authorization_code(listener, "expected_state_xyz", Duration::from_secs(5))
                .await
        });

        let client = Client::new();
        let _ = client
            .get(format!(
                "http://{}/oauth2callback?code=4/0AbC&state=forged_attacker_state",
                addr
            ))
            .send()
            .await
            .unwrap();

        let result = server_task.await.unwrap();
        assert!(matches!(result, Err(OAuthError::CsrfStateMismatch)));

        // Garante que o socket loopback efémero foi efetivamente encerrado
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(tokio::net::TcpStream::connect(addr).await.is_err());
    }

    #[tokio::test]
    async fn expired_or_revoked_refresh_token_purges_keychain_and_returns_typed_error() {
        // Servidor HTTP local simulando resposta 400 invalid_grant do Google Token Endpoint
        let mock_oauth_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = mock_oauth_server.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut socket, _)) = mock_oauth_server.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let body = r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#;
                let reply = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });

        let vault = Arc::new(InMemoryTestVault::default());
        let mgr = TokenManager::with_vault(vault);
        mgr.persist_initial_tokens(
            "revoked@gmail.com",
            "expired_access",
            0, // já expirado
            Some("1//revoked_refresh"),
            100,
        )
        .unwrap();

        let cfg = DesktopOAuthClientConfig {
            client_id: "cid".into(),
            client_secret: "csec".into(),
        };

        let res = ensure_valid_access_token_with_endpoint(
            &Client::new(),
            &format!("http://{}/token", addr),
            &mgr,
            &cfg,
            "revoked@gmail.com",
        )
        .await;

        assert!(matches!(res, Err(OAuthError::TokenRevokedOrExpired)));
        assert!(!mgr.has_stored_session("revoked@gmail.com"));
    }
}
