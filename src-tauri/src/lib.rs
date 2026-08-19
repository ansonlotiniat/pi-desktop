mod authoring;
mod features;
mod kernel;
mod settings;
mod terminal;

use kernel::DesktopState;
use serde_json::Value;
use settings::AppSettings;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn get_settings(app: AppHandle, state: State<'_, DesktopState>) -> Result<AppSettings, String> {
    let _guard = state.lock_settings()?;
    settings::load(&app)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, DesktopState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    settings::validate(&settings)?;
    let _guard = state.lock_settings()?;
    let previous = settings::load(&app)?;
    settings::save(&app, &previous, &settings)?;
    Ok(settings)
}

#[tauri::command]
async fn start_kernel(
    app: AppHandle,
    state: State<'_, DesktopState>,
    executable: Option<String>,
    cwd: Option<String>,
) -> Result<kernel::KernelInfo, String> {
    let settings = {
        let _guard = state.lock_settings()?;
        let settings = settings::load(&app)?;
        settings
    };

    let configured_executable = executable
        .filter(|value| !value.trim().is_empty())
        .or_else(|| non_empty(settings.kernel_path.clone()));
    let configured_cwd = cwd
        .filter(|value| !value.trim().is_empty())
        .or_else(|| non_empty(settings.default_cwd.clone()));

    let home_dir = app.path().home_dir().map_err(|error| {
        format!("Could not locate the home directory for kernel discovery: {error}")
    })?;

    let kernel = state.kernel.clone();
    let terminal = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || {
        kernel.start(
            app,
            terminal,
            configured_executable,
            configured_cwd,
            home_dir,
            &settings,
        )
    })
    .await
    .map_err(|error| format!("Kernel startup worker failed: {error}"))?
}

#[tauri::command]
fn stop_kernel(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    state.terminal.shutdown(&app);
    state.kernel.stop(&app)
}

#[tauri::command]
fn kernel_status(state: State<'_, DesktopState>) -> Result<kernel::KernelInfo, String> {
    state.kernel.status()
}

#[tauri::command]
async fn bridge_send(state: State<'_, DesktopState>, command: Value) -> Result<Value, String> {
    let bridge = state.kernel.clone();
    tauri::async_runtime::spawn_blocking(move || bridge.send(command))
        .await
        .map_err(|error| format!("Bridge worker failed: {error}"))?
}

#[tauri::command]
fn native_terminal_start(
    state: State<'_, DesktopState>,
    initial_input: String,
    columns: u16,
    rows: u16,
) -> Result<terminal::NativeTerminalStatus, String> {
    state.terminal.activate(initial_input, columns, rows)
}

#[tauri::command]
fn native_terminal_submit(
    state: State<'_, DesktopState>,
    initial_input: String,
) -> Result<terminal::NativeTerminalStatus, String> {
    state.terminal.submit(initial_input)
}

#[tauri::command]
fn native_terminal_write(state: State<'_, DesktopState>, data: String) -> Result<(), String> {
    state.terminal.write(data)
}

#[tauri::command]
fn native_terminal_resize(
    state: State<'_, DesktopState>,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminal.resize(columns, rows)
}

#[tauri::command]
fn native_terminal_stop(
    state: State<'_, DesktopState>,
) -> Result<terminal::NativeTerminalStatus, String> {
    state.terminal.conceal()
}

#[tauri::command]
fn native_terminal_status(
    state: State<'_, DesktopState>,
) -> Result<terminal::NativeTerminalStatus, String> {
    state.terminal.status()
}

#[tauri::command]
fn list_features(
    app: AppHandle,
    project_root: Option<String>,
) -> Result<features::FeatureCatalog, String> {
    features::catalog(&app, project_root.as_deref())
}

