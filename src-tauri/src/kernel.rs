use crate::features::FeatureHost;
use crate::settings::AppSettings;
use crate::terminal::NativeTerminalHost;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const BRIDGE_EVENT: &str = "pi-bridge-event";
const KERNEL_STATUS_EVENT: &str = "pi-kernel-status";
const BRIDGE_PROTOCOL_VERSION: u64 = 1;
const BRIDGE_EXTENSION: &str = include_str!("../resources/pi-desktop-bridge.mjs");
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo {
    pub status: ConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for KernelInfo {
    fn default() -> Self {
        Self {
            status: ConnectionStatus::Disconnected,
            executable: None,
            version: None,
            cwd: None,
            error: None,
        }
    }
}

pub struct DesktopState {
    pub kernel: KernelBridge,
    pub features: FeatureHost,
    pub terminal: NativeTerminalHost,
    settings_lock: Mutex<()>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            kernel: KernelBridge::default(),
            features: FeatureHost::default(),
            terminal: NativeTerminalHost::default(),
            settings_lock: Mutex::new(()),
        }
    }
}

impl DesktopState {
    pub fn lock_settings(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.settings_lock
            .lock()
            .map_err(|_| "Settings lock is unavailable.".to_owned())
    }
}

#[derive(Clone)]
pub(crate) struct KernelLaunch {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub extension_path: PathBuf,
    pub socket_path: PathBuf,
    pub generation: u64,
}

#[derive(Clone)]
pub struct KernelBridge {
    shared: Arc<Shared>,
}

struct Shared {
    runtime: Mutex<Runtime>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    request_sequence: AtomicU64,
    connection_sequence: AtomicU64,
}

struct Runtime {
    connection: Option<Arc<Mutex<UnixStream>>>,
    connection_id: u64,
    info: KernelInfo,
    generation: u64,
    socket_path: Option<PathBuf>,
}

impl Default for KernelBridge {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime: Mutex::new(Runtime {
                    connection: None,
                    connection_id: 0,
                    info: KernelInfo::default(),
                    generation: 0,
                    socket_path: None,
                }),
                pending: Mutex::new(HashMap::new()),
                request_sequence: AtomicU64::new(1),
                connection_sequence: AtomicU64::new(1),
            }),
        }
    }
}

