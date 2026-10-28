import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"
import type { StreamCallbacks } from "./llm-client"
import type { ChatMessage } from "./llm-providers"

vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: vi.fn(realFs.writeFile),
  readFileAsBase64: async (p: string) => ({ base64: (await fs.readFile(p)).toString("base64"), mime_type: "text/plain" }),
}))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
import { streamChat } from "./llm-client"
import { writeFileAtomic } from "@/commands/fs"
import { buildBookStructure } from "./book-structure"
import { bookHash, prepareBook, processBook, listBooks, readBook, splitBookChapter, parseChapterAnalysis, renderSynthesis, synthesizeBooks, discoverBookTopics } from "./book-workflow"

const model = vi.mocked(streamChat)
let root: string, cleanup: () => Promise<void>
const config = { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 }
function respond(_config: unknown, messages: ChatMessage[], cb: StreamCallbacks) {
  const prompt = String(messages[1].content)
  if (prompt.includes("<source>")) {
    const source = prompt.split("<source>\n")[1].split("\n</source>")[0]
    cb.onToken(JSON.stringify({ summary: "测试摘要", claims: [{ claim: "测试论点", quote: source.trim().slice(0, 150), concepts: ["规则"] }], questions: [] }))
  } else {
    const evidence = JSON.parse(prompt.split("证据：\n")[1]) as { id: string }[]
    cb.onToken(JSON.stringify(prompt.includes("自动发现跨材料主题")
      ? { topics: [{ title: "规则的依据和解释边界", rationale: "比较不同材料对规则的论述，不把个人笔记视为原著事实。", evidenceIds: [evidence[0].id, evidence[evidence.length - 1].id] }] }
      : { sections: [{ heading: "综合", claims: [{ text: "测试综合", evidenceIds: evidence.map((item) => item.id) }] }] }))
  }
  cb.onDone()
  return Promise.resolve()
}
async function importText(text = "# Test book\n\n## Chapter I\n\nA long quotation about rules and their exceptions.\n\n## Chapter II\n\nAnother chapter explores who can decide the rules.\n", name = "book.md") {
  const source = `${root}/${name}`
  await fs.writeFile(source, text)
  return prepareBook(root, source)
}
beforeEach(async () => {
  ({ path: root, cleanup } = await createTempProject("book-workflow"))
  model.mockReset().mockImplementation(respond)
  vi.mocked(writeFileAtomic).mockReset().mockImplementation(realFs.writeFile)
})
afterEach(async () => { await cleanup() })

