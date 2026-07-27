use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub execution_provider: Option<String>,
    pub output_dir: Option<String>,
}

impl Config {
    pub fn execution_provider(&self) -> String {
        self.execution_provider
            .clone()
            .unwrap_or_else(|| "cpu".to_string())
    }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Config(e.to_string()))?;
    Ok(app_data.join("config.json"))
}

pub fn load_config(app: &AppHandle) -> Result<Config, AppError> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let bytes = std::fs::read(&path).map_err(crate::error::config_io_error)?;
    let config = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Config(format!("parse config: {e}")))?;
    Ok(config)
}

pub fn save_config(app: &AppHandle, config: &Config) -> Result<(), AppError> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(crate::error::config_io_error)?;
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|e| AppError::Config(format!("serialize config: {e}")))?;
    std::fs::write(&path, bytes).map_err(crate::error::config_io_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_cpu() {
        let config = Config::default();
        assert_eq!(config.execution_provider(), "cpu");
    }

    #[test]
    fn config_serde_round_trip() {
        let config = Config {
            execution_provider: Some("cuda".to_string()),
            output_dir: Some("/tmp".to_string()),
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.execution_provider(), "cuda");
        assert_eq!(parsed.output_dir, Some("/tmp".to_string()));
    }

    #[test]
    fn config_ignores_unknown_fields() {
        let json = r#"{
            "execution_provider": "cpu",
            "output_dir": null,
            "model_id": "u2netp",
            "platform": "linux"
        }"#;
        let parsed: Config = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.execution_provider(), "cpu");
        assert_eq!(parsed.output_dir, None);
    }
}