impl KernelBridge {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app: AppHandle,
        terminal: NativeTerminalHost,
        explicit_executable: Option<String>,
        requested_cwd: Option<String>,
        home_dir: PathBuf,
        settings: &AppSettings,
    ) -> Result<KernelInfo, String> {
        {
            let runtime = self.lock_runtime()?;
            if matches!(
                runtime.info.status,
                ConnectionStatus::Connecting | ConnectionStatus::Connected
            ) {
                return Ok(runtime.info.clone());
            }
        }

        let executable = discover_executable(explicit_executable.as_deref(), &home_dir)
            .map_err(|error| self.start_error(&app, error))?;
        let cwd = resolve_cwd(requested_cwd.as_deref(), &home_dir)
            .map_err(|error| self.start_error(&app, error))?;
        let version = probe_version(&executable);
        let cache_dir = app.path().app_cache_dir().map_err(|error| {
            self.start_error(
                &app,
                format!("Could not locate the app cache directory: {error}"),
            )
        })?;
        fs::create_dir_all(&cache_dir).map_err(|error| {
            self.start_error(
                &app,
                format!("Could not prepare the Desktop bridge directory: {error}"),
            )
        })?;
        let extension_path = cache_dir.join("pi-desktop-bridge.mjs");
        write_private_file(&extension_path, BRIDGE_EXTENSION.as_bytes())
            .map_err(|error| self.start_error(&app, error))?;

        let generation = {
            let mut runtime = self.lock_runtime()?;
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.connection = None;
            runtime.connection_id = 0;
            runtime.info = KernelInfo {
                status: ConnectionStatus::Connecting,
                executable: Some(executable.to_string_lossy().into_owned()),
                version,
                cwd: Some(cwd.to_string_lossy().into_owned()),
                error: None,
            };
            runtime.generation
        };
        emit_status(&app, &self.status()?);

        let socket_path = std::env::temp_dir().join(format!(
            "pi-desktop-{}-{generation}.sock",
            std::process::id()
        ));
        if socket_path.exists() {
            fs::remove_file(&socket_path).map_err(|error| {
                self.start_error(
                    &app,
                    format!("Could not remove the stale Desktop bridge socket: {error}"),
                )
            })?;
        }
        let listener = UnixListener::bind(&socket_path).map_err(|error| {
            self.start_error(
                &app,
                format!("Could not open the Desktop bridge socket: {error}"),
            )
        })?;
        listener.set_nonblocking(true).map_err(|error| {
            self.start_error(
                &app,
                format!("Could not configure the Desktop bridge socket: {error}"),
            )
        })?;
        if let Ok(metadata) = fs::metadata(&socket_path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = fs::set_permissions(&socket_path, permissions);
        }
        {
            let mut runtime = self.lock_runtime()?;
            if runtime.generation != generation {
                let _ = fs::remove_file(&socket_path);
                return Err("Pi Desktop connection startup was superseded.".to_owned());
            }
            runtime.socket_path = Some(socket_path.clone());
        }
        spawn_accept_loop(Arc::clone(&self.shared), app.clone(), generation, listener);

        let launch = KernelLaunch {
            executable,
            cwd,
            extension_path,
            socket_path,
            generation,
        };
        if let Err(error) =
            terminal.start_kernel(app.clone(), self.clone(), launch, settings.clone())
        {
            return Err(self.fail_start(&app, generation, error));
        }

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            let info = self.status()?;
            match info.status {
                ConnectionStatus::Connected => return Ok(info),
                ConnectionStatus::Error => {
                    terminal.shutdown(&app);
                    return Err(info
                        .error
                        .unwrap_or_else(|| "Pi Desktop bridge failed during startup.".to_owned()));
                }
                ConnectionStatus::Disconnected => {
                    terminal.shutdown(&app);
                    return Err("Pi exited before the Desktop bridge connected.".to_owned());
                }
                ConnectionStatus::Connecting => {}
            }
            if Instant::now() >= deadline {
                terminal.shutdown(&app);
                return Err(self.fail_start(
                    &app,
                    generation,
                    "Pi started, but its Desktop bridge did not connect within 30 seconds. The installed Pi version may not support the required public extension API.".to_owned(),
                ));
            }
            thread::sleep(CONNECTION_POLL_INTERVAL);
        }
    }

    pub fn stop(&self, app: &AppHandle) -> Result<(), String> {
        let (connection, socket_path) = {
            let mut runtime = self.lock_runtime()?;
            runtime.generation = runtime.generation.wrapping_add(1);
            let connection = runtime.connection.take();
            runtime.connection_id = 0;
            let socket_path = runtime.socket_path.take();
            runtime.info = KernelInfo::default();
            (connection, socket_path)
        };
        if let Some(connection) = connection {
            if let Ok(connection) = connection.lock() {
                let _ = connection.shutdown(Shutdown::Both);
            }
        }
        if let Some(socket_path) = socket_path {
            let _ = fs::remove_file(socket_path);
        }
        fail_all_pending(&self.shared, "Pi Desktop bridge stopped.");
        emit_status(app, &KernelInfo::default());
        Ok(())
    }

    pub fn status(&self) -> Result<KernelInfo, String> {
        Ok(self.lock_runtime()?.info.clone())
    }

    pub fn send(&self, command: Value) -> Result<Value, String> {
        self.send_with_timeout(command, REQUEST_TIMEOUT)
    }

    pub(crate) fn process_exited(
        &self,
        app: &AppHandle,
        generation: u64,
        success: bool,
        detail: String,
    ) {
        let (info, socket_path) = {
            let Ok(mut runtime) = self.shared.runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.connection = None;
            runtime.connection_id = 0;
            let socket_path = runtime.socket_path.take();
            runtime.info = if success {
                KernelInfo::default()
            } else {
                KernelInfo {
                    status: ConnectionStatus::Error,
                    executable: runtime.info.executable.clone(),
                    version: runtime.info.version.clone(),
                    cwd: runtime.info.cwd.clone(),
                    error: Some(detail.clone()),
                }
            };
            (runtime.info.clone(), socket_path)
        };
        if let Some(socket_path) = socket_path {
            let _ = fs::remove_file(socket_path);
        }
        fail_all_pending(&self.shared, &detail);
        emit_status(app, &info);
    }

    fn send_with_timeout(&self, mut command: Value, timeout: Duration) -> Result<Value, String> {
        let object = command
            .as_object_mut()
            .ok_or_else(|| "Desktop bridge command must be a JSON object.".to_owned())?;
        if !object.get("type").is_some_and(Value::is_string) {
            return Err("Desktop bridge command must contain a string 'type' field.".to_owned());
        }
        let id = match object.get("id") {
            Some(Value::String(id)) if !id.is_empty() => id.clone(),
            Some(_) => {
                return Err("Desktop bridge command 'id' must be a non-empty string.".to_owned())
            }
            None => {
                let sequence = self.shared.request_sequence.fetch_add(1, Ordering::Relaxed);
                let id = format!("pi-desktop-{sequence}");
                object.insert("id".to_owned(), Value::String(id.clone()));
                id
            }
        };

        let mut encoded = serde_json::to_vec(&command)
            .map_err(|error| format!("Could not encode Desktop bridge command: {error}"))?;
        encoded.push(b'\n');
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self
                .shared
                .pending
                .lock()
                .map_err(|_| "Desktop bridge request table is unavailable.".to_owned())?;
            if pending.insert(id.clone(), sender).is_some() {
                return Err(format!(
                    "Desktop bridge request id '{id}' is already in use."
                ));
            }
        }

        let connection = match self.connected_stream() {
            Ok(connection) => connection,
            Err(error) => {
                remove_pending(&self.shared, &id);
                return Err(error);
            }
        };
        let write_result = connection
            .lock()
            .map_err(|_| "Desktop bridge connection lock is unavailable.".to_owned())
            .and_then(|mut connection| {
                connection
                    .write_all(&encoded)
                    .and_then(|_| connection.flush())
                    .map_err(|error| format!("Could not write to the Desktop bridge: {error}"))
            });
        if let Err(error) = write_result {
            remove_pending(&self.shared, &id);
            return Err(error);
        }

        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                remove_pending(&self.shared, &id);
                Err(format!(
                    "Pi did not answer Desktop bridge request '{id}' within {} seconds.",
                    timeout.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                remove_pending(&self.shared, &id);
                Err("Desktop bridge response channel closed.".to_owned())
            }
        }
    }

    fn connected_stream(&self) -> Result<Arc<Mutex<UnixStream>>, String> {
        let runtime = self.lock_runtime()?;
        if !matches!(runtime.info.status, ConnectionStatus::Connected) {
            return Err("Pi Desktop bridge is reconnecting.".to_owned());
        }
        runtime
            .connection
            .as_ref()
            .cloned()
            .ok_or_else(|| "Pi Desktop bridge connection is unavailable.".to_owned())
    }

    fn start_error(&self, app: &AppHandle, error: String) -> String {
        if let Ok(mut runtime) = self.shared.runtime.lock() {
            runtime.info = KernelInfo {
                status: ConnectionStatus::Error,
                executable: runtime.info.executable.clone(),
                version: runtime.info.version.clone(),
                cwd: runtime.info.cwd.clone(),
                error: Some(error.clone()),
            };
            emit_status(app, &runtime.info);
        }
        error
    }

    fn fail_start(&self, app: &AppHandle, generation: u64, error: String) -> String {
        let socket_path = {
            let Ok(mut runtime) = self.shared.runtime.lock() else {
                return error;
            };
            if runtime.generation != generation {
                return error;
            }
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.connection = None;
            runtime.connection_id = 0;
            let socket_path = runtime.socket_path.take();
            runtime.info = KernelInfo {
                status: ConnectionStatus::Error,
                executable: runtime.info.executable.clone(),
                version: runtime.info.version.clone(),
                cwd: runtime.info.cwd.clone(),
                error: Some(error.clone()),
            };
            emit_status(app, &runtime.info);
            socket_path
        };
        if let Some(socket_path) = socket_path {
            let _ = fs::remove_file(socket_path);
        }
        fail_all_pending(&self.shared, &error);
        error
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, Runtime>, String> {
        self.shared
            .runtime
            .lock()
            .map_err(|_| "Kernel bridge state is unavailable.".to_owned())
    }
}

