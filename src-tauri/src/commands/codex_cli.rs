//! Codex CLI subprocess transport.
//!
//! This mirrors the Claude Code CLI transport, but treats `codex` as a
//! local completion engine via `codex exec --json`. The webview can only
//! spawn this fixed command; it cannot execute arbitrary shell commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

use super::cli_resolver::{
    child_path_env, cli_version_timeout_error, find_cli_command, CLI_VERSION_PROBE_TIMEOUT,
};

#[derive(Default)]
pub struct CodexCliState {
    children: Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}

const DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 10;
const MIN_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 1;
const MAX_CODEX_SPAWN_TIMEOUT_MINUTES: u64 = 240;
const STDERR_LIMIT_BYTES: usize = 1024 * 1024;
const STDOUT_LIMIT_BYTES: usize = 1024 * 1024;

// Small IPC attachments only; filenames and paths are exclusively Rust-owned.
const MAX_CODEX_IMAGES: usize = 4;
const MAX_CODEX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_CODEX_TOTAL_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_CODEX_BASE64_LENGTH: usize = MAX_CODEX_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_CODEX_IMAGE_DIMENSION: u32 = 8192;
const MAX_CODEX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexImageAttachment {
    media_type: String,
    data_base64: String,
}

#[derive(Default)]
struct CodexImages {
    directory: Option<PathBuf>,
    files: Vec<PathBuf>,
}

impl Drop for CodexImages {
    fn drop(&mut self) {
        // Never scan a shared directory or recursively delete. Only unlink
        // files created by this guard, then its (now empty) unique directory.
        for file in &self.files {
            let _ = std::fs::remove_file(file);
        }
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir(directory);
        }
    }
}

fn prepare_codex_images(attachments: Vec<CodexImageAttachment>) -> Result<CodexImages, String> {
    if attachments.len() > MAX_CODEX_IMAGES {
        return Err("Codex CLI accepts at most 4 images".to_string());
    }
    let mut images = CodexImages::default();
    let mut total = 0;
    for attachment in attachments {
        let (format, extension) = match attachment.media_type.as_str() {
            "image/png" => (image::ImageFormat::Png, "png"),
            "image/jpeg" => (image::ImageFormat::Jpeg, "jpg"),
            "image/gif" => (image::ImageFormat::Gif, "gif"),
            _ => return Err("Codex CLI images must be PNG, JPEG or GIF".to_string()),
        };
        if attachment.data_base64.is_empty()
            || attachment.data_base64.len() > MAX_CODEX_BASE64_LENGTH
        {
            return Err("Invalid or oversized Codex CLI image base64".to_string());
        }
        // STANDARD requires canonical padding and rejects whitespace, data:
        // URLs, invalid trailing bits and path-shaped input.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data_base64)
            .map_err(|_| "Invalid Codex CLI image base64")?;
        total += bytes.len();
        if bytes.len() > MAX_CODEX_IMAGE_BYTES || total > MAX_CODEX_TOTAL_IMAGE_BYTES {
            return Err(
                "Codex CLI image size limit exceeded (5 MiB each, 12 MiB total)".to_string(),
            );
        }
        if image::guess_format(&bytes).ok() != Some(format) {
            return Err("Codex CLI image content does not match its media type".to_string());
        }
        let dimensions = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
            .into_dimensions()
            .map_err(|_| "Invalid Codex CLI image header")?;
        if dimensions.0 == 0
            || dimensions.1 == 0
            || dimensions.0 > MAX_CODEX_IMAGE_DIMENSION
            || dimensions.1 > MAX_CODEX_IMAGE_DIMENSION
            || u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_CODEX_IMAGE_PIXELS
        {
            return Err("Codex CLI image dimensions exceed the limit".to_string());
        }
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_CODEX_IMAGE_DIMENSION);
        limits.max_image_height = Some(MAX_CODEX_IMAGE_DIMENSION);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|_| "Invalid or unsupported Codex CLI image")?;

        if images.directory.is_none() {
            let directory = std::env::temp_dir()
                .join(format!("llm-wiki-codex-images-{}", uuid::Uuid::new_v4()));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&directory)
                .map_err(|_| "Cannot create private Codex CLI image directory")?;
            images.directory = Some(directory);
        }
        let file = images
            .directory
            .as_ref()
            .expect("created directory")
            .join(format!("image-{}.{}", images.files.len() + 1, extension));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&file)
            .map_err(|_| "Cannot create Codex CLI image file")?;
        images.files.push(file);
        use std::io::Write;
        output
            .write_all(&bytes)
            .map_err(|_| "Cannot write Codex CLI image file")?;
    }
    Ok(images)
}

fn codex_image_args(images: &CodexImages) -> Vec<std::ffi::OsString> {
    // Repeat the actual CLI option, one file per option, so paths with spaces
    // remain one argument. No shell, caller filenames or comma-separated paths.
    images
        .files
        .iter()
        .flat_map(|file| ["--image".into(), file.as_os_str().to_owned()])
        .collect()
}

