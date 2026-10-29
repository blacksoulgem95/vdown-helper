//! Errors a job ends with, coded like the extension's `JobErrorCode` so both sides show the same message.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    HttpError,
    Network,
    Protected,
    TooLarge,
    Ffmpeg,
    Decrypt,
    Invalid,
    Interrupted,
    Unknown,
    /// Not a failure: the user cancelled (the job ends in the `cancelled` stage).
    Cancelled,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HttpError => "http-error",
            Self::Network => "network",
            Self::Protected => "protected",
            Self::TooLarge => "too-large",
            Self::Ffmpeg => "ffmpeg",
            Self::Decrypt => "decrypt",
            Self::Invalid => "invalid",
            Self::Interrupted => "interrupted",
            Self::Unknown => "unknown",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Why a job stopped. Messages never carry URLs with credentials or tokens (they are redacted where a URL appears).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: String,
}

impl EngineError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn protected(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Protected, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled")
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == ErrorCode::Cancelled
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        Self::new(ErrorCode::Unknown, format!("Disk error: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
