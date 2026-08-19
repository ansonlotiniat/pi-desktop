use crate::kernel::apply_system_proxy_environment;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const FEATURE_SERVICE_EVENT: &str = "pi-feature-service-event";

const FEATURE_API_VERSION: u32 = 1;
const FEATURE_MANIFEST: &str = "feature.json";
const FEATURE_STORAGE_FILE: &str = "feature-storage.json";
const OFFICIAL_MARKER: &str = ".pi-desktop-official.json";
const OFFICIAL_PUBLISHER: &str = "Pi Desktop";
const SERVICE_TIMEOUT: Duration = Duration::from_secs(120);
static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct StarterFeatureDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    icon: &'static str,
    version: &'static str,
    files: &'static [(&'static str, &'static str)],
}

const STARTER_FEATURES: &[StarterFeatureDefinition] = &[
    StarterFeatureDefinition {
        id: "code-review",
        name: "Code Review",
        description:
            "Review working, staged, or committed changes file by file, then send a focused task to Pi.",
        icon: "✓",
        version: "1.0.0",
        files: &[
            (
                "feature.json",
                include_str!("../resources/starter-features/code-review/feature.json"),
            ),
            (
                "ui/index.html",
                include_str!("../resources/starter-features/official-git/ui/index.html"),
            ),
            (
                "service/main.mjs",
                include_str!("../resources/starter-features/official-git/service/main.mjs"),
            ),
        ],
    },
    StarterFeatureDefinition {
        id: "code-diff",
        name: "Code Diff",
        description: "Browse per-file working, staged, and last-commit diffs without consuming model tokens.",
        icon: "±",
        version: "1.0.0",
        files: &[
            (
                "feature.json",
                include_str!("../resources/starter-features/code-diff/feature.json"),
            ),
            (
                "ui/index.html",
                include_str!("../resources/starter-features/official-git/ui/index.html"),
            ),
            (
                "service/main.mjs",
                include_str!("../resources/starter-features/official-git/service/main.mjs"),
            ),
        ],
    },
    StarterFeatureDefinition {
        id: "pr-workspace",
        name: "PR Workspace",
        description: "Browse pull requests, checks, changed files, and per-file patches through your authenticated GitHub CLI.",
        icon: "↗",
        version: "1.0.0",
        files: &[
            (
                "feature.json",
                include_str!("../resources/starter-features/pr-workspace/feature.json"),
            ),
            (
                "ui/index.html",
                include_str!("../resources/starter-features/pr-workspace/ui/index.html"),
            ),
            (
                "service/main.mjs",
                include_str!("../resources/starter-features/pr-workspace/service/main.mjs"),
            ),
        ],
    },
    StarterFeatureDefinition {
        id: "project-map",
        name: "Project Map",
        description: "Explore repository structure, languages, modules, entry points, and source previews without model tokens.",
        icon: "⌘",
        version: "1.0.0",
        files: &[
            (
                "feature.json",
                include_str!("../resources/starter-features/project-map/feature.json"),
            ),
            (
                "ui/index.html",
                include_str!("../resources/starter-features/project-map/ui/index.html"),
            ),
            (
                "service/main.mjs",
                include_str!("../resources/starter-features/project-map/service/main.mjs"),
            ),
        ],
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCatalog {
    pub features: Vec<FeatureDescriptor>,
    pub starters: Vec<StarterFeatureDescriptor>,
    pub errors: Vec<FeatureCatalogError>,
    pub global_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_directory: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterFeatureDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub version: String,
    pub publisher: String,
    pub installed: bool,
    pub update_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDescriptor {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub order: i32,
    pub source: FeatureSource,
    pub root_path: String,
    pub ui_entry: String,
    pub has_service: bool,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FeatureSource {
    Global,
    Project,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCatalogError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureManifest {
    api_version: u32,
    id: String,
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default = "default_order")]
    order: i32,
    ui: FeatureUiManifest,
    #[serde(default)]
    service: Option<FeatureServiceManifest>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureUiManifest {
    entry: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureServiceManifest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Clone)]
struct FeatureLocation {
    descriptor: FeatureDescriptor,
    manifest: FeatureManifest,
    root: PathBuf,
}

struct Discovery {
    locations: Vec<FeatureLocation>,
    errors: Vec<FeatureCatalogError>,
    global_directory: PathBuf,
    project_directory: Option<PathBuf>,
}

fn default_order() -> i32 {
    100
}

#[derive(Clone, Default)]
pub struct FeatureHost {
    shared: Arc<FeatureHostShared>,
}

#[derive(Default)]
struct FeatureHostShared {
    services: Mutex<HashMap<String, Arc<FeatureService>>>,
    storage_lock: Mutex<()>,
}

struct FeatureService {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    alive: Arc<AtomicBool>,
    sequence: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeatureServiceEvent {
    feature_id: String,
    workspace: String,
    event: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficialInstallMarker {
    id: String,
    version: String,
}

pub fn catalog(app: &AppHandle, project_root: Option<&str>) -> Result<FeatureCatalog, String> {
    let discovery = discover(app, project_root)?;
    Ok(FeatureCatalog {
        starters: STARTER_FEATURES
            .iter()
            .map(|starter| starter_descriptor(&discovery.global_directory, starter))
            .collect(),
        features: discovery
            .locations
            .into_iter()
            .map(|location| location.descriptor)
            .collect(),
        errors: discovery.errors,
        global_directory: display_path(&discovery.global_directory),
        project_directory: discovery
            .project_directory
            .as_ref()
            .map(|path| display_path(path)),
    })
}

fn starter_descriptor(
    global_directory: &Path,
    starter: &StarterFeatureDefinition,
) -> StarterFeatureDescriptor {
    let destination = global_directory.join(starter.id);
    let installed_version = fs::read(destination.join(FEATURE_MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<FeatureManifest>(&bytes).ok())
        .and_then(|manifest| manifest.version);
    StarterFeatureDescriptor {
        id: starter.id.to_owned(),
        name: starter.name.to_owned(),
        description: starter.description.to_owned(),
        icon: starter.icon.to_owned(),
        version: starter.version.to_owned(),
        publisher: OFFICIAL_PUBLISHER.to_owned(),
        installed: destination.is_dir(),
        update_available: destination.is_dir()
            && installed_version.as_deref() != Some(starter.version),
    }
}

pub fn install_starter(
    app: &AppHandle,
    project_root: Option<&str>,
    starter_id: &str,
) -> Result<FeatureCatalog, String> {
    let starter = STARTER_FEATURES
        .iter()
        .find(|candidate| candidate.id == starter_id)
        .ok_or_else(|| format!("Unknown starter plugin '{starter_id}'."))?;
    let global_directory = global_features_directory(app)?;
    install_starter_into(&global_directory, starter)?;
    catalog(app, project_root)
}

fn install_starter_into(
    global_directory: &Path,
    starter: &StarterFeatureDefinition,
) -> Result<PathBuf, String> {
    fs::create_dir_all(&global_directory).map_err(|error| {
        format!(
            "Could not create the global plugin directory {}: {error}",
            global_directory.display()
        )
    })?;

    let destination = global_directory.join(starter.id);
    let replacement = if destination.exists() {
        Some(replacement_kind(&destination, starter)?)
    } else {
        None
    };

    let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let staging = global_directory.join(format!(
        ".{}.installing-{}-{sequence}",
        starter.id,
        std::process::id()
    ));

    let install_result = (|| -> Result<(), String> {
        fs::create_dir(&staging).map_err(|error| {
            format!(
                "Could not prepare plugin installation at {}: {error}",
                staging.display()
            )
        })?;
        for (relative, contents) in starter.files {
            let path = staging.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Could not create plugin directory {}: {error}",
                        parent.display()
                    )
                })?;
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&path).map_err(|error| {
                format!("Could not create plugin file {}: {error}", path.display())
            })?;
            file.write_all(contents.as_bytes()).map_err(|error| {
                format!("Could not write plugin file {}: {error}", path.display())
            })?;
        }
        let marker_path = staging.join(OFFICIAL_MARKER);
        let marker = serde_json::to_vec_pretty(&OfficialInstallMarker {
            id: starter.id.to_owned(),
            version: starter.version.to_owned(),
        })
        .map_err(|error| format!("Could not serialize the official plugin marker: {error}"))?;
        let mut marker_file = open_private_file(&marker_path)?;
        marker_file
            .write_all(&marker)
            .map_err(|error| format!("Could not write {}: {error}", marker_path.display()))?;

        let backup = if let Some(kind) = replacement {
            let backup_root = global_directory
                .parent()
                .unwrap_or(global_directory)
                .join("feature-backups");
            fs::create_dir_all(&backup_root).map_err(|error| {
                format!(
                    "Could not create plugin backup directory {}: {error}",
                    backup_root.display()
                )
            })?;
            let path = backup_root.join(format!(
                "{}-{}-{}",
                starter.id,
                std::process::id(),
                sequence
            ));
            fs::rename(&destination, &path).map_err(|error| {
                format!("Could not prepare the existing plugin for update: {error}")
            })?;
            Some((path, kind))
        } else {
            None
        };

        if let Err(error) = fs::rename(&staging, &destination) {
            if let Some((backup, _)) = &backup {
                let _ = fs::rename(backup, &destination);
            }
            return Err(format!(
                "Could not finish plugin installation at {}: {error}",
                destination.display()
            ));
        }
        if let Some((backup, ReplacementKind::Managed)) = backup {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(())
    })();

    if let Err(error) = install_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(destination)
}

#[derive(Clone, Copy)]
enum ReplacementKind {
    Managed,
    Legacy,
}

fn replacement_kind(
    destination: &Path,
    starter: &StarterFeatureDefinition,
) -> Result<ReplacementKind, String> {
    let marker_path = destination.join(OFFICIAL_MARKER);
    if let Ok(bytes) = fs::read(&marker_path) {
        let marker: OfficialInstallMarker = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "Invalid official plugin marker at {}: {error}",
                marker_path.display()
            )
        })?;
        if marker.id == starter.id {
            return Ok(ReplacementKind::Managed);
        }
    }

    let manifest_path = destination.join(FEATURE_MANIFEST);
    let bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Could not inspect existing plugin {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: FeatureManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid existing plugin manifest: {error}"))?;
    let is_legacy_starter = manifest.id == starter.id
        && manifest.version.is_none()
        && manifest.publisher.is_none()
        && manifest.ui.entry == "ui/index.html"
        && manifest.service.as_ref().is_some_and(|service| {
            service.command == "node" && service.args == ["service/main.mjs"]
        });
    if is_legacy_starter {
        return Ok(ReplacementKind::Legacy);
    }
    Err(format!(
        "{} contains a custom plugin. Pi Desktop will not overwrite it.",
        destination.display()
    ))
}

pub fn load_ui(
    app: &AppHandle,
    project_root: Option<&str>,
    feature_id: &str,
) -> Result<String, String> {
    let location = find_feature(app, project_root, feature_id)?;
    let path = resolve_relative_file(&location.root, &location.manifest.ui.entry, "UI entry")?;
    fs::read_to_string(&path).map_err(|error| {
        format!(
            "Could not read UI for feature '{}' at {}: {error}",
            location.descriptor.id,
            path.display()
        )
    })
}

impl FeatureHost {
    pub fn request_service(
        &self,
        app: AppHandle,
        project_root: Option<String>,
        feature_id: String,
        workspace: PathBuf,
        kernel_executable: Option<PathBuf>,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        if method.trim().is_empty() {
            return Err("Feature service method cannot be empty.".to_owned());
        }
        let location = find_feature(&app, project_root.as_deref(), &feature_id)?;
        let service_manifest = location.manifest.service.clone().ok_or_else(|| {
            format!(
                "Feature '{}' does not declare a service.",
                location.descriptor.id
            )
        })?;
        let key = format!("{}\u{0}{}", location.root.display(), workspace.display());
        let service = self.get_or_start_service(
            app,
            key,
            &location,
            &service_manifest,
            &workspace,
            kernel_executable.as_deref(),
        )?;
        service.send(&feature_id, &workspace, method, params)
    }

    pub fn storage_get(
        &self,
        app: &AppHandle,
        feature_id: &str,
        key: &str,
    ) -> Result<Option<Value>, String> {
        validate_feature_id(feature_id)?;
        validate_storage_key(key)?;
        let _guard = self
            .shared
            .storage_lock
            .lock()
            .map_err(|_| "Feature storage lock is unavailable.".to_owned())?;
        let storage = load_storage(app)?;
        Ok(storage
            .get(feature_id)
            .and_then(Value::as_object)
            .and_then(|feature| feature.get(key))
            .cloned())
    }

    pub fn storage_set(
        &self,
        app: &AppHandle,
        feature_id: &str,
        key: &str,
        value: Value,
    ) -> Result<(), String> {
        validate_feature_id(feature_id)?;
        validate_storage_key(key)?;
        let _guard = self
            .shared
            .storage_lock
            .lock()
            .map_err(|_| "Feature storage lock is unavailable.".to_owned())?;
        let mut storage = load_storage(app)?;
        let root = storage
            .as_object_mut()
            .ok_or_else(|| "Feature storage root must be a JSON object.".to_owned())?;
        let feature = root
            .entry(feature_id.to_owned())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| format!("Stored data for feature '{feature_id}' is invalid."))?;
        feature.insert(key.to_owned(), value);
        write_storage(app, &storage)
    }

    pub fn storage_delete(
        &self,
        app: &AppHandle,
        feature_id: &str,
        key: &str,
    ) -> Result<bool, String> {
        validate_feature_id(feature_id)?;
        validate_storage_key(key)?;
        let _guard = self
            .shared
            .storage_lock
            .lock()
            .map_err(|_| "Feature storage lock is unavailable.".to_owned())?;
        let mut storage = load_storage(app)?;
        let removed = storage
            .get_mut(feature_id)
            .and_then(Value::as_object_mut)
            .and_then(|feature| feature.remove(key))
            .is_some();
        if removed {
            write_storage(app, &storage)?;
        }
        Ok(removed)
    }

    pub fn stop_all(&self) {
        let services = self
            .shared
            .services
            .lock()
            .map(|mut services| {
                services
                    .drain()
                    .map(|(_, service)| service)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for service in services {
            service.stop();
        }
    }

    pub fn stop_feature(
        &self,
        app: &AppHandle,
        project_root: Option<&str>,
        feature_id: &str,
    ) -> Result<(), String> {
        let location = find_feature(app, project_root, feature_id)?;
        let prefix = format!("{}\u{0}", location.root.display());
        let stopped = {
            let mut services = self
                .shared
                .services
                .lock()
                .map_err(|_| "Feature service table is unavailable.".to_owned())?;
            let keys = services
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| services.remove(&key))
                .collect::<Vec<_>>()
        };
        for service in stopped {
            service.stop();
        }
        Ok(())
    }

    fn get_or_start_service(
        &self,
        app: AppHandle,
        key: String,
        location: &FeatureLocation,
        manifest: &FeatureServiceManifest,
        workspace: &Path,
        kernel_executable: Option<&Path>,
    ) -> Result<Arc<FeatureService>, String> {
        let mut services = self
            .shared
            .services
            .lock()
            .map_err(|_| "Feature service table is unavailable.".to_owned())?;
        if let Some(service) = services.get(&key) {
            if service.is_running()? {
                return Ok(Arc::clone(service));
            }
        }
        if let Some(stale) = services.remove(&key) {
            stale.stop();
        }

        let service = FeatureService::start(app, location, manifest, workspace, kernel_executable)?;
        services.insert(key, Arc::clone(&service));
        Ok(service)
    }
}

impl FeatureService {
    fn start(
        app: AppHandle,
        location: &FeatureLocation,
        manifest: &FeatureServiceManifest,
        workspace: &Path,
        kernel_executable: Option<&Path>,
    ) -> Result<Arc<Self>, String> {
        let executable =
            resolve_service_command(&location.root, &manifest.command, kernel_executable)?;
        let mut command = Command::new(&executable);
        command
            .args(&manifest.args)
            .current_dir(&location.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_DESKTOP_FEATURE_ID", &location.descriptor.id)
            .env("PI_DESKTOP_FEATURE_ROOT", &location.root)
            .env("PI_DESKTOP_WORKSPACE", workspace);
        if let Some(path) = service_path_environment(kernel_executable) {
            command.env("PATH", path);
        }
        apply_system_proxy_environment(&mut command);
        for (name, value) in &manifest.env {
            command.env(name, value);
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start service for feature '{}' using '{}': {error}",
                location.descriptor.id,
                executable.display()
            )
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            format!(
                "Feature '{}' service did not provide stdin.",
                location.descriptor.id
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            format!(
                "Feature '{}' service did not provide stdout.",
                location.descriptor.id
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            format!(
                "Feature '{}' service did not provide stderr.",
                location.descriptor.id
            )
        })?;

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let service = Arc::new(Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::clone(&pending),
            alive: Arc::clone(&alive),
            sequence: AtomicU64::new(1),
        });

        spawn_service_stdout_reader(
            app,
            location.descriptor.id.clone(),
            display_path(workspace),
            pending,
            alive,
            stdout,
        );
        spawn_stderr_drain(stderr);
        Ok(service)
    }

    fn is_running(&self) -> Result<bool, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Feature service process lock is unavailable.".to_owned())?;
        child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("Could not inspect feature service: {error}"))
    }

    fn send(
        &self,
        feature_id: &str,
        workspace: &Path,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let id = format!("{feature_id}-{sequence}");
        let request = json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
            "context": {
                "featureId": feature_id,
                "workspace": display_path(workspace),
            }
        });
        let mut encoded = serde_json::to_vec(&request)
            .map_err(|error| format!("Could not encode feature service request: {error}"))?;
        encoded.push(b'\n');

        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Feature service request table is unavailable.".to_owned())?
            .insert(id.clone(), sender);

        let write_result = self
            .stdin
            .lock()
            .map_err(|_| "Feature service stdin lock is unavailable.".to_owned())
            .and_then(|mut stdin| {
                stdin
                    .write_all(&encoded)
                    .and_then(|_| stdin.flush())
                    .map_err(|error| format!("Could not write to feature service: {error}"))
            });
        if let Err(error) = write_result {
            remove_pending(&self.pending, &id);
            return Err(error);
        }

        match receiver.recv_timeout(SERVICE_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                remove_pending(&self.pending, &id);
                Err(format!(
                    "Feature service did not answer request '{id}' within {} seconds.",
                    SERVICE_TIMEOUT.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                remove_pending(&self.pending, &id);
                Err("Feature service response channel closed.".to_owned())
            }
        }
    }

    fn stop(&self) {
        self.alive.store(false, Ordering::Release);
        fail_pending(&self.pending, "Feature service stopped.");
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn discover(app: &AppHandle, project_root: Option<&str>) -> Result<Discovery, String> {
    let global_directory = global_features_directory(app)?;
    let project_directory = project_root
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .map(|root| root.join(".pi-desktop/features"));

    let mut by_id = HashMap::<String, FeatureLocation>::new();
    let mut errors = Vec::new();
    scan_feature_directory(
        &global_directory,
        FeatureSource::Global,
        &mut by_id,
        &mut errors,
    );
    if let Some(directory) = &project_directory {
        scan_feature_directory(directory, FeatureSource::Project, &mut by_id, &mut errors);
    }

    let mut locations = by_id.into_values().collect::<Vec<_>>();
    locations.sort_by(|left, right| {
        left.descriptor
            .order
            .cmp(&right.descriptor.order)
            .then_with(|| {
                left.descriptor
                    .name
                    .to_lowercase()
                    .cmp(&right.descriptor.name.to_lowercase())
            })
    });
    Ok(Discovery {
        locations,
        errors,
        global_directory,
        project_directory,
    })
}

fn global_features_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory for features: {error}"))?;
    Ok(home.join(".pi-desktop/features"))
}