// Set the group before spawn, so Node and the native CLI it launches inherit
// this stream's group from their first instruction. Never target process names.
fn spawn_codex_child(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[cfg(unix)]
fn signal_codex_group(process_id: u32, signal: std::os::raw::c_int) -> std::io::Result<()> {
    // The POSIX ABI is supplied by the OS C runtime, already linked by std.
    // No new Cargo dependency is needed for this single fixed-signature call.
    unsafe extern "C" {
        #[link_name = "kill"]
        fn posix_kill(pid: std::os::raw::c_int, signal: std::os::raw::c_int)
            -> std::os::raw::c_int;
    }
    let pgid = i32::try_from(process_id)
        .ok()
        .filter(|id| *id > 1)
        .ok_or_else(|| std::io::Error::other("Invalid Codex CLI process group"))?;
    // SAFETY: a negative, checked ID addresses only the private group created
    // by spawn_codex_child. Signal 0 probes existence; SIGKILL terminates it.
    if unsafe { posix_kill(-pgid, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn codex_group_exists(process_id: u32) -> std::io::Result<bool> {
    match signal_codex_group(process_id, 0) {
        Ok(()) => Ok(true),
        // ESRCH is 3 on our supported Unix targets (macOS/Linux/BSD).
        Err(error) if error.raw_os_error() == Some(3) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
async fn wait_codex_group_exit(process_id: u32) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while codex_group_exists(process_id)
        .map_err(|e| format!("Cannot inspect Codex CLI process group: {e}"))?
    {
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "Cannot confirm Codex CLI process group termination; image attachments retained"
                    .into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn stop_codex_process_tree(child: &mut Child, process_id: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        const SIGKILL: std::os::raw::c_int = 9;
        match signal_codex_group(process_id, SIGKILL) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(3) => {}
            Err(error) if error.raw_os_error() == Some(1) => {
                // macOS returns EPERM for a group whose only member is an
                // exited, unreaped wrapper (e.g. EPIPE while sending stdin).
                // Accept that case only after observing/reaping its exit;
                // the group-exit check below must still confirm no survivors.
                if child
                    .try_wait()
                    .map_err(|e| format!("Cannot inspect Codex CLI wrapper exit: {e}"))?
                    .is_none()
                {
                    return Err(format!("Cannot stop Codex CLI process group: {error}"));
                }
            }
            Err(error) => return Err(format!("Cannot stop Codex CLI process group: {error}")),
        }
        // Reap the wrapper, then wait for the *group*, including native
        // descendants, before allowing its attachment guard to run.
        child
            .wait()
            .await
            .map_err(|e| format!("Cannot reap Codex CLI wrapper: {e}"))?;
        return wait_codex_group_exit(process_id).await;
    }
    #[cfg(windows)]
    {
        // Windows has no Unix killpg equivalent. Use the system utility's
        // PID-scoped tree termination, never /IM. This is not a Job Object:
        // already-detached descendants are outside its tracking guarantee.
        let system_root =
            std::env::var_os("SystemRoot").ok_or("Cannot resolve Windows SystemRoot")?;
        let mut command = Command::new(PathBuf::from(system_root).join("System32/taskkill.exe"));
        suppress_windows_console(&mut command);
        let status = command
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| format!("Cannot terminate Codex CLI process tree: {e}"))?;
        if !status.success() {
            return Err(
                "Windows could not confirm Codex CLI tree termination; image attachments retained"
                    .into(),
            );
        }
        child
            .wait()
            .await
            .map_err(|e| format!("Cannot reap Codex CLI wrapper: {e}"))?;
        return Ok(());
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (child, process_id);
        Err("Codex CLI process-tree termination is unsupported on this platform".into())
    }
}

async fn finish_codex_child(
    child: &mut Child,
    prompt: &str,
    cancelled: oneshot::Receiver<()>,
    timeout: Duration,
    images: CodexImages,
) -> (Option<i32>, bool, Option<String>) {
    let process_id = child.id().expect("newly spawned Codex CLI child");
    let mut timed_out = false;
    let result = tokio::select! {
        result = async {
            let mut stdin = child.stdin.take().ok_or("Missing stdin handle".to_string())?;
            stdin.write_all(prompt.as_bytes()).await.map_err(|e| format!("Failed to write to codex stdin: {e}"))?;
            stdin.shutdown().await.map_err(|e| format!("Failed to close codex stdin: {e}"))?;
            drop(stdin);
            child.wait().await.map_err(|e| format!("Failed to wait for codex: {e}"))
        } => result,
        _ = cancelled => Err("Codex CLI cancelled".to_string()),
        _ = tokio::time::sleep(timeout) => {
            timed_out = true;
            Err("Codex CLI timed out".to_string())
        }
    };
    let (code, error) = match result {
        Ok(status) => {
            // A normal wrapper completion must not release files while its
            // inherited group still has a native child running.
            #[cfg(unix)]
            if let Err(error) = wait_codex_group_exit(process_id).await {
                if let Err(stop_error) = stop_codex_process_tree(child, process_id).await {
                    retain_codex_images(images);
                    return (Some(-1), false, Some(format!("{error}; {stop_error}")));
                }
            }
            (status.code(), None)
        }
        Err(error) => {
            if let Err(stop_error) = stop_codex_process_tree(child, process_id).await {
                // Never delete files a potentially surviving native CLI can
                // still be reading. Report a stop failure, not a clean stop.
                retain_codex_images(images);
                return (Some(-1), timed_out, Some(format!("{error}; {stop_error}")));
            }
            (if timed_out { None } else { Some(-1) }, Some(error))
        }
    };
    drop(images);
    (code, timed_out, error)
}

fn retain_codex_images(mut images: CodexImages) {
    // Exceptional OS termination/verification failure: leave only this
    // stream's private files in place rather than deleting them prematurely.
    if let Some(directory) = images.directory.take() {
        eprintln!(
            "[codex-cli] could not confirm tree termination; retained images in {}",
            directory.display()
        );
    }
    images.files.clear();
}

async fn collect_cli_output(task: &mut tokio::task::JoinHandle<String>) -> String {
    match tokio::time::timeout(Duration::from_secs(1), &mut *task).await {
        Ok(result) => result.unwrap_or_default(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            String::new()
        }
    }
}

fn append_capped_line(collected: &mut String, line: &str, limit_bytes: usize) {
    if collected.len() >= limit_bytes {
        return;
    }
    for ch in line.chars() {
        if collected.len() + ch.len_utf8() > limit_bytes {
            break;
        }
        collected.push(ch);
    }
    if collected.len() < limit_bytes {
        collected.push('\n');
    }
}

async fn find_codex_command() -> Result<PathBuf, String> {
    find_cli_command("codex", &["codex.cmd", "codex.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[tauri::command]
pub async fn codex_cli_detect() -> Result<DetectResult, String> {
    let path = match find_codex_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();
    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    // `codex` is a node shim (`#!/usr/bin/env node`); under a GUI launch the
    // inherited PATH lacks node, so hand it the login shell PATH or its
    // shebang fails with `env: node: No such file or directory`.
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let output =
        tokio::time::timeout(CLI_VERSION_PROBE_TIMEOUT, cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: Some(stdout),
                path: Some(path_str),
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error: Some(if stderr.is_empty() {
                    format!("`codex --version` exited with {}", out.status)
                } else {
                    stderr
                }),
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(format!("Failed to spawn `codex`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(cli_version_timeout_error("codex")),
        }),
    }
}

#[tauri::command]
pub async fn codex_cli_spawn(
    app: AppHandle,
    state: State<'_, CodexCliState>,
    stream_id: String,
    model: String,
    prompt: String,
    isolate_local_config: bool,
    timeout_minutes: Option<u64>,
    working_directory: Option<String>,
    images: Option<Vec<CodexImageAttachment>>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("No prompt to send to codex CLI".to_string());
    }

    let working_directory = resolve_codex_working_directory(working_directory).await?;
    let codex = find_codex_command().await?;
    let mut cmd = Command::new(&codex);
    suppress_windows_console(&mut cmd);
    // See `codex_cli_detect`: the node shim needs the login shell PATH at run
    // time so its shebang resolves `node` under a GUI launch.
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let codex_home = match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .home_dir()
            .map_err(|_| "Cannot resolve Codex home")?
            .join(".codex"),
    };
    if !codex_home.is_absolute() {
        return Err("Cannot isolate Mem: CODEX_HOME must be an absolute path".to_string());
    }
    cmd.args(build_codex_cli_args(&model, isolate_local_config)?);
    cmd.args(codex_mem_isolation_args(&codex_home)?);
    let images = prepare_codex_images(images.unwrap_or_default())?;
    cmd.args(codex_image_args(&images));
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Reserve the ID before spawning; a repeated ID cannot replace another
    // stream's cancellation handle. Keep the entry until its owner finishes.
    let mut children = state.children.lock().await;
    if children.contains_key(&stream_id) {
        return Err("Codex CLI stream ID is already active".to_string());
    }
    let mut child =
        spawn_codex_child(&mut cmd).map_err(|e| format!("Failed to spawn codex: {e}"))?;
    let (cancel, cancelled) = oneshot::channel();
    children.insert(stream_id.clone(), Some(cancel));
    drop(children);

    let children = Arc::clone(&state.children);
    let timeout_minutes = codex_spawn_timeout_minutes(timeout_minutes);
    let timeout_duration = Duration::from_secs(timeout_minutes * 60);
    let topic = format!("codex-cli:{stream_id}");
    let done_topic = format!("codex-cli:{stream_id}:done");

    tokio::spawn(async move {
        // This task exclusively owns the child and its files. Even stdin
        // backpressure is subject to cancellation and the configured timeout.
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let output_app = app.clone();
        let mut stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut collected = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                append_capped_line(&mut collected, &line, STDOUT_LIMIT_BYTES);
                if output_app.emit(&topic, line).is_err() {
                    break;
                }
            }
            collected
        });
        let mut stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut collected = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                eprintln!("[codex-cli stderr] {line}");
                append_capped_line(&mut collected, &line, STDERR_LIMIT_BYTES);
            }
            collected
        });

        let (exit_code, timed_out, error) =
            finish_codex_child(&mut child, &prompt, cancelled, timeout_duration, images).await;
        // Descendants inheriting stdout/stderr must not retain attachments
        // indefinitely after the actual CLI process exits or is killed.
        let mut stdout_text = collect_cli_output(&mut stdout_task).await;
        let mut stderr_text = collect_cli_output(&mut stderr_task).await;
        if let Some(error) = error {
            append_capped_line(&mut stderr_text, &error, STDERR_LIMIT_BYTES);
        }
        if stderr_text.len() >= STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }
        if stdout_text.len() >= STDOUT_LIMIT_BYTES {
            stdout_text.push_str("\n[stdout truncated]");
        }
        drop(child);
        children.lock().await.remove(&stream_id);
        let _ = app.emit(
            &done_topic,
            done_payload(
                exit_code,
                timed_out,
                timeout_minutes,
                &stderr_text,
                &stdout_text,
            ),
        );
    });

    Ok(())
}

