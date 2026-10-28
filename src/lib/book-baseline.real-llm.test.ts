import { describe, it, vi, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { streamBookCodex } from "@/test-helpers/book-codex"

vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: realFs.writeFile }))
vi.mock("@/lib/llm-client", () => ({ streamChat: streamBookCodex }))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { getTemplate } from "./templates"

describe.skipIf(process.env.RUN_BOOK_BASELINE !== "1")("unmodified upstream book baseline", () => {
  it("ingests a complete public book with the real model and records the generated coverage", async () => {
    const root = path.resolve(process.env.BOOK_VALIDATION_ROOT!)
    const input = path.resolve(process.env.BOOK_VALIDATION_INPUT!)
    const expectedChapters = process.env.BOOK_VALIDATION_CHAPTERS ? Number(process.env.BOOK_VALIDATION_CHAPTERS) : null
    if (expectedChapters !== null) expect(Number.isInteger(expectedChapters) && expectedChapters > 0).toBe(true)
    await fs.mkdir(path.join(root, "raw/sources"), { recursive: true })
    await fs.mkdir(path.join(root, "wiki"), { recursive: true })
    const template = getTemplate("reading")
    await fs.writeFile(path.join(root, "schema.md"), template.schema)
    await fs.writeFile(path.join(root, "purpose.md"), "# 阅读目的\n理解全书各章的叙事、主题与证据。保留输入材料全部章节的笔记，重要结论给出原文出处。输出中文。")
    await fs.writeFile(path.join(root, "wiki/index.md"), "# Index\n")
    const source = path.join(root, "raw/sources/external-source.md")
    await fs.copyFile(input, source)
    const state = useWikiStore.getState()
    const config = { ...state.llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-sol", maxContextSize: 128_000 }
    useWikiStore.setState({ project: { id: "book-baseline", name: "Book baseline", path: root }, llmConfig: config, outputLanguage: "Chinese", multimodalConfig: { ...state.multimodalConfig, enabled: false }, embeddingConfig: { ...state.embeddingConfig, enabled: false } })
    const started = Date.now()
    const files = await autoIngest(root, source, config)
    const report = { upstream: "e08cfce65aad8b76b13546a081c1a8d4422b70c3", model: config.model, elapsedMs: Date.now() - started, sourceCharacters: (await fs.readFile(source, "utf8")).length, files, chapterFiles: files.filter((name) => name.startsWith("wiki/chapters/")), expectedChapters, scope: "Original autoIngest with real Codex completion and Node filesystem adapter; native EPUB extraction performed separately using upstream ebook.rs." }
    await fs.writeFile(path.join(root, "baseline-result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    expect(files.some((file) => file.startsWith("wiki/sources/"))).toBe(true)
  }, 30 * 60_000)
})