fn scan_feature_directory(
    directory: &Path,
    source: FeatureSource,
    by_id: &mut HashMap<String, FeatureLocation>,
    errors: &mut Vec<FeatureCatalogError>,
) {
    if !directory.exists() {
        return;
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(FeatureCatalogError {
                path: display_path(directory),
                message: format!("Could not read feature directory: {error}"),
            });
            return;
        }
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    paths.sort();

    for path in paths {
        match load_feature_location(&path, source) {
            Ok(location) => {
                by_id.insert(location.descriptor.id.clone(), location);
            }
            Err(message) => errors.push(FeatureCatalogError {
                path: display_path(&path),
                message,
            }),
        }
    }
}

fn load_feature_location(root: &Path, source: FeatureSource) -> Result<FeatureLocation, String> {
    let manifest_path = root.join(FEATURE_MANIFEST);
    let bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Could not read {}: {error}",
            manifest_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    })?;
    let manifest: FeatureManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("Invalid feature.json: {error}"))?;
    validate_manifest(&manifest)?;

    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not resolve feature directory: {error}"))?;
    let ui_path = resolve_relative_file(&root, &manifest.ui.entry, "UI entry")?;
    if !ui_path.is_file() {
        return Err(format!("UI entry {} is not a file.", ui_path.display()));
    }

    let descriptor = FeatureDescriptor {
        api_version: manifest.api_version,
        id: manifest.id.trim().to_owned(),
        name: manifest.name.trim().to_owned(),
        version: manifest
            .version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        publisher: manifest
            .publisher
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        description: manifest
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        icon: manifest
            .icon
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        order: manifest.order,
        source,
        root_path: display_path(&root),
        ui_entry: manifest.ui.entry.clone(),
        has_service: manifest.service.is_some(),
    };
    Ok(FeatureLocation {
        descriptor,
        manifest,
        root,
    })
}