fn spawn_accept_loop(shared: Arc<Shared>, app: AppHandle, generation: u64, listener: UnixListener) {
    thread::spawn(move || loop {
        let active = shared
            .runtime
            .lock()
            .map(|runtime| runtime.generation == generation)
            .unwrap_or(false);
        if !active {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = configure_bridge_connection(&stream) {
                    bridge_protocol_failure(
                        &shared,
                        &app,
                        generation,
                        format!("Could not configure the Desktop bridge connection: {error}"),
                    );
                    return;
                }
                let reader = match stream.try_clone() {
                    Ok(reader) => reader,
                    Err(_) => continue,
                };
                let connection_id = shared.connection_sequence.fetch_add(1, Ordering::Relaxed);
                let writer = Arc::new(Mutex::new(stream));
                if let Ok(mut runtime) = shared.runtime.lock() {
                    if runtime.generation != generation {
                        return;
                    }
                    runtime.connection = Some(writer);
                    runtime.connection_id = connection_id;
                }
                spawn_connection_reader(
                    Arc::clone(&shared),
                    app.clone(),
                    generation,
                    connection_id,
                    reader,
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                bridge_protocol_failure(
                    &shared,
                    &app,
                    generation,
                    format!("Desktop bridge socket failed: {error}"),
                );
                return;
            }
        }
    });
}

