use crate::kernel::{
    apply_system_proxy_environment, path_for_executable, KernelBridge, KernelLaunch,
};
use crate::settings::{self, AppSettings};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const OUTPUT_EVENT: &str = "pi-native-terminal-output";
const STATUS_EVENT: &str = "pi-native-terminal-status";
const START_COLUMNS: u16 = 100;
const START_ROWS: u16 = 30;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalStatus {
    pub phase: NativeTerminalPhase,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeTerminalPhase {
    Inactive,
    Starting,
    Running,
    Closing,
    Error,
}

impl Default for NativeTerminalStatus {
    fn default() -> Self {
        Self {
            phase: NativeTerminalPhase::Inactive,
            generation: 0,
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTerminalOutput {
    generation: u64,
    data: Vec<u8>,
}

type TerminalWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct NativeTerminalRuntime {
    generation: u64,
    status: NativeTerminalStatus,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<TerminalWriter>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    input_activating: bool,
    pending_input: Vec<u8>,
    shutting_down: bool,
}

impl Default for NativeTerminalRuntime {
    fn default() -> Self {
        Self {
            generation: 0,
            status: NativeTerminalStatus::default(),
            master: None,
            writer: None,
            killer: None,
            input_activating: false,
            pending_input: Vec::new(),
            shutting_down: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeTerminalHost {
    runtime: Arc<Mutex<NativeTerminalRuntime>>,
}

impl NativeTerminalHost {
    pub(crate) fn start_kernel(
        &self,
        app: AppHandle,
        kernel: KernelBridge,
        launch: KernelLaunch,
        settings: AppSettings,
    ) -> Result<NativeTerminalStatus, String> {
        {
            let mut runtime = self.lock_runtime()?;
            if runtime.killer.is_some() {
                return Err("A Pi terminal process is already running.".to_owned());
            }
            runtime.generation = launch.generation;
            runtime.input_activating = false;
            runtime.pending_input.clear();
            runtime.shutting_down = false;
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Starting,
                generation: launch.generation,
                error: None,
            };
        }
        emit_status(&app, &self.status()?);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(terminal_size(START_COLUMNS, START_ROWS))
            .map_err(|error| self.start_error(&app, format!("Could not open Pi's PTY: {error}")))?;
        let reader = pair.master.try_clone_reader().map_err(|error| {
            self.start_error(
                &app,
                format!("Could not read Pi's native terminal: {error}"),
            )
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            self.start_error(
                &app,
                format!("Could not write to Pi's native terminal: {error}"),
            )
        })?;

        let mut command = CommandBuilder::new(&launch.executable);
        command.arg("--tui-mode");
        command.arg("fullscreen");
        command.arg("--extension");
        command.arg(&launch.extension_path);
        command.cwd(&launch.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("PI_DESKTOP_BRIDGE_SOCKET", &launch.socket_path);
        command.env(
            "PATH",
            path_for_executable(&launch.executable)
                .map_err(|error| self.start_error(&app, error))?,
        );
        copy_proxy_environment(&mut command);
        for (name, value) in settings::provider_environment(&settings) {
            command.env(name, value);
        }

        let child = pair.slave.spawn_command(command).map_err(|error| {
            self.start_error(
                &app,
                format!(
                    "Could not start Pi at {}: {error}",
                    launch.executable.display()
                ),
            )
        })?;
        let mut killer = child.clone_killer();
        let writer = Arc::new(Mutex::new(writer));
        {
            let mut runtime = self.lock_runtime()?;
            if runtime.generation != launch.generation {
                let _ = killer.kill();
                return Err("Pi terminal startup was superseded.".to_owned());
            }
            runtime.master = Some(pair.master);
            runtime.writer = Some(writer);
            runtime.killer = Some(killer);
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Running,
                generation: launch.generation,
                error: None,
            };
        }
        let status = self.status()?;
        emit_status(&app, &status);
        spawn_output_reader(app.clone(), launch.generation, reader);
        spawn_process_monitor(
            Arc::clone(&self.runtime),
            app,
            launch.generation,
            child,
            kernel,
        );
        Ok(status)
    }

    pub fn activate(
        &self,
        initial_input: String,
        columns: u16,
        rows: u16,
    ) -> Result<NativeTerminalStatus, String> {
        {
            let runtime = self.lock_runtime()?;
            if !matches!(runtime.status.phase, NativeTerminalPhase::Running) {
                return Err("Pi native terminal is not running.".to_owned());
            }
            let master = runtime
                .master
                .as_ref()
                .ok_or_else(|| "Pi native terminal PTY is unavailable.".to_owned())?;
            let target = terminal_size(columns, rows);
            let nudge = terminal_size(columns.saturating_sub(1), rows);
            master
                .resize(nudge)
                .and_then(|_| master.resize(target))
                .map_err(|error| format!("Could not resize Pi TUI: {error}"))?;
        }
        self.submit(initial_input)
    }

    pub fn submit(&self, initial_input: String) -> Result<NativeTerminalStatus, String> {
        let (writer, status, generation) = {
            let mut runtime = self.lock_runtime()?;
            if !matches!(runtime.status.phase, NativeTerminalPhase::Running) {
                return Err("Pi native terminal is not running.".to_owned());
            }
            runtime.input_activating = !initial_input.is_empty();
            runtime.pending_input.clear();
            (
                runtime.writer.as_ref().cloned(),
                runtime.status.clone(),
                runtime.generation,
            )
        };
        if !initial_input.is_empty() {
            let writer =
                writer.ok_or_else(|| "Pi native terminal input is unavailable.".to_owned())?;
            let submit = initial_input.trim() != "/";
            let runtime = Arc::clone(&self.runtime);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(70));
                if let Ok(mut writer) = writer.lock() {
                    if submit {
                        let _ = writer.write_all(b"\x1b[200~");
                        let _ = writer.write_all(initial_input.as_bytes());
                        let _ = writer.write_all(b"\x1b[201~");
                        let _ = writer.write_all(b"\r");
                    } else {
                        let _ = writer.write_all(initial_input.as_bytes());
                    }
                    let pending = runtime
                        .lock()
                        .ok()
                        .filter(|state| state.generation == generation)
                        .map(|mut state| {
                            state.input_activating = false;
                            std::mem::take(&mut state.pending_input)
                        })
                        .unwrap_or_default();
                    if !pending.is_empty() {
                        let _ = writer.write_all(&pending);
                    }
                    let _ = writer.flush();
                } else if let Ok(mut state) = runtime.lock() {
                    if state.generation == generation {
                        state.input_activating = false;
                        state.pending_input.clear();
                    }
                }
            });
        }
        Ok(status)
    }

    pub fn write(&self, data: String) -> Result<(), String> {
        let writer = {
            let mut runtime = self.lock_runtime()?;
            if runtime.input_activating {
                runtime.pending_input.extend_from_slice(data.as_bytes());
                return Ok(());
            }
            runtime
                .writer
                .as_ref()
                .cloned()
                .ok_or_else(|| "Pi native terminal is not running.".to_owned())?
        };
        let mut writer = writer
            .lock()
            .map_err(|_| "Pi native terminal input is unavailable.".to_owned())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not send input to Pi TUI: {error}"))
    }

    pub fn resize(&self, columns: u16, rows: u16) -> Result<(), String> {
        let runtime = self.lock_runtime()?;
        let master = runtime
            .master
            .as_ref()
            .ok_or_else(|| "Pi native terminal is not running.".to_owned())?;
        master
            .resize(terminal_size(columns, rows))
            .map_err(|error| format!("Could not resize Pi TUI: {error}"))
    }

    pub fn conceal(&self) -> Result<NativeTerminalStatus, String> {
        self.status()
    }

    pub fn shutdown(&self, app: &AppHandle) {
        let status = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            runtime.shutting_down = true;
            if let Some(killer) = runtime.killer.as_mut() {
                let _ = killer.kill();
            }
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Closing,
                generation: runtime.generation,
                error: None,
            };
            runtime.status.clone()
        };
        emit_status(app, &status);
    }

    pub fn status(&self) -> Result<NativeTerminalStatus, String> {
        Ok(self.lock_runtime()?.status.clone())
    }

    fn start_error(&self, app: &AppHandle, error: String) -> String {
        let status = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return error;
            };
            runtime.master = None;
            runtime.writer = None;
            runtime.killer = None;
            runtime.input_activating = false;
            runtime.pending_input.clear();
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Error,
                generation: runtime.generation,
                error: Some(error.clone()),
            };
            runtime.status.clone()
        };
        emit_status(app, &status);
        error
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, NativeTerminalRuntime>, String> {
        self.runtime
            .lock()
            .map_err(|_| "Native terminal state is unavailable.".to_owned())
    }
}