fn validate_manifest(manifest: &FeatureManifest) -> Result<(), String> {
    if manifest.api_version != FEATURE_API_VERSION {
        return Err(format!(
            "Unsupported feature apiVersion {}. This app supports apiVersion {}.",
            manifest.api_version, FEATURE_API_VERSION
        ));
    }
    validate_feature_id(manifest.id.trim())?;
    if manifest.name.trim().is_empty() {
        return Err("Feature name cannot be empty.".to_owned());
    }
    if manifest.ui.entry.trim().is_empty() {
        return Err("Feature UI entry cannot be empty.".to_owned());
    }
    if let Some(service) = &manifest.service {
        if service.command.trim().is_empty() {
            return Err("Feature service command cannot be empty.".to_owned());
        }
    }
    Ok(())
}

fn validate_feature_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    if valid {
        Ok(())
    } else {
        Err("Feature id must contain only ASCII letters, numbers, '.', '_' or '-' and be at most 64 characters.".to_owned())
    }
}

fn validate_storage_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        Err("Feature storage key cannot be empty.".to_owned())
    } else {
        Ok(())
    }
}

fn find_feature(
    app: &AppHandle,
    project_root: Option<&str>,
    feature_id: &str,
) -> Result<FeatureLocation, String> {
    validate_feature_id(feature_id)?;
    discover(app, project_root)?
        .locations
        .into_iter()
        .find(|location| location.descriptor.id == feature_id)
        .ok_or_else(|| format!("Feature '{feature_id}' is not installed for this workspace."))
}