fn configure_bridge_connection(stream: &UnixStream) -> std::io::Result<()> {
    stream.set_nonblocking(false)
}

fn spawn_connection_reader(
    shared: Arc<Shared>,
    app: AppHandle,
    generation: u64,
    connection_id: u64,
    stream: UnixStream,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut record = Vec::new();
        loop {
            record.clear();
            match reader.read_until(b'\n', &mut record) {
                Ok(0) => break,
                Ok(_) => {
                    if record.last() == Some(&b'\n') {
                        record.pop();
                        if record.last() == Some(&b'\r') {
                            record.pop();
                        }
                    }
                    if record.is_empty() {
                        continue;
                    }
                    let value = match serde_json::from_slice::<Value>(&record) {
                        Ok(value) if value.is_object() => value,
                        Ok(_) => {
                            bridge_protocol_failure(
                                &shared,
                                &app,
                                generation,
                                "Desktop bridge emitted a non-object record.".to_owned(),
                            );
                            return;
                        }
                        Err(error) => {
                            bridge_protocol_failure(
                                &shared,
                                &app,
                                generation,
                                format!("Desktop bridge emitted invalid JSONL: {error}"),
                            );
                            return;
                        }
                    };

                    if value.get("type").and_then(Value::as_str) == Some("bridge_ready") {
                        if let Err(error) = validate_bridge_handshake(&value) {
                            bridge_protocol_failure(&shared, &app, generation, error);
                            return;
                        }
                        let info = {
                            let Ok(mut runtime) = shared.runtime.lock() else {
                                return;
                            };
                            if runtime.generation != generation
                                || runtime.connection_id != connection_id
                            {
                                return;
                            }
                            runtime.info.status = ConnectionStatus::Connected;
                            runtime.info.error = None;
                            if let Some(cwd) = value
                                .get("state")
                                .and_then(|state| state.get("cwd"))
                                .and_then(Value::as_str)
                            {
                                runtime.info.cwd = Some(cwd.to_owned());
                            }
                            runtime.info.clone()
                        };
                        emit_status(&app, &info);
                    }

                    if value.get("type").and_then(Value::as_str) == Some("response") {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            let sender = shared
                                .pending
                                .lock()
                                .ok()
                                .and_then(|mut pending| pending.remove(id));
                            if let Some(sender) = sender {
                                let _ = sender.send(Ok(value.clone()));
                            }
                        }
                    }
                    let _ = app.emit(BRIDGE_EVENT, &value);
                }
                Err(error) => {
                    bridge_protocol_failure(
                        &shared,
                        &app,
                        generation,
                        format!("Could not read the Desktop bridge: {error}"),
                    );
                    return;
                }
            }
        }
        mark_connection_closed(&shared, &app, generation, connection_id);
    });
}