/// Shape of the `codex-cli:{id}:done` event. Split out from the emit site so
/// that the key names, which `codex-cli-transport.ts` reads by hand, are
/// covered by a test instead of only by reading the two files side by side.
/// This pins the Rust half only; the frontend can still drift independently.
fn done_payload(
    exit_code: Option<i32>,
    timed_out: bool,
    timeout_minutes: u64,
    stderr: &str,
    stdout: &str,
) -> serde_json::Value {
    serde_json::json!({
        "code": exit_code,
        "timedOut": timed_out,
        "timeoutMinutes": timeout_minutes,
        "stderr": stderr,
        "stdout": stdout,
    })
}

fn codex_spawn_timeout_minutes(value: Option<u64>) -> u64 {
    value.unwrap_or(DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES).clamp(
        MIN_CODEX_SPAWN_TIMEOUT_MINUTES,
        MAX_CODEX_SPAWN_TIMEOUT_MINUTES,
    )
}

fn build_codex_cli_args(model: &str, isolate_local_config: bool) -> Result<Vec<String>, String> {
    let mut args = vec!["-a".to_string(), "never".to_string(), "exec".to_string()];

    if isolate_local_config {
        return Err("Turn off Codex CLI's 'Isolate local config' option: it bypasses safety configuration. LLM Wiki isolates Nowledge Mem separately for each subprocess.".to_string());
    }

    args.extend([
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--ephemeral".to_string(),
        // This subprocess is a completion provider; source retrieval is owned by Wiki.
        "-c".to_string(),
        "features.shell_tool=false".to_string(),
        "--model".to_string(),
        model.to_string(),
        "-".to_string(),
    ]);
    Ok(args)
}