fn resolve_relative_file(root: &Path, relative: &str, label: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative.trim());
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "{label} must be a path inside the feature directory."
        ));
    }
    let path = root.join(relative);
    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve {label} {}: {error}", path.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!("{label} must stay inside the feature directory."));
    }
    Ok(resolved)
}

fn resolve_service_command(
    root: &Path,
    configured: &str,
    kernel_executable: Option<&Path>,
) -> Result<PathBuf, String> {
    let configured = configured.trim();
    if configured == "node" {
        if let Some(candidate) = kernel_executable
            .and_then(Path::parent)
            .map(|directory| directory.join("node"))
            .filter(|path| path.is_file())
        {
            return Ok(candidate);
        }
        return find_on_path("node").ok_or_else(|| {
            "Feature requires Node, but no Node executable was found beside Pi or on PATH."
                .to_owned()
        });
    }

    let path = Path::new(configured);
    if path.is_absolute() {
        return Ok(path.to_owned());
    }
    if configured.contains('/') {
        return Ok(root.join(path));
    }
    Ok(find_on_path(configured).unwrap_or_else(|| PathBuf::from(configured)))
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|directory| directory.join(command))
            .find(|candidate| candidate.is_file())
    })
}

fn service_path_environment(kernel_executable: Option<&Path>) -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let directories = kernel_executable
        .and_then(Path::parent)
        .map(Path::to_owned)
        .into_iter()
        .chain(std::env::split_paths(&existing));
    std::env::join_paths(directories).ok()
}

