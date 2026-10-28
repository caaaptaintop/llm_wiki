import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred } from "@/test-helpers/deferred"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { saveIngestCache } from "./ingest-cache"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  ensure: vi.fn(), caption: vi.fn(), stream: vi.fn(), cas: vi.fn(), refresh: vi.fn(), mineru: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: mocks.write,
  readFileAsBase64: async (p: string) => ({ base64: (await fs.readFile(p)).toString("base64"), mimeType: "image/png" }),
  writeSourceImagesIfUnchanged: mocks.cas,
}))
vi.mock("./section-knowledge", () => ({ ensureSectionKnowledge: mocks.ensure }))
vi.mock("./vision-caption", () => ({ captionImage: mocks.caption }))
vi.mock("./llm-client", () => ({ streamChat: mocks.stream }))
vi.mock("./project-file-tree-refresh", () => ({ refreshProjectFileTree: mocks.refresh }))
vi.mock("./mineru", () => ({ parseWithMineruResult: mocks.mineru }))

import { autoIngest, type AutoIngestOptions } from "./ingest"

const config: LlmConfig = {
  provider: "openai", apiKey: "test", model: "test", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000,
}
let tmp: Awaited<ReturnType<typeof createTempProject>>
let source: string
let summary: string
const identity = "guide.wiki-source/source.md"
const content = "# Guide\n\nHuman-maintained BIM source.\n\n![](images/figure.png)\n\n图7-9 施工顺序流程\n"
const curated = "---\ntitle: Guide\ntype: source\n---\n\n# Guide\n\n用户整理正文，逐字保留。\n"
const run = (options: AutoIngestOptions = { mode: "images-only" }, signal?: AbortSignal) =>
  autoIngest(tmp.path, source, config, signal, undefined, undefined, options)

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.write.mockImplementation(realFs.writeFile)
  tmp = await createTempProject("images-only")
  source = `${tmp.path}/raw/sources/${identity}`
  summary = `wiki/sources/${sourceSummarySlugFromIdentity(identity)}.md`
  await writeFileRaw(source, content)
  await writeFileRaw(`${tmp.path}/raw/sources/guide.wiki-source/images/figure.png`, "test image bytes")
  await writeFileRaw(`${tmp.path}/${summary}`, curated)
  await writeFileRaw(`${tmp.path}/wiki/concepts/bim.md`, "手工整理的 BIM 页")
  await saveIngestCache(tmp.path, identity, content, [summary, "wiki/concepts/bim.md"])
  mocks.cas.mockImplementation(async (root: string, rel: string, expected: string, next: string) => {
    if (await fs.readFile(`${root}/${rel}`, "utf8") !== expected) throw new Error("Wiki 文件已变化，停止覆盖")
    await fs.writeFile(`${root}/${rel}`, next)
  })
  mocks.ensure.mockRejectedValue(new Error("逐节知识已被修改，保留现场并停止覆盖"))
  mocks.caption.mockResolvedValue("图中为施工流程。")
  mocks.refresh.mockResolvedValue(undefined)
  useActivityStore.setState({ items: [] })
  useWikiStore.setState(state => ({
    multimodalConfig: { ...state.multimodalConfig, enabled: true, useMainLlm: true },
    embeddingConfig: { ...state.embeddingConfig, enabled: false },
    sourceWatchConfig: { ...state.sourceWatchConfig, persistExtractedMarkdown: true },
    outputLanguage: "Chinese",
  }))
})
afterEach(async () => { await tmp.cleanup() })

