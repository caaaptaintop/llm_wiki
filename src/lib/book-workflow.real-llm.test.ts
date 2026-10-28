import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { streamBookCodex } from "@/test-helpers/book-codex"

vi.mock("@/commands/fs", () => ({ ...realFs,
  readFileAsBase64: async (file: string) => ({ base64: (await fs.readFile(file)).toString("base64"), mime_type: "text/plain" }),
  writeFileAtomic: realFs.writeFile,
}))
vi.mock("./llm-client", () => ({ streamChat: streamBookCodex }))
import { prepareBook, processBook, synthesizeBooks } from "./book-workflow"
import { useWikiStore } from "@/stores/wiki-store"

describe.skipIf(process.env.RUN_BOOK_WORKFLOW !== "1")("real external-book workflow", () => {
  it("processes two externally supplied books, verifies evidence, and creates a cross-book topic", async () => {
    const root = path.resolve(process.env.BOOK_VALIDATION_ROOT!)
    const input = path.resolve(process.env.BOOK_VALIDATION_INPUT!)
    const fixture = JSON.parse(await fs.readFile(path.join(input, "validation-input.json"), "utf8")) as {
      books: Array<{ file: string; expectedChapters: number }>; topic: string
    }
    expect(fixture.books).toHaveLength(2)
    expect(typeof fixture.topic).toBe("string")
    expect(fixture.topic.trim().length).toBeGreaterThan(0)
    await fs.mkdir(root, { recursive: true })
    const state = useWikiStore.getState()
    const config = { ...state.llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-sol", maxContextSize: 256_000 }
    useWikiStore.setState({ project: { id: "book-validation", name: "LLM Wiki Fork", path: root }, llmConfig: config })
    // Use complete Markdown produced by the upstream Rust EPUB extractor.
    // Externally prepared source-package import is checked separately in the desktop application.
    const started = Date.now()
    const outcomes = await Promise.allSettled(fixture.books.map(async ({ file, expectedChapters }) => {
      const prepared = await prepareBook(root, path.resolve(input, file))
      expect(Number.isInteger(expectedChapters) && expectedChapters > 0).toBe(true)
      expect(prepared.chapters.filter((c) => c.kind === "chapter")).toHaveLength(expectedChapters)
      return processBook(root, prepared.id, config, { onProgress: (book) => {
        const completed = book.chapters.filter((c) => c.status === "complete").length
        console.log(`[book-progress] ${file}: ${completed}/${book.chapters.length} ${book.status}`)
      } })
    }))
    const errors = outcomes.filter((result) => result.status === "rejected")
    if (errors.length) throw new Error(errors.map((result) => result.status === "rejected" ? String(result.reason) : "").join("\n"))
    const books = outcomes.map((result) => { if (result.status === "rejected") throw result.reason; return result.value })
    const topic = fixture.topic
    const topicPath = await synthesizeBooks(root, books.map((b) => b.id), topic, config)
    const report = { model: config.model, elapsedMs: Date.now() - started, books: books.map((book) => ({ id: book.id, title: book.title, status: book.status, chapters: book.chapters.filter((c) => c.kind === "chapter").length, units: book.chapters.length, evidence: book.chapters.reduce((n, c) => n + c.evidenceCount, 0), overviewPath: book.overviewPath })), topicPath, scope: "Real Codex completions; real disk I/O through a Node adapter. Full Markdown from upstream Rust EPUB extractor. Desktop UI checked separately." }
    await fs.writeFile(path.join(root, "validation-result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    expect(books.every((b) => b.status === "complete")).toBe(true)
    const output = await fs.readFile(path.join(root, topicPath), "utf8")
    for (const book of books) expect(output).toContain(book.id)
  }, 60 * 60_000)
})
