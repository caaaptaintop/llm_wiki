//! Codex CLI subprocess transport.
//!
//! This mirrors the Claude Code CLI transport, but treats `codex` as a
//! local completion engine via `codex exec --json`. The webview can only
//! spawn this fixed command; it cannot execute arbitrary shell commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::cli_resolver::{
    child_path_env, cli_version_timeout_error, find_cli_command, CLI_VERSION_PROBE_TIMEOUT,
};

#[derive(Default)]
pub struct CodexCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
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
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to codex stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush codex stdin: {e}"))?;
    drop(stdin);

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let timeout_children = Arc::clone(&state.children);
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let timeout_stream_id = stream_id.clone();
    let timeout_minutes = codex_spawn_timeout_minutes(timeout_minutes);
    let timeout_duration = Duration::from_secs(timeout_minutes * 60);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let topic = format!("codex-cli:{stream_id}");
    let done_topic = format!("codex-cli:{stream_id}:done");

    tokio::spawn(async move {
        tokio::time::sleep(timeout_duration).await;
        if let Some(mut child) = timeout_children.lock().await.remove(&timeout_stream_id) {
            timeout_flag.store(true, Ordering::SeqCst);
            let _ = child.start_kill();
        }
    });

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[codex-cli stderr] {line}");
                append_capped_line(&mut collected, &line, STDERR_LIMIT_BYTES);
            }
            collected
        });

        let mut stdout_text = String::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    append_capped_line(&mut stdout_text, &line, STDOUT_LIMIT_BYTES);
                    if app.emit(&topic, line).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[codex-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };

        let mut stderr_text = stderr_task.await.unwrap_or_default();
        if stderr_text.len() >= STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }
        if stdout_text.len() >= STDOUT_LIMIT_BYTES {
            stdout_text.push_str("\n[stdout truncated]");
        }

        // A timeout is a separate fact from an exit code, and travels in its
        // own field: reporting it as exit code -1 made a deliberate stop look
        // like a CLI crash, and buried the real cause under whatever Codex
        // happened to write to stderr. Note that `exit_code` is None on the
        // timeout path because the timeout task took the child handle away in
        // order to kill it, not because a final status was observed, so
        // `timedOut` is the only dependable signal that the run was stopped.
        let _ = app.emit(
            &done_topic,
            done_payload(
                exit_code,
                timed_out.load(Ordering::SeqCst),
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
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
