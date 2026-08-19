use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    #[serde(default)]
    pub kernel_path: String,
    #[serde(default)]
    pub default_cwd: String,
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api: ProviderApi,
    pub auth_header: bool,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApi {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GoogleGenerativeAi,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<ModelInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelInput {
    Text,
    Image,
}

pub fn validate(settings: &AppSettings) -> Result<(), String> {
    let mut ids = HashSet::new();
    for provider in &settings.providers {
        let id = provider.id.trim();
        if id.is_empty() {
            return Err("Every provider must have a non-empty ID.".to_owned());
        }
        if !ids.insert(id) {
            return Err(format!("Provider ID '{id}' is configured more than once."));
        }
        if provider.name.trim().is_empty() {
            return Err(format!("Provider '{id}' must have a display name."));
        }
        if provider.base_url.trim().is_empty() {
            return Err(format!("Provider '{id}' must have a base URL."));
        }
        if provider.models.is_empty() {
            return Err(format!("Provider '{id}' must define at least one model."));
        }

        let mut model_ids = HashSet::new();
        for model in &provider.models {
            let model_id = model.id.trim();
            if model_id.is_empty() {
                return Err(format!("Provider '{id}' has a model without an ID."));
            }
            if !model_ids.insert(model_id) {
                return Err(format!(
                    "Provider '{id}' configures model '{model_id}' more than once."
                ));
            }
        }
    }
    Ok(())
}

pub fn load(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    enforce_private_mode(&path)?;
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read app settings at {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "App settings at {} are invalid JSON: {error}",
            path.display()
        )
    })
}

pub fn save(app: &AppHandle, previous: &AppSettings, settings: &AppSettings) -> Result<(), String> {
    validate(settings)?;

    // Persist credentials first. If model sync fails, a retry still has the only
    // copy of each key and models.json contains references rather than secrets.
    write_json_atomic(&settings_path(app)?, settings, 0o600)?;
    sync_models(app, previous, settings)
}

pub fn sync_models(
    app: &AppHandle,
    previous: &AppSettings,
    settings: &AppSettings,
) -> Result<(), String> {
    let path = models_path(app)?;
    let existing = if path.exists() {
        let bytes = fs::read(&path).map_err(|error| {
            format!(
                "Could not read Pi model configuration at {}: {error}",
                path.display()
            )
        })?;
        serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "Pi model configuration at {} is invalid JSON: {error}",
                path.display()
            )
        })?
    } else {
        Value::Object(Map::new())
    };

    let merged = merge_models_document(existing, previous, settings)?;
    let mode = existing_mode(&path).unwrap_or(0o600);
    write_json_atomic(&path, &merged, mode)
}

pub fn provider_environment(settings: &AppSettings) -> Vec<(String, String)> {
    settings
        .providers
        .iter()
        .map(|provider| (provider_env_name(&provider.id), provider.api_key.clone()))
        .collect()
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| format!("Could not locate the app data directory: {error}"))
}

fn models_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map(|directory| directory.join(".pi/agent/models.json"))
        .map_err(|error| format!("Could not locate the home directory: {error}"))
}

fn merge_models_document(
    mut document: Value,
    previous: &AppSettings,
    settings: &AppSettings,
) -> Result<Value, String> {
    let root = document
        .as_object_mut()
        .ok_or_else(|| "Pi models.json must contain a JSON object at its root.".to_owned())?;
    let providers_value = root
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()));
    let providers = providers_value
        .as_object_mut()
        .ok_or_else(|| "Pi models.json field 'providers' must be a JSON object.".to_owned())?;

    let new_ids: HashSet<&str> = settings
        .providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect();

    for provider in &previous.providers {
        if new_ids.contains(provider.id.as_str()) {
            continue;
        }
        let generated = pi_provider_value(provider)?;
        if providers
            .get(&provider.id)
            .is_some_and(|existing| contains_generated_fields(existing, &generated))
        {
            providers.remove(&provider.id);
        }
    }

    for provider in &settings.providers {
        let generated = pi_provider_value(provider)?;
        match providers.entry(provider.id.clone()) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(generated);
            }
            serde_json::map::Entry::Occupied(mut entry) => {
                let existing = entry.get_mut().as_object_mut().ok_or_else(|| {
                    format!(
                        "Pi provider '{}' must be a JSON object before Pi Desktop can update it.",
                        provider.id
                    )
                })?;
                for (key, value) in generated
                    .as_object()
                    .expect("generated provider is always an object")
                {
                    existing.insert(key.clone(), value.clone());
                }
            }
        }
    }

    Ok(document)
}