fn terminal_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(8),
        cols: columns.max(40),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn copy_proxy_environment(command: &mut CommandBuilder) {
    let mut probe = Command::new("/usr/bin/true");
    apply_system_proxy_environment(&mut probe);
    for (name, value) in probe.get_envs() {
        if let Some(value) = value {
            command.env(name, value);
        }
    }
}

fn spawn_output_reader(app: AppHandle, generation: u64, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let _ = app.emit(
                        OUTPUT_EVENT,
                        NativeTerminalOutput {
                            generation,
                            data: buffer[..length].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_process_monitor(
    runtime: Arc<Mutex<NativeTerminalRuntime>>,
    app: AppHandle,
    generation: u64,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    kernel: KernelBridge,
) {
    thread::spawn(move || {
        let result = child.wait();
        let (deliberate, status) = {
            let Ok(mut runtime) = runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            let deliberate = runtime.shutting_down;
            runtime.master = None;
            runtime.writer = None;
            runtime.killer = None;
            runtime.input_activating = false;
            runtime.pending_input.clear();
            runtime.shutting_down = false;
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Inactive,
                generation,
                error: None,
            };
            (deliberate, runtime.status.clone())
        };
        emit_status(&app, &status);
        let (success, detail) = match result {
            Ok(exit) if exit.success() || deliberate => (true, "Pi terminal exited.".to_owned()),
            Ok(exit) => (
                false,
                match exit.signal() {
                    Some(signal) => format!("Pi terminal was terminated by {signal}."),
                    None => format!("Pi terminal exited with status {}.", exit.exit_code()),
                },
            ),
            Err(_error) if deliberate => (true, "Pi terminal stopped.".to_owned()),
            Err(error) => (false, format!("Could not wait for Pi terminal: {error}")),
        };
        kernel.process_exited(&app, generation, success, detail);
    });
}

fn emit_status(app: &AppHandle, status: &NativeTerminalStatus) {
    let _ = app.emit(STATUS_EVENT, status);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn input_typed_during_activation_is_queued() {
        let host = NativeTerminalHost::default();
        {
            let mut runtime = host.runtime.lock().unwrap();
            runtime.input_activating = true;
        }

        host.write("model".to_owned()).unwrap();

        let runtime = host.runtime.lock().unwrap();
        assert_eq!(runtime.pending_input, b"model");
    }

    #[test]
    fn hidden_command_is_submitted_to_the_resident_terminal() {
        let host = NativeTerminalHost::default();
        let output = Arc::new(Mutex::new(Vec::new()));
        {
            let mut runtime = host.runtime.lock().unwrap();
            runtime.generation = 7;
            runtime.status = NativeTerminalStatus {
                phase: NativeTerminalPhase::Running,
                generation: 7,
                error: None,
            };
            runtime.writer = Some(Arc::new(Mutex::new(Box::new(RecordingWriter(Arc::clone(
                &output,
            ))))));
        }

        host.submit("/new".to_owned()).unwrap();
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            output.lock().unwrap().as_slice(),
            b"\x1b[200~/new\x1b[201~\r"
        );
    }
}