#[tauri::command]
fn install_starter_feature(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project_root: Option<String>,
    starter_id: String,
) -> Result<features::FeatureCatalog, String> {
    let catalog = features::install_starter(&app, project_root.as_deref(), &starter_id)?;
    let _ = state
        .features
        .stop_feature(&app, project_root.as_deref(), &starter_id);
    Ok(catalog)
}

#[tauri::command]
fn authoring_skill_status(app: AppHandle) -> Result<authoring::AuthoringSkillStatus, String> {
    authoring::status(&app)
}

#[tauri::command]
fn install_authoring_skill(app: AppHandle) -> Result<authoring::AuthoringSkillStatus, String> {
    authoring::install(&app)
}

#[tauri::command]
fn remove_authoring_skill(app: AppHandle) -> Result<authoring::AuthoringSkillStatus, String> {
    authoring::remove(&app)
}

#[tauri::command]
fn load_feature_ui(
    app: AppHandle,
    project_root: Option<String>,
    feature_id: String,
) -> Result<String, String> {
    features::load_ui(&app, project_root.as_deref(), &feature_id)
}

#[tauri::command]
async fn feature_service_request(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project_root: Option<String>,
    feature_id: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let workspace = resolve_feature_workspace(&app, project_root.as_deref())?;
    let kernel_executable = state
        .kernel
        .status()?
        .executable
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            state
                .lock_settings()
                .ok()
                .and_then(|_guard| settings::load(&app).ok())
                .map(|settings| settings.kernel_path)
                .filter(|path| !path.trim().is_empty())
                .map(PathBuf::from)
        });
    let host = state.features.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.request_service(
            app,
            project_root,
            feature_id,
            workspace,
            kernel_executable,
            method,
            params.unwrap_or(Value::Null),
        )
    })
    .await
    .map_err(|error| format!("Feature service worker failed: {error}"))?
}

#[tauri::command]
fn feature_storage_get(
    app: AppHandle,
    state: State<'_, DesktopState>,
    feature_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    state.features.storage_get(&app, &feature_id, &key)
}

#[tauri::command]
fn feature_storage_set(
    app: AppHandle,
    state: State<'_, DesktopState>,
    feature_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    state.features.storage_set(&app, &feature_id, &key, value)
}

#[tauri::command]
fn feature_storage_delete(
    app: AppHandle,
    state: State<'_, DesktopState>,
    feature_id: String,
    key: String,
) -> Result<bool, String> {
    state.features.storage_delete(&app, &feature_id, &key)
}

#[tauri::command]
fn stop_feature_service(
    app: AppHandle,
    state: State<'_, DesktopState>,
    project_root: Option<String>,
    feature_id: String,
) -> Result<(), String> {
    state
        .features
        .stop_feature(&app, project_root.as_deref(), &feature_id)
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn resolve_feature_workspace(app: &AppHandle, requested: Option<&str>) -> Result<PathBuf, String> {
    let path = match requested.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .home_dir()
            .map_err(|error| format!("Could not locate a workspace for the feature: {error}"))?,
    };
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "Feature workspace {} is unavailable: {error}",
            path.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Feature workspace {} is not a directory.",
            path.display()
        ));
    }
    fs::canonicalize(&path).map_err(|error| {
        format!(
            "Could not resolve feature workspace {}: {error}",
            path.display()
        )
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            start_kernel,
            stop_kernel,
            kernel_status,
            bridge_send,
            native_terminal_start,
            native_terminal_submit,
            native_terminal_write,
            native_terminal_resize,
            native_terminal_stop,
            native_terminal_status,
            list_features,
            install_starter_feature,
            authoring_skill_status,
            install_authoring_skill,
            remove_authoring_skill,
            load_feature_ui,
            feature_service_request,
            feature_storage_get,
            feature_storage_set,
            feature_storage_delete,
            stop_feature_service,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pi Desktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<DesktopState>();
            state.terminal.shutdown(app_handle);
            let _ = state.kernel.stop(app_handle);
            state.features.stop_all();
        }
    });
}