describe("book evidence pipeline", () => {
  it("imports the real Python exporter contract with image and block provenance", async () => {
    await fs.mkdir(`${root}/images`)
    await fs.writeFile(`${root}/images/a (1)%.jpg`, "test image")
    const quote = "A specific sentence in the original block."
    const markdown = `# Prepared\n\n<img src="images/a%20%281%29%25.jpg" alt="Cover">\n\n${quote}\n\nUnmapped ending.\n\\![](images/missing.png)\n`
    await fs.writeFile(`${root}/input.md`, markdown)
    await fs.writeFile(`${root}/structured.json`, JSON.stringify({ metadata: { file_suffix: "epub", document: { page_count_kind: "spine" } }, pages: [{ page_idx: 2, blocks: [{ type: "text", content: quote }] }] }))
    execFileSync("python3", [path.resolve("scripts/prepare-book-source.py"), "--markdown", `${root}/input.md`, "--structured-content", `${root}/structured.json`, "--original", `${root}/input.md`, "--output", `${root}/exported`])
    const book = await prepareBook(root, `${root}/exported/source.md`)
    expect(book.assets).toHaveLength(1)
    expect(book.preparation?.originalFilename).toBe("input.md")
    expect(await fs.readFile(`${root}/${book.parsedPath}`, "utf8")).toContain("![Cover](images/a%20%281%29%25.jpg)")
    expect(await readBook(root, book.id)).toEqual(book)
    expect(await listBooks(root)).toHaveLength(1)
    expect(book.assets![0].hash).toBe(await bookHash("test image"))
    model.mockImplementationOnce(async (_config, _messages, cb) => {
      cb.onToken(JSON.stringify({ summary: "Summary", claims: [{ claim: "Claim", quote }] })); cb.onDone()
    })
    await processBook(root, book.id, config)
    expect(await fs.readFile(`${root}/${book.chapters[0].notesPath}`, "utf8")).toContain("epub-spine:3/block:1")
  })
  it("requires externally prepared text and makes no model call for a binary input", async () => {
    await expect(prepareBook(root, `${root}/unparsed.pdf`)).rejects.toThrow("外部工具")
    expect(model).not.toHaveBeenCalled()
  })
  it("copies and verifies images with each source snapshot, including image-only revisions", async () => {
    await fs.mkdir(`${root}/images`)
    await fs.writeFile(`${root}/images/cover.jpg`, "first image")
    const book = await importText("# Illustrated book\n\n![cover](images/cover.jpg)\n\nA long statement in the book.\n")
    expect(book.assets).toHaveLength(1)
    for (const folder of [`raw/books/${book.id}`, book.parsedPath.replace(/\/source.md$/, "")]) expect(await fs.readFile(`${root}/${folder}/images/cover.jpg`, "utf8")).toBe("first image")
    await fs.writeFile(`${root}/images/cover.jpg`, "second image")
    const other = await prepareBook(root, `${root}/book.md`)
    expect(other.id).not.toBe(book.id)
    await fs.writeFile(`${root}/${book.parsedPath.replace(/\/source.md$/, "")}/images/cover.jpg`, "tampered")
    await expect(processBook(root, book.id, config)).rejects.toThrow("图片已变化")
    expect(model).not.toHaveBeenCalled()
  })
  it("preserves preparation metadata and rejects mismatched or changed manifests", async () => {
    const source = "# Prepared book\n\nAn existing source with provenance.\n"
    await fs.writeFile(`${root}/source.md`, source)
    const metadata = { version: 1, source: { filename: "source.md", sha256: await bookHash(source) }, images: [], original: { filename: "book.pdf", sha256: "a".repeat(64) }, warnings: ["One block was not matched."] }
    await fs.writeFile(`${root}/manifest.json`, JSON.stringify(metadata))
    const book = await prepareBook(root, `${root}/source.md`)
    expect(book.preparation?.originalFilename).toBe("book.pdf")
    expect(book.warnings).toContain("One block was not matched.")
    expect(JSON.parse(await fs.readFile(`${root}/${book.preparation!.path}`, "utf8"))).toEqual(metadata)
    await fs.appendFile(`${root}/${book.preparation!.path}`, " ")
    await expect(processBook(root, book.id, config)).rejects.toThrow("清单已变化")
    metadata.source.sha256 = "b".repeat(64)
    await fs.writeFile(`${root}/manifest.json`, JSON.stringify(metadata))
    await expect(prepareBook(root, `${root}/source.md`)).rejects.toThrow("清单不一致")
    expect(model).not.toHaveBeenCalled()
  })
  it("writes externally mapped block locations beside verified quotations", async () => {
    const quote = "A specific sentence with enough characters."
    const book = await importText(`# Book\n\n<!-- source-location: pdf-page:9/block:2 -->\n${quote}\n<!-- source-location: unknown -->\n`)
    model.mockImplementationOnce(async (_config, _messages, cb) => {
      cb.onToken(JSON.stringify({ summary: "Summary", claims: [{ claim: "Claim", quote }] })); cb.onDone()
    })
    await processBook(root, book.id, config)
    expect(await fs.readFile(`${root}/${book.chapters[0].notesPath}`, "utf8")).toContain("外部源位置：pdf-page:9/block:2")
    expect(book.warnings.some((warning) => warning.includes("未提供原件位置"))).toBe(false)
  })
  it("retains immutable originals and every character, deduplicates without model calls", async () => {
    const book = await importText()
    const again = await prepareBook(root, `${root}/book.md`)
    expect(again.id).toBe(book.id)
    expect(await listBooks(root)).toHaveLength(1)
    expect(model).not.toHaveBeenCalled()
    const source = await fs.readFile(`${root}/${book.parsedPath}`, "utf8")
    const chapterText = await Promise.all(book.chapters.map((c) => fs.readFile(`${root}/${c.textPath}`, "utf8")))
    expect(chapterText.join("")).toBe(source)
  })
  it("completes all units and overview, links index, and resumes without new model calls", async () => {
    const book = await importText()
    const finished = await processBook(root, book.id, config)
    expect(finished.status).toBe("complete")
    expect(finished.chapters.every((c) => c.status === "complete" && c.evidenceCount > 0)).toBe(true)
    expect(await fs.readFile(`${root}/wiki/index.md`, "utf8")).toContain(book.id)
    const calls = model.mock.calls.length
    await processBook(root, book.id, config)
    expect(model).toHaveBeenCalledTimes(calls)
  })
  it("rejects fabricated quotations and resumes only unfinished work", async () => {
    const book = await importText()
    model.mockImplementationOnce(respond).mockImplementationOnce(async (_c, _m, cb) => {
      cb.onToken(JSON.stringify({ summary: "bad", claims: [{ claim: "invented", quote: "This quotation is nowhere in this book" }] })); cb.onDone()
    })
    await expect(processBook(root, book.id, config)).rejects.toThrow("引文无法")
    const partial = await readBook(root, book.id)
    expect(partial.status).toBe("partial")
    expect(partial.chapters[0].status).toBe("complete")
    expect(partial.chapters[1].status).toBe("error")
    model.mockClear()
    await processBook(root, book.id, config)
    expect(model).toHaveBeenCalledTimes(book.chapters.length)
  })
  it("cancellation persists progress and leaves no completed overview", async () => {
    const book = await importText()
    const abort = new AbortController()
    await expect(processBook(root, book.id, config, { signal: abort.signal, onProgress: (progress) => {
      if (progress.chapters[0].status === "complete") abort.abort()
    } })).rejects.toThrow("取消")
    expect((await readBook(root, book.id)).status).toBe("partial")
    expect(await realFs.fileExists(`${root}/${book.overviewPath}`)).toBe(false)
  })
  it.each(["sourcePath", "parsedPath", "textPath"])("detects a modified %s before further model calls", async (field) => {
    const book = await importText()
    const relative = field === "textPath" ? book.chapters[0].textPath : book[field as "sourcePath" | "parsedPath"]
    await fs.appendFile(`${root}/${relative}`, "changed")
    await expect(processBook(root, book.id, config)).rejects.toThrow(/变化/)
    expect(model).not.toHaveBeenCalled()
  })
  it.each(["notesPath", "overviewPath"])("preserves manual edits to %s", async (field) => {
    const book = await importText()
    await processBook(root, book.id, config)
    const relative = field === "notesPath" ? book.chapters[0].notesPath : book.overviewPath
    await fs.appendFile(`${root}/${relative}`, "\nMy manual edit")
    await expect(processBook(root, book.id, config)).rejects.toThrow("手动修改")
    expect(await fs.readFile(`${root}/${relative}`, "utf8")).toContain("My manual edit")
  })
  it("rejects a forged manifest path without writing outside the namespace", async () => {
    const book = await importText()
    book.chapters[0].notesPath = "../outside.md"
    await fs.writeFile(`${root}/.llm-wiki/books/${book.id}.json`, JSON.stringify(book))
    await expect(processBook(root, book.id, config)).rejects.toThrow("路径不匹配")
    expect(model).not.toHaveBeenCalled()
  })
  it("synthesizes two books with verified evidence and preserves an existing topic", async () => {
    const first = await importText()
    const second = await importText("# Second book\n\n## Chapter I\n\nThis second book provides a conflicting view of rules.\n", "second.md")
    await processBook(root, first.id, config)
    await processBook(root, second.id, config)
    const output = await synthesizeBooks(root, [first.id, second.id], "规则与权力", config)
    const content = await fs.readFile(`${root}/${output}`, "utf8")
    expect(content).toContain(first.id); expect(content).toContain(second.id)
    const calls = model.mock.calls.length
    expect(await synthesizeBooks(root, [second.id, first.id], "规则与权力", config)).toBe(output)
    expect(model).toHaveBeenCalledTimes(calls)
  })
  it("discovers an evidence-backed topic across a book and a short note, without a manual topic or discovery writes", async () => {
    const book = await importText()
    const note = await importText("# 阅读短记\n\n这是一则个人解读：规则的制定权和解释权不必属于同一主体，短记本身不是原著结论。\n", "note.md")
    expect(note.chapters).toHaveLength(1)
    await processBook(root, book.id, config); await processBook(root, note.id, config)
    const before = await fs.readFile(`${root}/wiki/index.md`, "utf8")
    const topics = await discoverBookTopics(root, [book.id, note.id], config)
    expect(topics).toHaveLength(1)
    expect(topics[0].sourceIds).toEqual([book.id, note.id])
    expect(topics[0].evidenceIds).toHaveLength(2)
    expect(await fs.readFile(`${root}/wiki/index.md`, "utf8")).toBe(before)
    expect(await realFs.fileExists(`${root}/wiki/synthesis`)).toBe(false)
    const output = await synthesizeBooks(root, topics[0].sourceIds, topics[0].title, config)
    const markdown = await fs.readFile(`${root}/${output}`, "utf8")
    expect(markdown).toContain(book.sourcePath)
    expect(markdown).toContain(note.sourcePath)
    expect(markdown).toContain("基于 2 份材料")
  })
  it.each(["unknown", "single-source", "missing-topics"])("rejects %s discovery results", async (kind) => {
    const book = await importText()
    const note = await importText("# Note\n\nA short note with its own distinct interpretation of rules.\n", "note.md")
    await processBook(root, book.id, config); await processBook(root, note.id, config)
    model.mockImplementationOnce(async (_config, messages, cb) => {
      const evidence = JSON.parse(String(messages[1].content).split("证据：\n")[1]) as { id: string }[]
      const evidenceIds = kind === "unknown" ? [evidence[0].id, "fake"] : evidence.filter((e) => e.id.startsWith(book.id)).slice(0, 2).map((e) => e.id)
      cb.onToken(JSON.stringify(kind === "missing-topics" ? {} : { topics: [{ title: "T", rationale: "R", evidenceIds }] })); cb.onDone()
    })
    await expect(discoverBookTopics(root, [book.id, note.id], config)).rejects.toThrow(/候选主题|主题发现/)
    expect(await realFs.fileExists(`${root}/wiki/synthesis`)).toBe(false)
  })
  it("allows no reliable topic and derives only the relevant source subset", async () => {
    const book = await importText()
    const second = await importText("# Second\n\nA short unrelated article on an unrelated subject.\n", "second.md")
    const third = await importText("# Third\n\nA short discussion of rules and interpretation.\n", "third.md")
    for (const source of [book, second, third]) await processBook(root, source.id, config)
    const ids = [book.id, second.id, third.id]
    expect((await discoverBookTopics(root, ids, config))[0].sourceIds).toEqual([book.id, third.id])
    model.mockImplementationOnce(async (_c, _m, cb) => { cb.onToken('{"topics":[]}'); cb.onDone() })
    expect(await discoverBookTopics(root, ids, config)).toEqual([])
  })
  it("rejects stale discovery after notes change during the model call", async () => {
    const book = await importText()
    const note = await importText("# Note\n\nA short note interpreting the principles from a book.\n", "note.md")
    await processBook(root, book.id, config); await processBook(root, note.id, config)
    model.mockImplementationOnce(async (...args) => {
      await fs.appendFile(`${root}/${note.chapters[0].notesPath}`, "manual")
      await respond(...args.slice(0, 3) as Parameters<typeof respond>)
    })
    await expect(discoverBookTopics(root, [book.id, note.id], config)).rejects.toThrow("发现主题期间笔记变化")
  })
  it("does not call a model for cancelled or incomplete discovery", async () => {
    const book = await importText()
    const note = await importText("# Note\n\nA short note interpreting the principles from a book.\n", "note.md")
    const abort = new AbortController(); abort.abort()
    await expect(discoverBookTopics(root, [book.id, note.id], config, { signal: abort.signal })).rejects.toThrow("取消")
    await expect(discoverBookTopics(root, [book.id, note.id], config)).rejects.toThrow("尚未完成")
    expect(model).not.toHaveBeenCalled()
  })
  it("rejects discovery over budget instead of silently dropping a long or short source", async () => {
    const book = await importText()
    const note = await importText("# Note\n\nA short note interpreting the principles from a book.\n", "note.md")
    model.mockImplementationOnce(async (_c, messages, cb) => {
      const source = String(messages[1].content).split("<source>\n")[1].split("\n</source>")[0]
      cb.onToken(JSON.stringify({ summary: "S", claims: [{ claim: "A".repeat(10_000), quote: source.trim(), concepts: [] }] })); cb.onDone()
    })
    await processBook(root, book.id, config); await processBook(root, note.id, config)
    model.mockClear()
    await expect(discoverBookTopics(root, [book.id, note.id], { ...config, maxContextSize: 16_000 })).rejects.toThrow("未截断证据")
    expect(model).not.toHaveBeenCalled()
  })
  it.each(["delete", "edit"])("rejects %s of a cited note before synthesis", async (action) => {
    const first = await importText()
    const second = await importText("# Another book\n\n## Chapter I\n\nA distinctly different statement about rules.\n", "other.md")
    await processBook(root, first.id, config); await processBook(root, second.id, config)
    const target = `${root}/${first.chapters[0].notesPath}`
    if (action === "delete") await fs.unlink(target)
    else await fs.appendFile(target, "manual")
    model.mockClear()
    await expect(synthesizeBooks(root, [first.id, second.id], "rules", config)).rejects.toThrow("笔记缺失或已修改")
    expect(model).not.toHaveBeenCalled()
  })
  it("rechecks note targets after a long synthesis call", async () => {
    const first = await importText()
    const second = await importText("# Another book\n\n## Chapter I\n\nA distinctly different statement about rules.\n", "other.md")
    await processBook(root, first.id, config); await processBook(root, second.id, config)
    model.mockImplementationOnce(async (...args) => {
      await fs.unlink(`${root}/${first.chapters[0].notesPath}`)
      await respond(...args.slice(0, 3) as Parameters<typeof respond>)
    })
    await expect(synthesizeBooks(root, [first.id, second.id], "rules", config)).rejects.toThrow("生成期间")
    expect(await realFs.fileExists(`${root}/wiki/synthesis`)).toBe(false)
  })
  it("repairs an index-write failure without another model call or replacing edited content", async () => {
    const first = await importText()
    const second = await importText("# Another book\n\n## Chapter I\n\nA distinctly different statement about rules.\n", "other.md")
    await processBook(root, first.id, config); await processBook(root, second.id, config)
    let fail = true
    vi.mocked(writeFileAtomic).mockImplementation(async (file, content) => {
      if (fail && file.endsWith("/wiki/index.md")) { fail = false; throw new Error("disk write interrupted") }
      await realFs.writeFile(file, content)
    })
    await expect(synthesizeBooks(root, [first.id, second.id], "rules", config)).rejects.toThrow("interrupted")
    const calls = model.mock.calls.length
    const output = await synthesizeBooks(root, [first.id, second.id], "rules", config)
    expect(model).toHaveBeenCalledTimes(calls)
    expect(await fs.readFile(`${root}/wiki/index.md`, "utf8")).toContain(output.replace(/^wiki\//, "").replace(/\.md$/, ""))
    await fs.appendFile(`${root}/${output}`, "manual")
    await expect(synthesizeBooks(root, [first.id, second.id], "rules", config)).rejects.toThrow("主题页已被修改")
    expect(await fs.readFile(`${root}/${output}`, "utf8")).toContain("manual")
  })
  it("serializes duplicate processing requests without duplicate model work", async () => {
    const book = await importText()
    const output = await Promise.all([processBook(root, book.id, config), processBook(root, book.id, config)])
    expect(output.every((item) => item.status === "complete")).toBe(true)
    expect(model).toHaveBeenCalledTimes(book.chapters.length + 1)
  })
})

describe("structured model results", () => {
  it("splits without dropping the tail or splitting an emoji", () => {
    const source = ("A".repeat(999) + "😀\n\n").repeat(5)
    const parts = splitBookChapter(source, 1000)
    expect(parts.map((p) => p.text).join("")).toBe(source)
    expect(parts.every((p) => !/^[\uDC00-\uDFFF]/.test(p.text))).toBe(true)
  })
  it("locates a repeated quote within the current part with exact global offsets", () => {
    const quote = "A repeated quotation."
    const markdown = `${quote}\n\n${quote}`
    const chapter = buildBookStructure({ sourceId: "test", sourcePath: "test.md", sourceHash: "x", markdown }).chapters[0]
    const result = parseChapterAnalysis(JSON.stringify({ summary: "summary", claims: [{ claim: "claim", quote }] }), chapter, 1, { text: quote, start: quote.length + 2 })
    expect(result.evidence[0].charStart).toBe(quote.length + 2)
    expect(result.evidence[0].lineStart).toBe(3)
  })
  it("accepts surrounding CLI commentary but rejects ambiguous JSON answers", () => {
    const raw = JSON.stringify({ sections: [{ heading: "h", claims: [{ text: "t", evidenceIds: ["fake"] }] }] })
    expect(() => renderSynthesis(`Commentary\n${raw}\nHook notice`, [])).toThrow("不存在")
    expect(() => renderSynthesis(`${raw}\n${raw}`, [])).toThrow("一个明确")
  })
  it("hashes UTF-8 deterministically", async () => { expect(await bookHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") })
})
