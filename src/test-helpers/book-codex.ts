/** Opt-in book validation through the existing ChatGPT CLI login; no API keys. */
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { buildPrompt, parseCodexCliLine } from "@/lib/codex-cli-transport"
import type { ChatMessage } from "@/lib/llm-providers"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

let calls = 0
const runId = new Date().toISOString().replace(/[:.]/g, "-")
export async function streamBookCodex(config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal) {
  const call = ++calls
  const root = process.env.BOOK_VALIDATION_ROOT
  if (!root) throw new Error("BOOK_VALIDATION_ROOT is required for real model validation")
  if (signal?.aborted) throw new Error("Book validation cancelled")
  console.log(`[book-validation] real model call ${call} started (${config.model})`)
  const response = await new Promise<string>((resolve, reject) => {
    const child = spawn("codex", ["-a", "never", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--model", config.model, "-c", 'model_reasoning_effort="high"', "-"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    // CLI startup diagnostics can contain local configuration; never echo them.
    child.stderr.resume()
    child.stdout.on("data", (data) => { stdout += data.toString() })
    const stop = () => child.kill("SIGTERM")
    signal?.addEventListener("abort", stop, { once: true })
    const timer = setTimeout(stop, 10 * 60_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      if (signal?.aborted) return reject(new Error("Book validation cancelled"))
      if (code !== 0) return reject(new Error(`Codex completion exited with status ${code}`))
      const responses = stdout.split(/\r?\n/).flatMap((line) => {
        const text = parseCodexCliLine(line)
        return text ? [text] : []
      })
      if (!responses.length) return reject(new Error("Codex returned no completion"))
      // Match the upstream transport: retain every agent message. Stop-hook
      // bookkeeping notices must not replace the actual model answer.
      resolve(responses.join("\n\n"))
    })
    child.stdin.end(buildPrompt(messages))
  })
  await fs.mkdir(path.join(root, "validation-calls", runId), { recursive: true })
  await fs.writeFile(path.join(root, "validation-calls", runId, `call-${String(call).padStart(3, "0")}.md`), response)
  console.log(`[book-validation] real model call ${call} completed (${response.length} characters)`)
  callbacks.onToken(response)
  callbacks.onDone()
}
