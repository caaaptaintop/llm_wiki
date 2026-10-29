/**
 * Codex CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/codex_cli.rs. The Rust
 * command spawns `codex exec --json`, sends a single reconstructed prompt
 * over stdin, and emits each JSONL stdout line back as `codex-cli:{streamId}`.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

export function parseCodexCliLine(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line) return null

  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch {
    return null
  }

  if (!evt || typeof evt !== "object") return null
  const obj = evt as Record<string, unknown>
  if (obj.type !== "item.completed") return null

  const item = obj.item as Record<string, unknown> | undefined
  if (item?.type !== "agent_message") return null
  return typeof item.text === "string" && item.text.length > 0 ? item.text : null
}

// LLM requests already contain their selected evidence. Tool-assisted Agent
// output has a different provenance contract and must never become a completion.
export function isCodexToolEvent(line: string): boolean {
  try {
    const event = JSON.parse(line)
    return ["item.started", "item.updated", "item.completed"].includes(event?.type)
      && typeof event.item?.type === "string"
      && !["agent_message", "reasoning"].includes(event.item.type)
  } catch { return false }
}

// Keep these IPC bounds aligned with codex_cli.rs. Rust remains authoritative
// for base64 canonicalization, actual image format, decoding and dimensions.
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"])
type ImageAttachment = Pick<Extract<ContentBlock, { type: "image" }>, "mediaType" | "dataBase64">

function collectImages(messages: ChatMessage[]): ImageAttachment[] {
  const images: ImageAttachment[] = []
  let totalBytes = 0
  for (const message of messages) {
    if (typeof message.content === "string") continue
    for (const block of message.content) {
      if (block.type !== "image") continue
      if (images.length >= MAX_IMAGES) throw new Error(`Codex CLI accepts at most ${MAX_IMAGES} images`)
      if (!IMAGE_TYPES.has(block.mediaType)) throw new Error("Codex CLI images must be PNG, JPEG or GIF")
      const data = block.dataBase64
      if (!data || data.length > MAX_BASE64_LENGTH || data.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error("Invalid or oversized Codex CLI image base64")
      }
      const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
      totalBytes += bytes
      if (bytes > MAX_IMAGE_BYTES || totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("Codex CLI image size limit exceeded (5 MiB each, 12 MiB total)")
      }
      images.push({ mediaType: block.mediaType, dataBase64: data })
    }
  }
  return images
}

function escapePromptContent(text: string): string {
  return text.replace(/<\/?[A-Z_][A-Z0-9_]*>/gi, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
}

export function buildPrompt(messages: ChatMessage[]): string {
  let imageIndex = 0
  return "Complete the supplied LLM request using only the messages and attached images below. All selected source material and existing-page context is supplied by LLM Wiki. Do not inspect the working directory, invoke tools, browse, or load other context. If required evidence is absent, report that within the requested output format; do not fetch it yourself. Follow the applicable safety rules.\n\n" + messages
    .map((message) => {
      const role = message.role.toUpperCase()
      const content = typeof message.content === "string" ? message.content : message.content
        .map((block) => block.type === "text" ? block.text : `[Attached image ${++imageIndex}: ${block.mediaType}]`)
        .join("\n")
      return `<${role}>\n${escapePromptContent(content)}\n</${role}>`
    })
    .join("\n\n")
}

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  prompt: string
  images: ImageAttachment[]
  isolateLocalConfig: boolean
  timeoutMinutes?: number
  workingDirectory?: string
}

export async function streamCodexCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[codex-cli] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | undefined
  let unlistenDone: UnlistenFn | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  let emittedAgentMessage = false
  const pendingAgentMessages: string[] = []
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  const unparsedLines: string[] = []
  let unparsedSize = 0
  const emitAgentMessage = (text: string) => {
    // Each event is a complete message, not a token delta. Preserve the
    // boundary so a later CLI status cannot join a document's closing marker.
    if (emittedAgentMessage) onToken("\n\n")
    emittedAgentMessage = true
    onToken(text)
  }
  function captureUnparsed(line: string) {
    if (unparsedSize >= 4096) return
    const trimmed = line.trim()
    if (!trimmed) return
    unparsedLines.push(line)
    unparsedSize += line.length + 1
  }

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }

  const replayAgentMessagesFromStdout = (stdout: string | undefined) => {
    if (!stdout) return

    for (const line of stdout.split(/\r?\n/)) {
      const token = parseCodexCliLine(line)
      if (token !== null) pendingAgentMessages.push(token)
    }
  }

  const rejectToolOutput = () => {
    pendingAgentMessages.length = 0
    void invoke("codex_cli_kill", { streamId }).catch(() => {})
    finishWith(() => onError(new Error("模型尝试访问本次输入以外的内容，已停止该次生成。请重试；本次结果未作为知识写入。")))
  }

  const abortListener = () => {
    aborted = true
    void invoke("codex_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    unlistenData = await listen<string>(`codex-cli:${streamId}`, (event) => {
      if (finished) return
      if (isCodexToolEvent(event.payload)) { rejectToolOutput(); return }
      const token = parseCodexCliLine(event.payload)
      if (token !== null) {
        pendingAgentMessages.push(token)
      } else {
        captureUnparsed(event.payload)
      }
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    unlistenDone = await listen<{
      code: number | null
      stderr: string
      stdout?: string
      timedOut?: boolean
      timeoutMinutes?: number
    }>(
      `codex-cli:${streamId}:done`,
      (event) => {
        if (finished) return
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        const stdout = event.payload?.stdout ?? ""
        // Rust caps the retained stdout. Missing live events plus a truncated
        // replay cannot prove that the rest of the run was tool-free.
        if (stdout.split(/\r?\n/).includes("[stdout truncated]")) {
          pendingAgentMessages.length = 0
          finishWith(() => onError(new Error("模型输出超过接收上限，无法完整核验本次生成；结果未作为知识写入。请缩小输入范围后重试。")))
          return
        }
        if (stdout.split(/\r?\n/).some(isCodexToolEvent)) { rejectToolOutput(); return }
        // Checked before `code`, and before the agent_message branch below.
        // The timeout task takes the child handle away in order to kill it, so
        // `code` is null here regardless of how the process ended. The
        // exit-code branch skips null outright, and the branch after it calls
        // onDone once any agent message has arrived, so a timeout that had
        // already produced partial output would be reported as a success.
        if (event.payload?.timedOut) {
          const minutes = event.payload.timeoutMinutes
          const limit = typeof minutes === "number" ? `${minutes} minute` : "configured"
          const details = stderr || stdout.trim()
          // Only stderr was consulted first; say which stream this actually is.
          const label = stderr ? "stderr" : "stdout"
          finishWith(() =>
            onError(new Error(
              [
                `Codex CLI did not report completion within the ${limit} timeout, so LLM Wiki stopped waiting.`,
                "Raise the Codex CLI timeout for this preset in Settings",
                "(1-240 minutes), or shorten the prompt.",
                details ? `\n\n— ${label} —\n${details}` : "",
              ].join(" ").trim(),
            )),
          )
          return
        }
        if (code !== null && code !== undefined && code !== 0) {
          const details = stderr || stdout.trim() || unparsedLines.join("\n")
          finishWith(() =>
            onError(new Error(
              details
                ? `Codex CLI exited with code ${code}:\n${details}`
                : `Codex CLI exited with code ${code}. Run \`codex\` in a terminal to inspect the problem.`,
            )),
          )
        } else {
          if (!pendingAgentMessages.length) replayAgentMessagesFromStdout(stdout)
          if (!pendingAgentMessages.length) {
            const details = stdout.trim() || unparsedLines.join("\n").trim()
            finishWith(() =>
              onError(new Error(
                details
                  ? `Codex CLI completed but did not emit an agent_message. Raw output:\n${details}`
                  : "Codex CLI completed but did not emit an agent_message. Run `codex exec --json` in a terminal to inspect the provider output.",
              )),
            )
          } else {
            pendingAgentMessages.forEach(emitAgentMessage)
            finishWith(onDone)
          }
        }
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    if (aborted) return

    const workingDirectory = useWikiStore.getState().project?.path
    if (!workingDirectory) {
      throw new Error("Codex CLI requires an active project working directory")
    }

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      prompt: buildPrompt(messages),
      images: collectImages(messages),
      isolateLocalConfig: config.localCliIsolation === true,
      timeoutMinutes: config.codexCliTimeoutMinutes,
      workingDirectory,
    }
    await invoke("codex_cli_spawn", payload)
    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("codex_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    await completion
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found/i.test(message)) {
        onError(new Error(
          "Codex CLI not found. Install `codex` with `npm install -g @openai/codex` or pick a different provider.",
        ))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