fn spawn_service_stdout_reader(
    app: AppHandle,
    feature_id: String,
    workspace: String,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    alive: Arc<AtomicBool>,
    stdout: impl Read + Send + 'static,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => {
                    fail_pending(&pending, "Feature service closed its output stream.");
                    break;
                }
                Ok(_) => {
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    if line.is_empty() {
                        continue;
                    }
                    let value = match serde_json::from_slice::<Value>(&line) {
                        Ok(value) if value.is_object() => value,
                        Ok(_) => {
                            fail_pending(&pending, "Feature service emitted non-object JSONL.");
                            break;
                        }
                        Err(error) => {
                            fail_pending(
                                &pending,
                                &format!("Feature service emitted invalid JSONL: {error}"),
                            );
                            break;
                        }
                    };

                    let response_id = value.get("id").and_then(Value::as_str);
                    let is_response = value.get("type").and_then(Value::as_str) == Some("response")
                        || response_id.is_some();
                    if is_response {
                        if let Some(id) = response_id {
                            let sender = pending
                                .lock()
                                .ok()
                                .and_then(|mut pending| pending.remove(id));
                            if let Some(sender) = sender {
                                let response = if let Some(error) = value.get("error") {
                                    Err(service_error_message(error))
                                } else {
                                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = sender.send(response);
                            }
                        }
                        continue;
                    }

                    let _ = app.emit(
                        FEATURE_SERVICE_EVENT,
                        FeatureServiceEvent {
                            feature_id: feature_id.clone(),
                            workspace: workspace.clone(),
                            event: value,
                        },
                    );
                }
                Err(error) => {
                    fail_pending(
                        &pending,
                        &format!("Could not read feature service output: {error}"),
                    );
                    break;
                }
            }
        }
        alive.store(false, Ordering::Release);
    });
}