fn validate_bridge_handshake(value: &Value) -> Result<(), String> {
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(BRIDGE_PROTOCOL_VERSION) {
        return Err("Pi Desktop bridge protocol version is incompatible.".to_owned());
    }
    if !value.get("state").is_some_and(Value::is_object) {
        return Err("Pi Desktop bridge handshake did not include session state.".to_owned());
    }
    Ok(())
}

fn mark_connection_closed(
    shared: &Arc<Shared>,
    app: &AppHandle,
    generation: u64,
    connection_id: u64,
) {
    let info = {
        let Ok(mut runtime) = shared.runtime.lock() else {
            return;
        };
        if runtime.generation != generation || runtime.connection_id != connection_id {
            return;
        }
        runtime.connection = None;
        runtime.connection_id = 0;
        if matches!(runtime.info.status, ConnectionStatus::Connected) {
            runtime.info.status = ConnectionStatus::Connecting;
            runtime.info.error = None;
        }
        runtime.info.clone()
    };
    fail_all_pending(
        shared,
        "Pi Desktop bridge is reconnecting after a session change.",
    );
    emit_status(app, &info);
}

fn bridge_protocol_failure(shared: &Arc<Shared>, app: &AppHandle, generation: u64, error: String) {
    let info = {
        let Ok(mut runtime) = shared.runtime.lock() else {
            return;
        };
        if runtime.generation != generation {
            return;
        }
        runtime.connection = None;
        runtime.connection_id = 0;
        runtime.info.status = ConnectionStatus::Error;
        runtime.info.error = Some(error.clone());
        runtime.info.clone()
    };
    fail_all_pending(shared, &error);
    emit_status(app, &info);
}

fn fail_all_pending(shared: &Arc<Shared>, error: &str) {
    let pending = shared
        .pending
        .lock()
        .map(|mut pending| {
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in pending {
        let _ = sender.send(Err(error.to_owned()));
    }
}

fn remove_pending(shared: &Arc<Shared>, id: &str) {
    if let Ok(mut pending) = shared.pending.lock() {
        pending.remove(id);
    }
}

fn emit_status(app: &AppHandle, info: &KernelInfo) {
    let _ = app.emit(KERNEL_STATUS_EVENT, info);
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true).mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not prepare the Pi Desktop bridge extension: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write the Pi Desktop bridge extension: {error}"))
}

fn probe_version(executable: &Path) -> Option<String> {
    let mut command = Command::new(executable);
    command.arg("--version");
    if let Ok(path) = path_for_executable(executable) {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|version| !version.is_empty())
}

fn resolve_cwd(requested: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let path = match requested {
        Some(path) if !path.trim().is_empty() => expand_home(path.trim(), home),
        _ => home.to_owned(),
    };
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "Working directory {} is unavailable: {error}",
            path.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Working directory {} is not a directory.",
            path.display()
        ));
    }
    fs::canonicalize(&path).map_err(|error| {
        format!(
            "Could not resolve working directory {}: {error}",
            path.display()
        )
    })
}

fn discover_executable(explicit: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    if let Some(explicit) = explicit.filter(|path| !path.trim().is_empty()) {
        let explicit = explicit.trim();
        let path = if is_bare_command(explicit) {
            find_on_path(explicit).ok_or_else(|| {
                format!("Configured Pi kernel executable '{explicit}' was not found on PATH.")
            })?
        } else {
            expand_home(explicit, home)
        };
        return validate_executable(path, "Configured Pi kernel executable");
    }
    if let Some(path) = find_on_path("pi") {
        return validate_executable(path, "Pi kernel executable");
    }
    for candidate in known_external_pi_candidates(home) {
        if is_executable(&candidate) {
            return Ok(absolute_or_original(candidate));
        }
    }
    Err("No external Pi installation was found. Install Pi from https://pi.dev/ or set the exact Pi executable path in Settings.".to_owned())
}

