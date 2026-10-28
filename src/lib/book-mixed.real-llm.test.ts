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
import { discoverBookTopics, prepareBook, processBook, readBook, synthesizeBooks } from "./book-workflow"
import { useWikiStore } from "@/stores/wiki-store"

describe.skipIf(process.env.RUN_BOOK_MIXED !== "1")("real mixed-source workflow", () => {
  it("discovers a topic without a supplied title and synthesizes a complete external book with a supplied short note", async () => {
    const root = path.resolve(process.env.BOOK_VALIDATION_ROOT!)
    const bookId = process.env.BOOK_VALIDATION_EXISTING_ID!
    const config = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-sol", maxContextSize: 256_000 }
    useWikiStore.setState({ project: { id: "mixed-validation", name: "混合材料验证", path: root }, llmConfig: config })
    const book = await readBook(root, bookId)
    expect(book.status).toBe("complete")
    for (const [name, content] of Object.entries({
      "schema.md": "# 材料 Wiki\n\n章节与短文笔记位于 wiki/books/，跨材料主题位于 wiki/synthesis/。保留引文与来源定位。\n",
      "purpose.md": "# 阅读目的\n\n用外部书籍和明确标注的短记验证主题发现与混合分析。\n",
    })) if (!await realFs.fileExists(path.join(root, name))) await fs.writeFile(path.join(root, name), content, { flag: "wx" })
    const input = path.resolve(process.env.BOOK_VALIDATION_NOTE!)
    const prepared = await prepareBook(root, input)
    const note = await processBook(root, prepared.id, config)
    expect(note.chapters).toHaveLength(1)
    const topics = await discoverBookTopics(root, [book.id, note.id], config)
    expect(topics.length).toBeGreaterThan(0)
    await fs.writeFile(path.join(root, "discovered-topics.json"), JSON.stringify(topics, null, 2))
    const topic = topics[0]
    expect(new Set(topic.sourceIds)).toEqual(new Set([book.id, note.id]))
    const topicPath = await synthesizeBooks(root, topic.sourceIds, topic.title, config)
    const markdown = await fs.readFile(path.join(root, topicPath), "utf8")
    expect(markdown).toContain(book.id)
    expect(markdown).toContain(note.id)
    const report = { author: "admin", model: config.model, sources: [{ id: book.id, title: book.title, units: book.chapters.length, reused: true }, { id: note.id, title: note.title, units: note.chapters.length, demonstration: true }], topics, topicPath, scope: "Real Codex completions; real disk via Node adapter. Reused a fully processed external book and added an externally supplied note. No manual topic supplied. Native UI checked separately." }
    await fs.writeFile(path.join(root, "validation-result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ topicCount: topics.length, topicPath, sources: report.sources }))
  }, 20 * 60_000)
})