/// Per-invocation overrides only: keep the user's config, rules, hook trust,
/// and PreToolUse protections. Never rewrite a shared Codex configuration.
fn codex_mem_isolation_args(codex_home: &Path) -> Result<Vec<String>, String> {
    let hooks_path = codex_home.join("hooks.json");
    let hooks = match std::fs::read_to_string(&hooks_path) {
        Ok(text) => Some(
            serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|_| "Cannot isolate Mem: Codex hooks.json is invalid JSON")?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Cannot isolate Mem: Codex hooks.json is unreadable".to_string()),
    };
    mem_isolation_overrides(&hooks_path, hooks.as_ref())
}

fn mem_isolation_overrides(
    hooks_path: &Path,
    hooks: Option<&serde_json::Value>,
) -> Result<Vec<String>, String> {
    let mut overrides = vec![
        "plugins={\"nowledge-mem@nowledge-community\"={enabled=false},\"nowledge-mem@local\"={enabled=false}}".to_string(),
        "mcp_servers.nowledge-mem.enabled=false".to_string(),
    ];
    let mut hook_states = Vec::new();
    if let Some(hooks) = hooks {
        let events = hooks
            .get("hooks")
            .and_then(|v| v.as_object())
            .ok_or("Cannot isolate Mem: unsupported Codex hooks.json structure")?;
        for (event, state_event) in [
            ("SessionStart", "session_start"),
            ("SubagentStart", "subagent_start"),
            ("UserPromptSubmit", "user_prompt_submit"),
            ("Stop", "stop"),
        ] {
            let Some(groups) = events.get(event) else {
                continue;
            };
            let groups = groups
                .as_array()
                .ok_or("Cannot isolate Mem: invalid hook groups")?;
            for (group_index, group) in groups.iter().enumerate() {
                let entries = group
                    .get("hooks")
                    .and_then(|v| v.as_array())
                    .ok_or("Cannot isolate Mem: invalid hook entries")?;
                for (hook_index, hook) in entries.iter().enumerate() {
                    let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    if !is_standalone_mem_hook(command)? {
                        continue;
                    }
                    let id = format!(
                        "{}:{state_event}:{group_index}:{hook_index}",
                        hooks_path.display()
                    );
                    let quoted = serde_json::to_string(&id).expect("hook ID is serializable");
                    hook_states.push(format!("{quoted}={{enabled=false}}"));
                }
            }
        }
    }
    // CLI key paths split on dots even inside quotes. Keep IDs in the TOML
    // value instead; inline tables merge without discarding other hook states.
    if !hook_states.is_empty() {
        overrides.push(format!("hooks.state={{{}}}", hook_states.join(",")));
    }
    Ok(overrides
        .into_iter()
        .flat_map(|value| ["-c".to_string(), value])
        .collect())
}

fn is_standalone_mem_hook(command: &str) -> Result<bool, String> {
    const SCRIPTS: &[&str] = &[
        "nowledge-mem-project-router.py",
        "nowledge-mem-context.py",
        "nowledge-mem-stop-save.py",
        "nowledge-mem-mailbox-stop.py",
    ];
    if !SCRIPTS.iter().any(|name| command.contains(name)) {
        return Ok(false);
    }
    if command.contains([';', '|', '&', '\n', '`']) || command.contains("$(") {
        return Err(
            "Cannot isolate a combined Mem hook without affecting other commands".to_string(),
        );
    }
    let words = shlex::split(command).ok_or("Cannot isolate an unparseable Mem hook")?;
    let basename = |word: &str| word.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    let executable = words.first().map(|w| basename(w)).unwrap_or_default();
    let is_python = executable == "py"
        || executable == "py.exe"
        || executable
            .strip_suffix(".exe")
            .unwrap_or(&executable)
            .strip_prefix("python")
            .is_some_and(|suffix| suffix.chars().all(|c| c.is_ascii_digit() || c == '.'));
    let script = if is_python {
        words
            .iter()
            .skip(1)
            .find(|w| !["-u", "-B", "-I", "-E", "-s", "-S", "-3"].contains(&w.as_str()))
    } else {
        words.first()
    };
    if !script.is_some_and(|w| SCRIPTS.contains(&basename(w).as_str())) {
        if [
            "sh",
            "bash",
            "zsh",
            "cmd",
            "cmd.exe",
            "powershell",
            "pwsh",
            "env",
        ]
        .contains(&executable.as_str())
            || (is_python && script.is_some_and(|w| w.starts_with('-')))
        {
            return Err(
                "Cannot isolate a wrapped Mem hook without affecting other commands".to_string(),
            );
        }
        return Ok(false);
    }
    Ok(true)
}