fn known_external_pi_candidates(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        home.join(".local/bin/pi"),
        home.join(".bun/bin/pi"),
        home.join(".volta/bin/pi"),
        home.join("Library/pnpm/pi"),
        home.join(".asdf/shims/pi"),
        home.join(".local/share/mise/shims/pi"),
        PathBuf::from("/opt/homebrew/bin/pi"),
        PathBuf::from("/usr/local/bin/pi"),
    ];
    append_versioned_pi_candidates(
        &mut candidates,
        &home.join(".local/share/fnm/node-versions"),
        "installation/bin/pi",
    );
    append_versioned_pi_candidates(
        &mut candidates,
        &home.join("Library/Application Support/fnm/node-versions"),
        "installation/bin/pi",
    );
    append_versioned_pi_candidates(&mut candidates, &home.join(".nvm/versions/node"), "bin/pi");
    append_versioned_pi_candidates(&mut candidates, &home.join(".nodenv/versions"), "bin/pi");
    append_versioned_pi_candidates(
        &mut candidates,
        &home.join(".asdf/installs/nodejs"),
        "bin/pi",
    );
    append_versioned_pi_candidates(
        &mut candidates,
        &home.join(".local/share/mise/installs/node"),
        "bin/pi",
    );
    candidates
}

fn append_versioned_pi_candidates(candidates: &mut Vec<PathBuf>, root: &Path, suffix: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut version_dirs = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    version_dirs.sort_by_key(|path| std::cmp::Reverse(node_version_key(path)));
    candidates.extend(
        version_dirs
            .into_iter()
            .map(|directory| directory.join(suffix)),
    );
}

fn node_version_key(path: &Path) -> (u64, u64, u64) {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim_start_matches('v');
    let mut numbers = name
        .split('.')
        .map(|part| part.split('-').next().unwrap_or(part).parse().unwrap_or(0));
    (
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
    )
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(command))
        .find(|candidate| is_executable(candidate))
        .map(absolute_or_original)
}

