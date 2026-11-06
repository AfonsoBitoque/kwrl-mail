//! Validação Estrita de Inputs nos Comandos IPC Tauri (§3.1)
//!
//! Todos os comandos `#[tauri::command]` validam comprimentos máximos, ausência de bytes nulos
//! e conjuntos de caracteres permitidos antes de aceder a SQLite, Keychain ou processos filhos.

use thiserror::Error;

pub const MAX_IPC_PAYLOAD_BYTES: usize = 1_048_576; // 1 MB máximo global (§3.1)
pub const MAX_ATTACHMENTS_TOTAL_BYTES: usize = 25 * 1024 * 1024; // Limite de 25 MB do Gmail
pub const MAX_REWRITE_TEXT_LEN: usize = 65_536; // 64 KB para reescrita de texto por IA
const MAX_ID_LEN: usize = 160;
const MAX_QUERY_LEN: usize = 512;
const MAX_EMAIL_LEN: usize = 254;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IpcValidationError {
    #[error("Input rejeitado: contém bytes nulos inválidos.")]
    NullByteDetected,
    #[error("Input rejeitado: excede o limite máximo permitido ({max} bytes).")]
    PayloadTooLarge { max: usize },
    #[error("Identificador '{field}' contém caracteres não permitidos.")]
    InvalidIdentifierCharacters { field: &'static str },
    #[error("Campo obrigatório '{field}' encontra-se vazio.")]
    EmptyField { field: &'static str },
    #[error("O tamanho total dos anexos ({actual} bytes) excede o limite máximo de {max} bytes (25 MB).")]
    AttachmentsTooLarge { actual: usize, max: usize },
}

pub fn validate_non_null_bounded<'a>(
    field: &'static str,
    value: &'a str,
    max_bytes: usize,
) -> Result<&'a str, IpcValidationError> {
    let effective_max = max_bytes.min(MAX_IPC_PAYLOAD_BYTES);
    if memchr::memchr(b'\0', value.as_bytes()).is_some() {
        return Err(IpcValidationError::NullByteDetected);
    }
    if value.len() > effective_max {
        return Err(IpcValidationError::PayloadTooLarge { max: effective_max });
    }
    if value.trim().is_empty() {
        return Err(IpcValidationError::EmptyField { field });
    }
    Ok(value.trim())
}

pub fn validate_gmail_id(field: &'static str, id: &str) -> Result<String, IpcValidationError> {
    let clean = validate_non_null_bounded(field, id, MAX_ID_LEN)?;
    if !clean
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(IpcValidationError::InvalidIdentifierCharacters { field });
    }
    Ok(clean.to_string())
}

pub fn validate_email_address(email: &str) -> Result<String, IpcValidationError> {
    let clean = validate_non_null_bounded("email", email, MAX_EMAIL_LEN)?;
    if !clean.contains('@') || clean.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) {
        return Err(IpcValidationError::InvalidIdentifierCharacters { field: "email" });
    }
    Ok(clean.to_ascii_lowercase())
}

pub fn validate_optional_search_query(
    query: Option<&str>,
) -> Result<Option<String>, IpcValidationError> {
    let Some(q) = query else {
        return Ok(None);
    };
    if memchr::memchr(b'\0', q.as_bytes()).is_some() {
        return Err(IpcValidationError::NullByteDetected);
    }
    if q.len() > MAX_QUERY_LEN {
        return Err(IpcValidationError::PayloadTooLarge { max: MAX_QUERY_LEN });
    }
    let trimmed = q.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub fn validate_attachments_total_bytes(total_bytes: usize) -> Result<(), IpcValidationError> {
    if total_bytes > MAX_ATTACHMENTS_TOTAL_BYTES {
        return Err(IpcValidationError::AttachmentsTooLarge {
            actual: total_bytes,
            max: MAX_ATTACHMENTS_TOTAL_BYTES,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_null_bytes_oversized_strings_and_path_traversal_ids() {
        assert_eq!(
            validate_gmail_id("thread_id", "18f9a\0bad"),
            Err(IpcValidationError::NullByteDetected)
        );
        assert_eq!(
            validate_gmail_id("thread_id", "../etc/passwd"),
            Err(IpcValidationError::InvalidIdentifierCharacters {
                field: "thread_id"
            })
        );

        let over_1mb = "a".repeat(MAX_IPC_PAYLOAD_BYTES + 1);
        assert_eq!(
            validate_non_null_bounded("draft", &over_1mb, MAX_IPC_PAYLOAD_BYTES),
            Err(IpcValidationError::PayloadTooLarge {
                max: MAX_IPC_PAYLOAD_BYTES
            })
        );
    }
}