describe("explicit images-only ingestion", () => {
  it.each(["missing", "changed", "missing-output"])("rejects %s cache without invoking models or text protection", async kind => {
    if (kind === "missing") await fs.unlink(`${tmp.path}/.llm-wiki/ingest-cache.json`)
    if (kind === "changed") await fs.writeFile(source, `${content}\nchanged`)
    if (kind === "missing-output") await fs.unlink(`${tmp.path}/wiki/concepts/bim.md`)
    await expect(run()).rejects.toMatchObject({ nonRetryable: true, message: expect.stringContaining("没有匹配的入库缓存") })
    expect(mocks.caption).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.cas).not.toHaveBeenCalled()
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })

  it("uses the original extraction/caption/cache/managed section only, preserving curated text and the ingest cache", async () => {
    const cacheBefore = await fs.readFile(`${tmp.path}/.llm-wiki/ingest-cache.json`, "utf8")
    const written = await run()
    expect(written).toEqual([summary])
    expect(mocks.caption).toHaveBeenCalledTimes(1)
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
    const result = await fs.readFile(`${tmp.path}/${summary}`, "utf8")
    expect(result.startsWith(curated)).toBe(true)
    expect(result).toContain("<!-- llm-wiki:embedded-images -->")
    expect(result).toContain("图7-9 施工顺序流程；图中为施工流程。")
    expect(result).toContain("图题出处：")
    expect(await fs.readFile(`${tmp.path}/wiki/concepts/bim.md`, "utf8")).toBe("手工整理的 BIM 页")
    expect(await fs.readFile(source, "utf8")).toBe(content)
    expect(await fs.readFile(`${tmp.path}/.llm-wiki/ingest-cache.json`, "utf8")).toBe(cacheBefore)
    expect(useActivityStore.getState().items[0]).toMatchObject({
      status: "done", filesWritten: [summary], detail: expect.stringContaining("正文未重写，文字覆盖未核验"),
    })
    await run()
    expect(mocks.caption).toHaveBeenCalledTimes(1) // original persistent caption cache reused
    expect((await fs.readFile(`${tmp.path}/${summary}`, "utf8")).split("## Embedded Images")).toHaveLength(2)
    expect(await fs.readFile(`${tmp.path}/${summary}`, "utf8")).toBe(result)
  })

  it("leaves the default cache-hit path subject to the existing text protection", async () => {
    await expect(run({})).rejects.toThrow("逐节知识已被修改")
    expect(mocks.ensure).toHaveBeenCalledOnce()
    expect(mocks.caption).toHaveBeenCalledOnce()
    expect(await fs.readFile(`${tmp.path}/wiki/concepts/bim.md`, "utf8")).toBe("手工整理的 BIM 页")
  })

  it("rejects disabled image processing instead of reporting success", async () => {
    useWikiStore.setState(state => ({ multimodalConfig: { ...state.multimodalConfig, enabled: false } }))
    await expect(run()).rejects.toMatchObject({ nonRetryable: true })
    expect(mocks.caption).not.toHaveBeenCalled()
    expect(mocks.cas).not.toHaveBeenCalled()
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })

  it.each(["caption", "extraction", "partial-extraction", "write", "cache-write"])("reports %s failure and never marks the task done", async kind => {
    if (kind === "caption") mocks.caption.mockRejectedValue(new Error("caption failed"))
    if (kind === "extraction") await fs.unlink(`${tmp.path}/raw/sources/guide.wiki-source/images/figure.png`)
    if (kind === "partial-extraction") {
      const partial = content + "\n![](images/missing.png)"
      await fs.writeFile(source, partial)
      await saveIngestCache(tmp.path, identity, partial, [summary, "wiki/concepts/bim.md"])
    }
    if (kind === "cache-write") mocks.write.mockImplementation(async (p: string, c: string) => {
      if (p.endsWith("image-caption-cache.json")) throw new Error("cache write failed")
      await realFs.writeFile(p, c)
    })
    if (kind === "write") mocks.cas.mockRejectedValue(new Error("Wiki 文件已变化，停止覆盖"))
    await expect(run()).rejects.toThrow()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(useActivityStore.getState().items[0]).toMatchObject({ status: "error", detail: expect.stringContaining("仅补充图片失败") })
    expect(await fs.readFile(`${tmp.path}/${summary}`, "utf8")).toBe(curated)
  })

  it("refuses an unmatched managed marker without consuming user text", async () => {
    const manual = curated + "\n<!-- llm-wiki:embedded-images -->\n手工内容\n"
    await fs.writeFile(`${tmp.path}/${summary}`, manual)
    await expect(run()).rejects.toThrow("受管图片区标记不完整")
    expect(mocks.cas).not.toHaveBeenCalled()
    expect(await fs.readFile(`${tmp.path}/${summary}`, "utf8")).toBe(manual)
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })

  it("preserves an edit arriving at the final compare-and-write boundary", async () => {
    const compareAndWrite = mocks.cas.getMockImplementation()!
    mocks.cas.mockImplementationOnce(async (root: string, rel: string, expected: string, next: string) => {
      await fs.writeFile(`${root}/${rel}`, curated + "\n新的手工整理\n")
      return compareAndWrite(root, rel, expected, next)
    })
    await expect(run()).rejects.toThrow("Wiki 文件已变化")
    expect(await fs.readFile(`${tmp.path}/${summary}`, "utf8")).toBe(curated + "\n新的手工整理\n")
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })

  it("honors the original ordered commit runner and rejects a source changed while waiting", async () => {
    let commitReached = false
    await expect(run({ mode: "images-only", runCommit: async operation => {
      commitReached = true
      await fs.writeFile(source, `${content}\nchanged while queued`)
      return operation()
    } })).rejects.toMatchObject({ nonRetryable: true })
    expect(commitReached).toBe(true)
    expect(mocks.caption).not.toHaveBeenCalled()
    expect(mocks.cas).not.toHaveBeenCalled()
  })

  it("does not publish the managed section after cancellation during captioning", async () => {
    const started = createDeferred<void>()
    const finish = createDeferred<string>()
    mocks.caption.mockImplementation(() => { started.resolve(); return finish.promise })
    const controller = new AbortController()
    const result = run({ mode: "images-only" }, controller.signal)
    const rejection = expect(result).rejects.toThrow()
    await started.promise
    controller.abort()
    finish.resolve("图中为施工流程。")
    await rejection
    expect(mocks.cas).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })
})
