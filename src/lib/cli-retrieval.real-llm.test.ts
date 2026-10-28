/** Opt-in verification of the actual CLI planner/evidence builders on an isolated copy. */
import { it } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { buildPrompt, parseCodexCliLine } from "./codex-cli-transport"
import { appendRetrievalPlanContext, buildRetrievalPlanMessages, parseRetrievalPlan } from "./cli-retrieval-plan"
import { buildCliChatEvidence } from "./cli-chat-evidence"
import type { ChatMessage } from "./llm-client"

const out = process.env.WIKI_CLI_VALIDATION_OUTPUT
const copy = process.env.WIKI_VALIDATION_COPY

it.skipIf(!out || !copy)("validates retrieval plans or answers with the selected local CLI model", async () => {
  await fs.access(path.join(copy!, ".retrieval-validation-copy"))
  const model = process.env.WIKI_CLI_VALIDATION_MODEL ?? "gpt-6.1-terra"
  const action = process.env.WIKI_CLI_VALIDATION_ACTION ?? "plan"
  const questions = JSON.parse(await fs.readFile(path.join(out!, "questions.json"), "utf8")).questions
  const catalog = JSON.parse(await fs.readFile(path.join(out!, "source-catalog.json"), "utf8"))
  const selected = process.env.WIKI_CLI_VALIDATION_IDS?.split(",")
  const jobs = questions.filter((q: {id: string}) => !selected || selected.includes(q.id))
  const directory = path.join(out!, action)
  await fs.mkdir(directory, { recursive: true })
  async function complete(id: string, messages: ChatMessage[]) {
    if (process.env.WIKI_CLI_VALIDATION_REPARSE === "1") {
      const saved = JSON.parse(await fs.readFile(path.join(directory, `${id}-call.json`), "utf8"))
      if (saved.exitCode !== 0 || saved.itemTypes.some((type: string) => type !== "agent_message")) throw new Error("Previous call did not pass execution boundaries")
      return saved.text as string
    }
    const prompt = buildPrompt(messages)
    await fs.writeFile(path.join(directory, `${id}-prompt.txt`), prompt)
    const start = Date.now()
    const result = await new Promise<{stdout: string; exitCode: number|null}>((resolve, reject) => {
      const child = spawn("codex", ["-a", "never", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--model", model, "-c", 'model_reasoning_effort="high"', "-"], {cwd: copy, stdio:["pipe","pipe","pipe"]})
      let stdout = ""
      child.stderr.resume() // Never expose local configuration diagnostics.
      child.stdout.on("data", data => { stdout += data })
      const timer = setTimeout(() => child.kill("SIGTERM"), 600_000)
      child.on("error", error => { clearTimeout(timer); reject(error) })
      child.on("close", exitCode => { clearTimeout(timer); resolve({stdout, exitCode}) })
      child.stdin.end(prompt)
    })
    const responses: string[] = [], itemTypes: string[] = [], usage: unknown[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const token = parseCodexCliLine(line)
      if (token) responses.push(token)
      try {
        const event = JSON.parse(line)
        if (event.type === "item.completed") itemTypes.push(event.item?.type)
        if (event.type === "turn.completed") usage.push(event.usage)
      } catch { /* non-JSON diagnostics are not evidence */ }
    }
    const data = { id, requestedModel:model, requestedReasoning:"high", actualModelMetadata:"not exposed", elapsedSeconds:(Date.now()-start)/1000, exitCode:result.exitCode, responses, itemTypes, usage, text:responses.join("\n\n") }
    await fs.writeFile(path.join(directory, `${id}-call.json`), JSON.stringify(data,null,2))
    if (result.exitCode !== 0 || !responses.length) throw new Error(`CLI completion failed (${result.exitCode})`)
    if (itemTypes.some(type => type !== "agent_message")) throw new Error("CLI attempted an extra tool/action; inspect call metadata")
    return data.text
  }
  const runtime = action === "answer" ? JSON.parse(await fs.readFile(path.join(out!, "runtime/runtime.json"), "utf8")) : []
  let next = 0
  const failures: string[] = []
  async function worker() {
    while (next < jobs.length) {
      const q = jobs[next++]
      const dest = path.join(directory, `${q.id}.json`)
      let existing: { answers?: Record<string, unknown>; clarification?: string; error?: string } | undefined
      if (process.env.WIKI_CLI_VALIDATION_REPARSE !== "1") {
        try { existing = JSON.parse(await fs.readFile(dest, "utf8")) } catch { /* resume missing jobs */ }
        if (existing?.error) { failures.push(q.id); continue }
        if (existing && (action === "plan" || existing.clarification)) continue
      }
      try {
        if (action === "plan") {
          const input = {query:q.query, catalog, history:q.history, contextFiles:q.sourcePaths}
          const raw = await complete(q.id, buildRetrievalPlanMessages(input))
          const plan = parseRetrievalPlan(raw, input)
          await fs.writeFile(dest, JSON.stringify({id:q.id, input, plan},null,2))
        } else {
          const planned = JSON.parse(await fs.readFile(path.join(out!,"plan",`${q.id}.json`),"utf8"))
          if (planned.error) throw new Error("Retrieval planning did not pass")
          if (planned.plan.clarification) {
            await fs.writeFile(dest, JSON.stringify({id:q.id, clarification:planned.plan.clarification},null,2))
            continue
          }
          const row = runtime.find((r: {id:string}) => r.id === q.id)
          const modes = (process.env.WIKI_CLI_VALIDATION_MODES ?? "smart").split(",") as ("smart"|"faithful")[]
          const answers: Record<string, unknown> = { ...existing?.answers }
          for (const mode of modes) {
            if (answers[mode]) continue
            const result = row[mode]
            const evidence = buildCliChatEvidence(mode,q.query,result.message,result.references,planned.plan.scopeDescription)
            const context = appendRetrievalPlanContext(evidence.context, planned.plan, catalog)
            const text = mode === "faithful" && !evidence.hasEvidence ? "没有检索到匹配的原文片段，现有证据不足以回答这个问题。" : await complete(`${q.id}-${mode}`, [{role:"system",content:evidence.system},{role:"user",content:context}])
            answers[mode] = {text,context,system:evidence.system,references:result.references}
          }
          await fs.writeFile(dest,JSON.stringify({id:q.id,query:q.query,answers},null,2))
        }
        console.log(`${action} ${q.id}: completed`)
      } catch (error) {
        failures.push(q.id)
        await fs.writeFile(dest,JSON.stringify({...existing,id:q.id,error:error instanceof Error?error.message:String(error)},null,2))
        console.log(`${action} ${q.id}: failed (see result)`)
      }
    }
  }
  await Promise.all([worker(),worker()])
  if (failures.length) throw new Error(`Validation failed for: ${failures.join(", ")}; see per-question records`)
}, 3_600_000)
