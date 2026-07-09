use serde::Serialize;

/// The single error type surfaced across the IPC boundary. It serializes to a
/// plain string so the frontend can render it directly.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("no project is currently open")]
    NoProjectOpen,

    #[error("path is not a directory: {0}")]
    NotADirectory(String),

    #[error("not a git repository: {0}")]
    NotAGitRepo(String),

    #[error("test case not found: {0}")]
    CaseNotFound(String),

    #[error("run not found: {0}")]
    RunNotFound(String),

    #[error("invalid repository format: {0}")]
    InvalidFormat(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

// Tauri commands return this over IPC; serialize as the display string.
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::Other(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error::Other(s.to_string())
    }
}