fn pi_provider_value(provider: &ProviderConfig) -> Result<Value, String> {
    let mut value = serde_json::to_value(provider)
        .map_err(|error| format!("Could not encode provider '{}': {error}", provider.id))?;
    let object = value
        .as_object_mut()
        .expect("serialized provider is always an object");
    object.remove("id");
    object.remove("name");
    object.insert(
        "apiKey".to_owned(),
        Value::String(format!("${}", provider_env_name(&provider.id))),
    );
    Ok(value)
}

fn contains_generated_fields(existing: &Value, generated: &Value) -> bool {
    let (Some(existing), Some(generated)) = (existing.as_object(), generated.as_object()) else {
        return false;
    };
    generated
        .iter()
        .all(|(key, value)| existing.get(key) == Some(value))
}

fn provider_env_name(provider_id: &str) -> String {
    let mut name = String::from("PI_DESKTOP_PROVIDER_KEY_");
    for byte in provider_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(name, "{byte:02X}");
    }
    name
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T, mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create configuration directory {}: {error}",
            parent.display()
        )
    })?;

    let temporary = temporary_path(path);
    let result = (|| {
        let file = open_private_file(&temporary, mode)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value).map_err(|error| {
            format!(
                "Could not encode configuration for {}: {error}",
                path.display()
            )
        })?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|error| {
                format!(
                    "Could not finish writing configuration {}: {error}",
                    path.display()
                )
            })?;
        writer.get_ref().sync_all().map_err(|error| {
            format!(
                "Could not sync configuration {} to disk: {error}",
                path.display()
            )
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "Could not replace configuration {} atomically: {error}",
                path.display()
            )
        })?;
        set_mode(path, mode)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    let sequence = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence))
}

fn open_private_file(path: &Path, mode: u32) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(mode);
    options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

fn enforce_private_mode(path: &Path) -> Result<(), String> {
    set_mode(path, 0o600)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| {
        format!(
            "Could not set private permissions on {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn existing_mode(path: &Path) -> Option<u32> {
    fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn existing_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, key: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.to_owned(),
            name: "Test provider".to_owned(),
            base_url: "https://example.test/v1".to_owned(),
            api_key: key.to_owned(),
            api: ProviderApi::OpenaiCompletions,
            auth_header: true,
            models: vec![ProviderModel {
                id: "test-model".to_owned(),
                name: None,
                reasoning: false,
                input: None,
                context_window: None,
                max_tokens: None,
            }],
        }
    }

    #[test]
    fn merge_preserves_unmanaged_providers_and_keeps_secrets_out() {
        let existing = serde_json::json!({
            "customRoot": true,
            "providers": {
                "unmanaged": { "baseUrl": "http://localhost:11434/v1", "models": [] },
                "desktop": { "headers": { "x-extra": "kept" } }
            }
        });
        let next = AppSettings {
            providers: vec![provider("desktop", "super-secret")],
            ..AppSettings::default()
        };

        let merged = merge_models_document(existing, &AppSettings::default(), &next).unwrap();
        assert_eq!(merged["customRoot"], true);
        assert!(merged["providers"]["unmanaged"].is_object());
        assert_eq!(merged["providers"]["desktop"]["headers"]["x-extra"], "kept");
        assert_eq!(
            merged["providers"]["desktop"]["apiKey"],
            format!("${}", provider_env_name("desktop"))
        );
        assert!(!merged.to_string().contains("super-secret"));
    }

    #[test]
    fn removal_only_deletes_an_unchanged_desktop_provider() {
        let old_provider = provider("desktop", "old-secret");
        let generated = pi_provider_value(&old_provider).unwrap();
        let existing = serde_json::json!({
            "providers": {
                "desktop": generated,
                "other": { "api": "openai-completions" }
            }
        });
        let previous = AppSettings {
            providers: vec![old_provider],
            ..AppSettings::default()
        };

        let merged = merge_models_document(existing, &previous, &AppSettings::default()).unwrap();
        assert!(merged["providers"].get("desktop").is_none());
        assert!(merged["providers"]["other"].is_object());
    }

    #[test]
    fn provider_environment_names_are_stable_and_collision_free() {
        assert_eq!(
            provider_env_name("custom-a"),
            "PI_DESKTOP_PROVIDER_KEY_637573746F6D2D61"
        );
        assert_ne!(provider_env_name("a-b"), provider_env_name("a_b"));
    }
}
