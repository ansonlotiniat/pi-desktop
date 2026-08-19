use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const SKILL_ID: &str = "pi-desktop-feature-builder";
const SKILL_NAME: &str = "Pi Desktop Feature Builder";
const SKILL_VERSION: &str = "1.0.0";
const OWNERSHIP_MARKER: &str = ".pi-desktop-owned.json";
static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const SKILL_FILES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        include_str!("../resources/skills/pi-desktop-feature-builder/SKILL.md"),
    ),
    (
        "agents/openai.yaml",
        include_str!("../resources/skills/pi-desktop-feature-builder/agents/openai.yaml"),
    ),
    (
        "references/feature-host-api.md",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/references/feature-host-api.md"
        ),
    ),
    (
        "references/pi-desktop-feature.d.ts",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/references/pi-desktop-feature.d.ts"
        ),
    ),
    (
        "references/feature.schema.json",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/references/feature.schema.json"
        ),
    ),
    (
        "assets/feature-template/feature.json",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/assets/feature-template/feature.json"
        ),
    ),
    (
        "assets/feature-template/service/main.mjs",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/assets/feature-template/service/main.mjs"
        ),
    ),
    (
        "assets/feature-template/ui/index.html",
        include_str!(
            "../resources/skills/pi-desktop-feature-builder/assets/feature-template/ui/index.html"
        ),
    ),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoringSkillStatus {
    id: String,
    name: String,
    version: String,
    directory: String,
    installed: bool,
    managed: bool,
    update_available: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnershipMarker {
    id: String,
    version: String,
}

pub fn status(app: &AppHandle) -> Result<AuthoringSkillStatus, String> {
    status_at(&skill_directory(app)?)
}

pub fn install(app: &AppHandle) -> Result<AuthoringSkillStatus, String> {
    let destination = skill_directory(app)?;
    install_at(&destination)?;
    status_at(&destination)
}

pub fn remove(app: &AppHandle) -> Result<AuthoringSkillStatus, String> {
    let destination = skill_directory(app)?;
    if destination.exists() {
        let marker = read_marker(&destination)?.ok_or_else(|| {
            format!(
                "{} is not managed by Pi Desktop and will not be removed.",
                destination.display()
            )
        })?;
        if marker.id != SKILL_ID {
            return Err(format!(
                "{} is not the Pi Desktop authoring skill.",
                destination.display()
            ));
        }
        fs::remove_dir_all(&destination).map_err(|error| {
            format!(
                "Could not remove authoring support at {}: {error}",
                destination.display()
            )
        })?;
    }
    status_at(&destination)
}

fn skill_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    Ok(home.join(".agents/skills").join(SKILL_ID))
}

fn status_at(destination: &Path) -> Result<AuthoringSkillStatus, String> {
    let marker = read_marker(destination)?;
    let installed = destination.is_dir();
    let managed = marker
        .as_ref()
        .is_some_and(|candidate| candidate.id == SKILL_ID);
    Ok(AuthoringSkillStatus {
        id: SKILL_ID.to_owned(),
        name: SKILL_NAME.to_owned(),
        version: SKILL_VERSION.to_owned(),
        directory: destination.to_string_lossy().into_owned(),
        installed,
        managed,
        update_available: managed
            && marker
                .as_ref()
                .is_some_and(|candidate| candidate.version != SKILL_VERSION),
    })
}

fn read_marker(destination: &Path) -> Result<Option<OwnershipMarker>, String> {
    let path = destination.join(OWNERSHIP_MARKER);
    if !path.exists() {
        return Ok(None);
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        format!(
            "Invalid Pi Desktop skill marker at {}: {error}",
            path.display()
        )
    })
}

fn install_at(destination: &Path) -> Result<(), String> {
    if destination.exists() {
        let managed = read_marker(destination)?.is_some_and(|candidate| candidate.id == SKILL_ID);
        if !managed {
            return Err(format!(
                "{} already contains a custom skill. Pi Desktop will not overwrite it.",
                destination.display()
            ));
        }
    }
    let skills_directory = destination
        .parent()
        .ok_or_else(|| "Authoring skill directory has no parent.".to_owned())?;
    fs::create_dir_all(skills_directory).map_err(|error| {
        format!(
            "Could not create the agent skills directory {}: {error}",
            skills_directory.display()
        )
    })?;

    let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let staging = skills_directory.join(format!(
        ".{SKILL_ID}.installing-{}-{sequence}",
        std::process::id()
    ));
    let backup = skills_directory.join(format!(
        ".{SKILL_ID}.replacing-{}-{sequence}",
        std::process::id()
    ));

    let result = (|| -> Result<(), String> {
        fs::create_dir(&staging)
            .map_err(|error| format!("Could not prepare {}: {error}", staging.display()))?;
        for (relative, contents) in SKILL_FILES {
            write_private_file(&staging.join(relative), contents.as_bytes())?;
        }
        let marker = serde_json::to_vec_pretty(&OwnershipMarker {
            id: SKILL_ID.to_owned(),
            version: SKILL_VERSION.to_owned(),
        })
        .map_err(|error| format!("Could not serialize the authoring skill marker: {error}"))?;
        write_private_file(&staging.join(OWNERSHIP_MARKER), &marker)?;

        if destination.exists() {
            fs::rename(destination, &backup).map_err(|error| {
                format!("Could not prepare the existing authoring skill for update: {error}")
            })?;
        }
        if let Err(error) = fs::rename(&staging, destination) {
            if backup.exists() {
                let _ = fs::rename(&backup, destination);
            }
            return Err(format!("Could not enable AI authoring support: {error}"));
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    file.write_all(contents)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authoring_skill_install_and_update_are_owned() {
        let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "pi-desktop-authoring-test-{}-{sequence}",
            std::process::id()
        ));
        let destination = root.join(".agents/skills").join(SKILL_ID);

        install_at(&destination).unwrap();
        assert!(status_at(&destination).unwrap().managed);
        assert!(destination.join("SKILL.md").is_file());
        install_at(&destination).unwrap();
        assert!(!status_at(&destination).unwrap().update_available);

        fs::remove_dir_all(&root).unwrap();
    }
}