fn validate_executable(path: PathBuf, label: &str) -> Result<PathBuf, String> {
    if !is_executable(&path) {
        return Err(format!(
            "{label} {} is not an executable file.",
            path.display()
        ));
    }
    Ok(absolute_or_original(path))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

fn absolute_or_original(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    std::env::current_dir()
        .map(|directory| directory.join(&path))
        .unwrap_or(path)
}

pub(crate) fn path_for_executable(executable: &Path) -> Result<std::ffi::OsString, String> {
    let directory = executable.parent().ok_or_else(|| {
        format!(
            "Pi executable {} has no parent directory.",
            executable.display()
        )
    })?;
    let existing = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(
        std::iter::once(directory.to_owned()).chain(std::env::split_paths(&existing)),
    )
    .map_err(|error| format!("Could not prepare PATH for the Pi kernel: {error}"))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ProxyEnvironment {
    http: Option<String>,
    https: Option<String>,
    no_proxy: Option<String>,
}

fn parse_macos_proxy_output(output: &str) -> ProxyEnvironment {
    let mut values = HashMap::new();
    let mut exceptions = Vec::new();
    let mut reading_exceptions = false;
    for line in output.lines() {
        let line = line.trim();
        if line.starts_with("ExceptionsList : <array>") {
            reading_exceptions = true;
            continue;
        }
        if reading_exceptions {
            if line == "}" {
                reading_exceptions = false;
                continue;
            }
            if let Some((index, value)) = line.split_once(" : ") {
                if index.parse::<usize>().is_ok() && !value.trim().is_empty() {
                    exceptions.push(value.trim().trim_matches('"').to_owned());
                }
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(" : ") {
            values.insert(
                key.trim().to_owned(),
                value.trim().trim_matches('"').to_owned(),
            );
        }
    }
    ProxyEnvironment {
        http: proxy_url(&values, "HTTP"),
        https: proxy_url(&values, "HTTPS"),
        no_proxy: (!exceptions.is_empty()).then(|| exceptions.join(",")),
    }
}

fn proxy_url(values: &HashMap<String, String>, prefix: &str) -> Option<String> {
    if values.get(&format!("{prefix}Enable"))?.as_str() != "1" {
        return None;
    }
    let host = values.get(&format!("{prefix}Proxy"))?.trim();
    if host.is_empty() {
        return None;
    }
    if host.contains("://") {
        return Some(host.to_owned());
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    match values
        .get(&format!("{prefix}Port"))
        .and_then(|port| port.parse::<u16>().ok())
    {
        Some(port) => Some(format!("http://{host}:{port}")),
        None => Some(format!("http://{host}")),
    }
}

fn apply_proxy_pair(
    command: &mut Command,
    uppercase: &str,
    lowercase: &str,
    fallback: Option<&str>,
) {
    let upper_value = std::env::var_os(uppercase);
    let lower_value = std::env::var_os(lowercase);
    match (upper_value, lower_value) {
        (Some(upper), None) => {
            command.env(lowercase, upper);
        }
        (None, Some(lower)) => {
            command.env(uppercase, lower);
        }
        (None, None) => {
            if let Some(value) = fallback {
                command.env(uppercase, value).env(lowercase, value);
            }
        }
        (Some(_), Some(_)) => {}
    }
}

pub(crate) fn apply_system_proxy_environment(command: &mut Command) {
    let proxy = macos_system_proxy_environment();
    apply_proxy_pair(command, "HTTP_PROXY", "http_proxy", proxy.http.as_deref());
    apply_proxy_pair(
        command,
        "HTTPS_PROXY",
        "https_proxy",
        proxy.https.as_deref(),
    );
    apply_proxy_pair(command, "NO_PROXY", "no_proxy", proxy.no_proxy.as_deref());
}

#[cfg(target_os = "macos")]
fn macos_system_proxy_environment() -> ProxyEnvironment {
    let Ok(output) = Command::new("/usr/sbin/scutil").arg("--proxy").output() else {
        return ProxyEnvironment::default();
    };
    if !output.status.success() {
        return ProxyEnvironment::default();
    }
    parse_macos_proxy_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn macos_system_proxy_environment() -> ProxyEnvironment {
    ProxyEnvironment::default()
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_owned();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(path)
}

fn is_bare_command(path: &str) -> bool {
    !path.contains(std::path::MAIN_SEPARATOR) && !Path::new(path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    #[test]
    fn explicit_missing_kernel_does_not_fall_back() {
        let error = discover_executable(Some("/definitely/not/a/pi-kernel"), Path::new("/tmp"))
            .unwrap_err();
        assert!(error.contains("not an executable file"));
    }

    #[test]
    fn home_paths_expand_for_kernel_and_cwd_settings() {
        assert_eq!(
            expand_home("~/.local/bin/pi", Path::new("/Users/test")),
            PathBuf::from("/Users/test/.local/bin/pi")
        );
        assert_eq!(
            expand_home("~", Path::new("/Users/test")),
            PathBuf::from("/Users/test")
        );
    }

    #[test]
    fn automatic_discovery_only_considers_external_pi_commands() {
        let home = Path::new("/Users/test");
        let candidates = known_external_pi_candidates(home);
        assert!(candidates.contains(&home.join(".local/bin/pi")));
        assert!(candidates.contains(&home.join(".bun/bin/pi")));
        assert!(!candidates.iter().any(|path| path.ends_with("omp")));
    }

    #[test]
    fn startup_requires_a_bridge_state_handshake() {
        let valid = json!({
            "type": "bridge_ready",
            "protocolVersion": 1,
            "state": {"sessionId": "test"}
        });
        assert!(validate_bridge_handshake(&valid).is_ok());
        let invalid = json!({"type": "bridge_ready", "protocolVersion": 2});
        assert!(validate_bridge_handshake(&invalid).is_err());
    }

    #[test]
    fn accepted_bridge_streams_are_returned_to_blocking_mode() {
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        configure_bridge_connection(&reader).unwrap();

        let read = thread::spawn(move || {
            let mut byte = [0_u8; 1];
            reader.read_exact(&mut byte).map(|_| byte[0])
        });
        thread::sleep(Duration::from_millis(20));
        writer.write_all(b"x").unwrap();

        assert_eq!(read.join().unwrap().unwrap(), b'x');
    }

    #[test]
    fn macos_http_proxy_settings_map_to_pi_environment() {
        let proxy = parse_macos_proxy_output(
            r#"<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}"#,
        );
        assert_eq!(proxy.http.as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(proxy.https.as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(proxy.no_proxy.as_deref(), Some("127.0.0.1,*.local"));
    }
}