fn spawn_stderr_drain(stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        while reader
            .read_line(&mut buffer)
            .ok()
            .is_some_and(|read| read > 0)
        {
            buffer.clear();
        }
    });
}

fn service_error_message(error: &Value) -> String {
    error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .unwrap_or("Feature service request failed.")
        .to_owned()
}

fn remove_pending(
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    id: &str,
) {
    if let Ok(mut pending) = pending.lock() {
        pending.remove(id);
    }
}

fn fail_pending(
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    message: &str,
) {
    let senders = pending
        .lock()
        .map(|mut pending| {
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(Err(message.to_owned()));
    }
}

fn load_storage(app: &AppHandle) -> Result<Value, String> {
    let path = storage_path(app)?;
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    enforce_private_mode(&path)?;
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "Could not read feature storage at {}: {error}",
            path.display()
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Feature storage at {} is invalid JSON: {error}",
            path.display()
        )
    })?;
    if !value.is_object() {
        return Err("Feature storage root must be a JSON object.".to_owned());
    }
    Ok(value)
}

fn write_storage(app: &AppHandle, storage: &Value) -> Result<(), String> {
    let path = storage_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create feature storage directory {}: {error}",
            parent.display()
        )
    })?;

    let temporary = temporary_path(&path);
    let result = (|| {
        let file = open_private_file(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, storage)
            .map_err(|error| format!("Could not encode feature storage: {error}"))?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not finish writing feature storage: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("Could not sync feature storage: {error}"))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not replace feature storage: {error}"))?;
        enforce_private_mode(&path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(FEATURE_STORAGE_FILE))
        .map_err(|error| format!("Could not locate the app data directory: {error}"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(FEATURE_STORAGE_FILE);
    let sequence = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence))
}

