use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::fs_util::write_atomic;

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
    load_config_from_path(&config_path(app)?)
}

pub fn load_config_from_path(path: &Path) -> Result<Config, AppError> {
    crate::fs_util::recover_replaced(path).map_err(crate::error::config_io_error)?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let bytes = std::fs::read(path).map_err(crate::error::config_io_error)?;
    match serde_json::from_slice(&bytes) {
        Ok(config) => Ok(config),
        Err(e) => {
            let bak = path.with_extension("json.bak");
            if let Err(rename_err) = std::fs::rename(path, &bak) {
                log::warn!(
                    "parse config failed ({e}); could not quarantine {}: {rename_err}",
                    path.display()
                );
            } else {
                log::warn!(
                    "parse config failed ({e}); moved damaged file to {}",
                    bak.display()
                );
            }
            Ok(Config::default())
        }
    }
}

pub fn save_config(app: &AppHandle, config: &Config) -> Result<(), AppError> {
    save_config_to_path(&config_path(app)?, config)
}

pub fn save_config_to_path(path: &Path, config: &Config) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(crate::error::config_io_error)?;
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|e| AppError::Config(format!("serialize config: {e}")))?;
    write_atomic(path, &bytes).map_err(crate::error::config_io_error)?;
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

    #[test]
    fn load_recovers_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, b"{not-json").unwrap();
        let loaded = load_config_from_path(&path).unwrap();
        assert_eq!(loaded.execution_provider(), "cpu");
        assert!(!path.exists());
        assert!(dir.path().join("config.json.bak").exists());
    }

    #[test]
    fn save_is_atomic_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = Config {
            execution_provider: Some("cuda".into()),
            output_dir: Some("/tmp".into()),
        };
        save_config_to_path(&path, &config).unwrap();
        let loaded = load_config_from_path(&path).unwrap();
        assert_eq!(loaded.execution_provider(), "cuda");
        assert_eq!(loaded.output_dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn load_recovers_stranded_replace_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let bak = dir.path().join("config.json.old");
        std::fs::write(
            &bak,
            br#"{"execution_provider":"cuda","output_dir":"/kept"}"#,
        )
        .unwrap();

        let loaded = load_config_from_path(&path).unwrap();

        assert_eq!(loaded.execution_provider(), "cuda");
        assert_eq!(loaded.output_dir.as_deref(), Some("/kept"));
        assert!(path.exists());
        assert!(!bak.exists());
    }
}