async fn resolve_codex_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let raw = value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Codex CLI requires an active project working directory".to_string())?;
    let path = Path::new(raw.as_str());
    if !path.is_absolute() {
        return Err("Codex CLI working directory must be an absolute project path".to_string());
    }
    let path_meta = tokio::fs::metadata(path).await.map_err(|e| {
        eprintln!("[codex-cli] failed to read working directory metadata {raw}: {e}");
        format!("Codex CLI working directory does not exist or cannot be read: {raw}")
    })?;
    if !path_meta.is_dir() {
        return Err(format!(
            "Codex CLI working directory is not a directory: {raw}"
        ));
    }
    let index_path = path.join("wiki").join("index.md");
    let index_meta = tokio::fs::metadata(&index_path).await.map_err(|e| {
        eprintln!("[codex-cli] failed to read wiki/index.md metadata for {raw}: {e}");
        format!("Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}")
    })?;
    if !index_meta.is_file() {
        return Err(format!(
            "Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}"
        ));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|e| format!("Failed to canonicalize Codex CLI working directory {raw}: {e}"))
}

#[tauri::command]
pub async fn codex_cli_kill(
    state: State<'_, CodexCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state
        .children
        .lock()
        .await
        .get_mut(&stream_id)
        .and_then(Option::take)
    {
        let _ = cancel.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image(format: image::ImageFormat, media_type: &str) -> CodexImageAttachment {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut encoded, format)
            .unwrap();
        CodexImageAttachment {
            media_type: media_type.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(encoded.into_inner()),
        }
    }

    fn sample_png() -> CodexImageAttachment {
        sample_image(image::ImageFormat::Png, "image/png")
    }

    #[test]
    fn image_ipc_rejects_filenames_paths_and_unknown_fields() {
        for field in ["path", "fileName", "filename", "url"] {
            let mut value = serde_json::json!({"mediaType": "image/png", "dataBase64": "AAAA"});
            value[field] = "../../another-stream/image.png".into();
            assert!(serde_json::from_value::<CodexImageAttachment>(value).is_err());
        }
    }

    #[test]
    fn images_use_private_unique_directories_and_fixed_names() {
        let images = prepare_codex_images(vec![
            sample_png(),
            sample_image(image::ImageFormat::Jpeg, "image/jpeg"),
            sample_image(image::ImageFormat::Gif, "image/gif"),
        ])
        .unwrap();
        let other = prepare_codex_images(vec![sample_png()]).unwrap();
        let directory = images.directory.clone().unwrap();
        assert_ne!(images.directory, other.directory);
        for (file, name) in images
            .files
            .iter()
            .zip(["image-1.png", "image-2.jpg", "image-3.gif"])
        {
            assert_eq!(file.file_name().unwrap(), name);
            assert_eq!(file.parent().unwrap(), directory);
            assert!(image::open(file).is_ok());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
        }
        let args = codex_image_args(&images);
        assert_eq!(args.len(), 6);
        for (pair, file) in args.chunks_exact(2).zip(&images.files) {
            assert_eq!(pair[0], "--image");
            assert_eq!(pair[1], file.as_os_str());
        }
        drop(images);
        assert!(!directory.exists());
        assert!(other.files[0].exists());
        assert!(prepare_codex_images(Vec::new())
            .unwrap()
            .directory
            .is_none());
    }

    #[test]
    fn image_validation_rejects_bad_data_mime_and_bounds() {
        for data in [
            "",
            "aGVsbG8=",
            "AB==",
            "AAAA\n",
            "data:image/png;base64,AAAA",
            "/tmp/a.png",
        ] {
            assert!(prepare_codex_images(vec![CodexImageAttachment {
                media_type: "image/png".into(),
                data_base64: data.into(),
            }])
            .is_err());
        }
        for media_type in [
            "image/svg+xml",
            "image/webp",
            "image/PNG",
            "../../image.png",
        ] {
            let mut image = sample_png();
            image.media_type = media_type.into();
            assert!(prepare_codex_images(vec![image]).is_err());
        }
        let mut mismatch = sample_png();
        mismatch.media_type = "image/jpeg".into();
        assert!(prepare_codex_images(vec![mismatch]).is_err());
        assert!(prepare_codex_images((0..5).map(|_| sample_png()).collect()).is_err());
        let oversized = CodexImageAttachment {
            media_type: "image/png".into(),
            data_base64: "A".repeat(MAX_CODEX_BASE64_LENGTH + 4),
        };
        assert!(prepare_codex_images(vec![oversized]).is_err());
        // Test the exact decoded boundary too, within the encoded-length cap.
        let oversized = CodexImageAttachment {
            media_type: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(vec![
                0;
                MAX_CODEX_IMAGE_BYTES
                    + 1
            ]),
        };
        assert!(prepare_codex_images(vec![oversized])
            .err()
            .unwrap()
            .contains("size limit"));

        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_luma8(MAX_CODEX_IMAGE_DIMENSION + 1, 1)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        assert!(prepare_codex_images(vec![CodexImageAttachment {
            media_type: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(encoded.into_inner()),
        }])
        .err()
        .unwrap()
        .contains("dimensions"));
        let mut corrupt = base64::engine::general_purpose::STANDARD
            .decode(sample_png().data_base64)
            .unwrap();
        corrupt.truncate(corrupt.len() / 2);
        assert!(prepare_codex_images(vec![CodexImageAttachment {
            media_type: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(corrupt),
        }])
        .is_err());
    }

    #[test]
    fn image_total_size_limit_and_failed_setup_preserve_other_stream() {
        let other = prepare_codex_images(vec![sample_png()]).unwrap();
        let attachments = (0..4)
            .map(|_| {
                let mut bytes = base64::engine::general_purpose::STANDARD
                    .decode(sample_png().data_base64)
                    .unwrap();
                bytes.resize(MAX_CODEX_TOTAL_IMAGE_BYTES / 4 + 1, 0);
                CodexImageAttachment {
                    media_type: "image/png".into(),
                    data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                }
            })
            .collect();
        assert!(prepare_codex_images(attachments)
            .err()
            .unwrap()
            .contains("size limit"));
        assert!(other.files[0].exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn image_cleanup_on_success_failure_timeout_and_cancel_including_blocked_stdin() {
        let other = prepare_codex_images(vec![sample_png()]).unwrap();
        for mode in ["success", "failure", "timeout", "cancel", "stdin-error"] {
            let images = prepare_codex_images(vec![sample_png()]).unwrap();
            let directory = images.directory.clone().unwrap();
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(match mode {
                "success" => "cat >/dev/null",
                "failure" => "cat >/dev/null; exit 7",
                "stdin-error" => "exit 9",
                _ => "exec sleep 30", // holds stdin open without reading
            });
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut child = spawn_codex_child(&mut command).unwrap();
            let (cancel, cancelled) = oneshot::channel();
            let stopper = if mode == "cancel" {
                Some(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    cancel.send(()).unwrap();
                }))
            } else {
                None
            };
            let timeout = if mode == "timeout" {
                Duration::from_millis(25)
            } else {
                Duration::from_secs(2)
            };
            let prompt = if ["timeout", "cancel", "stdin-error"].contains(&mode) {
                "x".repeat(2 * 1024 * 1024)
            } else {
                "caption".into()
            };
            let (code, timed_out, error) =
                finish_codex_child(&mut child, &prompt, cancelled, timeout, images).await;
            if let Some(stopper) = stopper {
                stopper.await.unwrap();
            }
            assert!(!directory.exists(), "{mode} leaked attachments: {error:?}");
            assert!(other.files[0].exists(), "{mode} touched a different stream");
            assert!(
                child.try_wait().unwrap().is_some(),
                "{mode} did not reap child"
            );
            assert_eq!(timed_out, mode == "timeout");
            match mode {
                "success" => {
                    assert_eq!(code, Some(0));
                    assert!(error.is_none());
                }
                "failure" => {
                    assert_eq!(code, Some(7));
                    assert!(error.is_none());
                }
                "stdin-error" => assert!(
                    error.as_deref().is_some_and(|message| message
                        .starts_with("Failed to write to codex stdin:")
                        && !message.contains("Cannot stop")
                        && !message.contains("Cannot confirm")),
                    "stdin write failure was replaced by a termination failure: {error:?}",
                ),
                _ => assert!(error.is_some()),
            }
        }
        // Pre-spawn failure uses the same RAII owner as any setup error.
        let images = prepare_codex_images(vec![sample_png()]).unwrap();
        let directory = images.directory.clone().unwrap();
        let failed_spawn = (|| -> Result<(), std::io::Error> {
            let _images = images;
            Command::new("/nonexistent/llm-wiki-mock-codex").spawn()?;
            Ok(())
        })();
        assert!(failed_spawn.is_err());
        assert!(!directory.exists());
        assert!(other.files[0].exists());
    }

    #[cfg(unix)]
    async fn spawn_non_exec_wrapper() -> (Child, u32) {
        let mut command = Command::new("/bin/sh");
        // The shell remains the wrapper and waits for a separate native-like
        // child. printf is a builtin; no exec optimization can replace it.
        command
            .arg("-c")
            .arg("sleep 30 & native=$!; printf '%s\\n' \"$native\"; wait \"$native\"")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = spawn_codex_child(&mut command).unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let native_id = line
            .trim()
            .parse::<u32>()
            .expect("wrapper reported native PID");
        assert_ne!(child.id().unwrap(), native_id);
        (child, native_id)
    }

    #[cfg(unix)]
    fn unix_pid_exists(process_id: u32) -> bool {
        unsafe extern "C" {
            #[link_name = "kill"]
            fn posix_kill(
                pid: std::os::raw::c_int,
                signal: std::os::raw::c_int,
            ) -> std::os::raw::c_int;
        }
        // SAFETY: test-only existence probe; sends no signal to any process.
        unsafe { posix_kill(i32::try_from(process_id).unwrap(), 0) == 0 }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wrapper_and_native_cancel_timeout_leave_concurrent_stream_running() {
        for mode in ["cancel", "timeout"] {
            let other_images = prepare_codex_images(vec![sample_png()]).unwrap();
            let other_directory = other_images.directory.clone().unwrap();
            let (mut other, other_native) = spawn_non_exec_wrapper().await;
            let other_pid = other.id().unwrap();
            let images = prepare_codex_images(vec![sample_png()]).unwrap();
            let directory = images.directory.clone().unwrap();
            let (mut child, native) = spawn_non_exec_wrapper().await;
            let wrapper = child.id().unwrap();
            assert_ne!(wrapper, other_pid);
            assert!(unix_pid_exists(wrapper) && unix_pid_exists(native));
            let (cancel, cancelled) = oneshot::channel();
            let timeout = if mode == "timeout" {
                Duration::from_millis(25)
            } else {
                Duration::from_secs(2)
            };
            if mode == "cancel" {
                cancel.send(()).unwrap();
            }
            let (code, timed_out, error) =
                finish_codex_child(&mut child, "caption", cancelled, timeout, images).await;

            // Collect observations first; stop/reap the independent wrapper
            // before asserting, so a regression cannot leave a live fixture.
            let stopped_wrapper = !unix_pid_exists(wrapper);
            let stopped_native = !unix_pid_exists(native);
            let removed_images = !directory.exists();
            let other_alive = unix_pid_exists(other_pid) && unix_pid_exists(other_native);
            let other_images_present = other_images.files[0].exists();
            let stop_other = stop_codex_process_tree(&mut other, other_pid).await;
            drop(other_images);
            assert!(
                stop_other.is_ok(),
                "concurrent fixture cleanup: {stop_other:?}"
            );
            assert!(
                stopped_wrapper && stopped_native,
                "{mode} left wrapper/native alive"
            );
            assert!(
                removed_images,
                "{mode} retained images after successful termination"
            );
            assert!(
                other_alive && other_images_present,
                "{mode} affected another stream"
            );
            assert!(!other_directory.exists());
            assert!(error.is_some());
            assert_eq!(timed_out, mode == "timeout");
            assert_eq!(code, if timed_out { None } else { Some(-1) });
        }
    }

    #[test]
    #[ignore = "exports argv and a live private image for an external CLI verifier; does not call a model"]
    fn export_live_image_cli_args() {
        // The verifier waits for the JSON file, invokes codex itself with this
        // argv and stdin in its chosen project, then creates the release file.
        // This test retains the image until release (or a 5-minute deadline).
        let home = PathBuf::from(std::env::var_os("WIKI_TEST_CODEX_HOME").expect("Codex home"));
        let dest =
            PathBuf::from(std::env::var_os("WIKI_TEST_CLI_ARGS_OUTPUT").expect("output path"));
        let release =
            PathBuf::from(std::env::var_os("WIKI_TEST_CLI_IMAGE_RELEASE").expect("release path"));
        assert!(home.is_absolute() && dest.is_absolute() && release.is_absolute());
        assert!(
            !dest.exists() && !release.exists(),
            "use fresh export paths"
        );
        let images = prepare_codex_images(vec![sample_png()]).unwrap();
        let mut args = build_codex_cli_args("gpt-6.1-terra", false).unwrap();
        args.extend(codex_mem_isolation_args(&home).unwrap());
        args.extend(
            codex_image_args(&images)
                .into_iter()
                .map(|arg| arg.into_string().expect("UTF-8 temp path")),
        );
        std::fs::write(&dest, serde_json::to_vec_pretty(&args).unwrap()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        while !release.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(images);
        assert!(
            release.exists(),
            "external image verifier did not release before deadline"
        );
    }

    #[test]
    fn append_capped_line_appends_newline_when_space_remains() {
        let mut out = String::new();
        append_capped_line(&mut out, "hello", 16);
        assert_eq!(out, "hello\n");
    }

    #[test]
    fn append_capped_line_never_exceeds_limit() {
        let mut out = String::new();
        append_capped_line(&mut out, "abcdef", 4);
        assert_eq!(out, "abcd");
        assert_eq!(out.len(), 4);
        append_capped_line(&mut out, "ignored", 4);
        assert_eq!(out, "abcd");
    }

    #[test]
    fn append_capped_line_preserves_utf8_boundaries() {
        let mut out = String::new();
        append_capped_line(&mut out, "é水x", 5);
        assert_eq!(out, "é水");
        assert_eq!(out.len(), 5);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn done_payload_uses_the_camel_case_keys_the_frontend_reads() {
        let payload = done_payload(None, true, 10, "boom", "");

        // These key names are one part of the contract with
        // codex-cli-transport.ts, alongside the event topic and the value
        // types. If `timedOut` drifts, the frontend stops recognising the
        // timeout: a run that had already emitted an agent message is then
        // reported as completed, and one that had not gets the generic
        // no-agent-message error instead of the real cause.
        assert_eq!(payload["code"], serde_json::Value::Null);
        assert_eq!(payload["timedOut"], true);
        assert_eq!(payload["timeoutMinutes"], 10);
        assert_eq!(payload["stderr"], "boom");
        assert_eq!(payload["stdout"], "");
    }

    #[test]
    fn done_payload_passes_through_a_real_exit_code_when_not_timed_out() {
        let payload = done_payload(Some(2), false, 10, "", "out");

        assert_eq!(payload["code"], 2);
        assert_eq!(payload["timedOut"], false);
    }

    #[test]
    fn codex_spawn_timeout_minutes_defaults_and_clamps() {
        assert_eq!(
            codex_spawn_timeout_minutes(None),
            DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES
        );
        assert_eq!(
            codex_spawn_timeout_minutes(Some(0)),
            MIN_CODEX_SPAWN_TIMEOUT_MINUTES
        );
        assert_eq!(codex_spawn_timeout_minutes(Some(42)), 42);
        assert_eq!(
            codex_spawn_timeout_minutes(Some(999)),
            MAX_CODEX_SPAWN_TIMEOUT_MINUTES
        );
    }

    #[test]
    fn codex_args_do_not_isolate_local_config_by_default() {
        let args = build_codex_cli_args("gpt-5", false).unwrap();

        assert!(args
            .windows(3)
            .any(|pair| pair[0] == "-a" && pair[1] == "never" && pair[2] == "exec"));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
        assert!(!args.contains(&"--ignore-user-config".to_string()));
        assert!(!args.contains(&"--ignore-rules".to_string()));
        assert!(args.windows(2).any(|pair| pair[0] == "-c" && pair[1] == "features.shell_tool=false"));
        assert!(args.windows(2).any(|pair| pair[0] == "--sandbox" && pair[1] == "read-only"));
    }

    #[test]
    fn codex_args_reject_broad_isolation_that_bypasses_safety() {
        assert!(build_codex_cli_args("gpt-6.1-terra", true)
            .unwrap_err()
            .contains("safety"));
    }

    #[test]
    fn mem_isolation_preserves_security_and_other_hooks() {
        let hooks = serde_json::json!({"hooks": {
            "PreToolUse": [{"hooks": [{"command": "python codex_security_pre_tool_hook.py"}]}],
            "Stop": [{"hooks": [{"command": "plannotator"}, {"command": "python /hooks/nowledge-mem-project-router.py --event stop"}]}],
            "SessionStart": [{"hooks": [{"command": "python /hooks/nowledge-mem-context.py"}]}]
        }});
        let args = mem_isolation_overrides(
            Path::new("/home/with space/.codex/hooks.json"),
            Some(&hooks),
        )
        .unwrap();
        let values: Vec<_> = args.chunks_exact(2).map(|x| x[1].as_str()).collect();
        assert_eq!(values.len(), 3);
        let hook_states = values
            .iter()
            .find(|v| v.starts_with("hooks.state={"))
            .unwrap();
        assert!(
            hook_states.contains("\"/home/with space/.codex/hooks.json:stop:0:1\"={enabled=false}")
        );
        assert!(hook_states
            .contains("\"/home/with space/.codex/hooks.json:session_start:0:0\"={enabled=false}"));
        assert!(!values
            .iter()
            .any(|v| v.contains("pre_tool_use") || v.contains(":stop:0:0")));
        assert!(!args
            .iter()
            .any(|v| v.contains("ignore-") || v.contains("features.hooks") || v.contains("trust")));
    }

    #[test]
    fn mem_isolation_rejects_combined_commands_and_malformed_hooks() {
        for command in [
            "python nowledge-mem-project-router.py; security-check",
            "security-check && python nowledge-mem-stop-save.py",
            "bash -c 'python nowledge-mem-stop-save.py'",
            "python3 -O /hooks/nowledge-mem-context.py",
            "python3 -W ignore /hooks/nowledge-mem-stop-save.py",
            "python3 -O -c 'runpy.run_path(\"nowledge-mem-project-router.py\")'",
        ] {
            let hooks = serde_json::json!({"hooks":{"Stop":[{"hooks":[{"command":command}]}]}});
            assert!(mem_isolation_overrides(Path::new("/tmp/hooks.json"), Some(&hooks)).is_err());
        }
        assert!(mem_isolation_overrides(
            Path::new("/tmp/hooks.json"),
            Some(&serde_json::json!({"hooks":[]}))
        )
        .is_err());
    }

    #[test]
    fn mem_hook_detection_uses_the_executed_script_not_other_arguments() {
        for command in [
            "python /hooks/security_audit.py --output /tmp/nowledge-mem-context.py.log",
            "echo nowledge-mem-project-router.py",
            "python /hooks/nowledge-mem-context.py.log",
        ] {
            assert!(!is_standalone_mem_hook(command).unwrap(), "{command}");
        }
        for command in [
            "\"/Python 3/bin/python3\" \"/hooks with spaces/nowledge-mem-project-router.py\" --event stop",
            "python3 -u /hooks/nowledge-mem-context.py",
        ] { assert!(is_standalone_mem_hook(command).unwrap(), "{command}"); }
    }

    #[test]
    fn mem_isolation_without_user_hooks_still_disables_mem_plugin_and_mcp() {
        let args = mem_isolation_overrides(Path::new("/tmp/hooks.json"), None).unwrap();
        assert_eq!(args.len(), 4);
        assert!(args.contains(&"mcp_servers.nowledge-mem.enabled=false".to_string()));
        assert!(args.iter().any(|v| v.starts_with("plugins={")
            && v.contains("\"nowledge-mem@nowledge-community\"={enabled=false}")));
    }

    #[test]
    #[ignore = "exports the actual launch arguments for an opt-in local integration check"]
    fn export_live_mem_isolation_args() {
        let home = PathBuf::from(std::env::var_os("WIKI_TEST_CODEX_HOME").expect("Codex home"));
        let dest = std::env::var_os("WIKI_TEST_CLI_ARGS_OUTPUT").expect("output path");
        let mut args = build_codex_cli_args("gpt-6.1-terra", false).unwrap();
        args.extend(codex_mem_isolation_args(&home).unwrap());
        std::fs::write(dest, serde_json::to_vec_pretty(&args).unwrap()).unwrap();
    }

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn codex_working_directory_requires_absolute_existing_project() {
        assert!(resolve_codex_working_directory(None)
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(resolve_codex_working_directory(Some("".to_string()))
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(resolve_codex_working_directory(Some("   ".to_string()))
            .await
            .unwrap_err()
            .contains("requires an active project"));
        assert!(
            resolve_codex_working_directory(Some("relative/project".to_string()))
                .await
                .unwrap_err()
                .contains("absolute")
        );

        let missing =
            std::env::temp_dir().join(format!("llm-wiki-codex-cli-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(
            resolve_codex_working_directory(Some(missing.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("does not exist or cannot be read")
        );

        let file_path =
            std::env::temp_dir().join(format!("llm-wiki-codex-cli-file-{}", std::process::id()));
        let _ = std::fs::remove_file(&file_path);
        std::fs::write(&file_path, "not a directory").expect("temp file");
        struct TestFile(PathBuf);
        impl Drop for TestFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _file_guard = TestFile(file_path.clone());
        assert!(
            resolve_codex_working_directory(Some(file_path.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("not a directory")
        );

        let dir =
            std::env::temp_dir().join(format!("llm-wiki-codex-cli-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir");
        let _guard = TestDir(dir.clone());
        assert!(
            resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("wiki/index.md")
        );

        let wiki_dir = dir.join("wiki");
        std::fs::create_dir_all(&wiki_dir).expect("wiki dir");
        let index_dir = wiki_dir.join("index.md");
        std::fs::create_dir_all(&index_dir).expect("index dir");
        assert!(
            resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
                .await
                .unwrap_err()
                .contains("wiki/index.md")
        );
        std::fs::remove_dir_all(&index_dir).expect("remove index dir");
        std::fs::write(wiki_dir.join("index.md"), "# Index\n").expect("index");
        let resolved = resolve_codex_working_directory(Some(dir.to_string_lossy().to_string()))
            .await
            .expect("valid project path");
        assert_eq!(resolved, dir.canonicalize().expect("canonical tempdir"));
    }
}