fn open_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

#[cfg(unix)]
fn enforce_private_mode(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        format!(
            "Could not set private permissions on {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn enforce_private_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_plugins_install_as_discoverable_features() {
        let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "pi-desktop-starter-test-{}-{sequence}",
            std::process::id()
        ));
        let features = root.join("features");
        for starter in STARTER_FEATURES {
            let installed = install_starter_into(&features, starter).unwrap();
            let location = load_feature_location(&installed, FeatureSource::Global).unwrap();

            assert_eq!(location.descriptor.id, starter.id);
            assert!(location.descriptor.has_service);
            assert!(installed.join("ui/index.html").is_file());
            assert!(installed.join("service/main.mjs").is_file());
            assert!(installed.join(OFFICIAL_MARKER).is_file());

            install_starter_into(&features, starter).unwrap();
            assert!(installed.join("ui/index.html").is_file());
        }

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn starter_plugin_update_preserves_an_unversioned_legacy_copy() {
        let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "pi-desktop-legacy-starter-test-{}-{sequence}",
            std::process::id()
        ));
        let features = root.join("features");
        let starter = STARTER_FEATURES
            .iter()
            .find(|candidate| candidate.id == "code-review")
            .unwrap();
        let installed = install_starter_into(&features, starter).unwrap();

        fs::remove_file(installed.join(OFFICIAL_MARKER)).unwrap();
        let manifest_path = installed.join(FEATURE_MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest.as_object_mut().unwrap().remove("version");
        manifest.as_object_mut().unwrap().remove("publisher");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        install_starter_into(&features, starter).unwrap();
        let location = load_feature_location(&installed, FeatureSource::Global).unwrap();
        assert_eq!(
            location.descriptor.version.as_deref(),
            Some(starter.version)
        );
        assert_eq!(
            fs::read_dir(root.join("feature-backups")).unwrap().count(),
            1
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
