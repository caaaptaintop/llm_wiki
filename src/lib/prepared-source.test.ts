import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => ({ ...realFs,
  copyFileVerifiedAtomic: vi.fn(realFs.copyFile),
  writeFileAtomic: vi.fn(realFs.writeFile),
  readFileAsBase64: async (p: string) => ({ base64: (await fs.readFile(p)).toString("base64"), mimeType: "image/png" }),
}))
vi.mock("@/lib/ingest-queue", () => ({ enqueueBatch: vi.fn(async () => ["queued"]) }))
vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))
import { copyFileVerifiedAtomic, writeFileAtomic } from "@/commands/fs"
import { enqueueBatch } from "./ingest-queue"
import { importPreparedSource, validatePreparedSource } from "./prepared-source"
import { importSourceFiles, importSourceFolder, isIngestableSourcePath } from "./source-lifecycle"
import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizeSourceWatchConfig } from "./source-watch-config"

const digest = (s: string) => createHash("sha256").update(s).digest("hex")
const limit = 100 * 1024 * 1024
let root: string, cleanup: () => Promise<void>
const config = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-sol" }
const project = () => ({ id: "prepared", name: "Prepared", path: `${root}/project` })
async function fixture(folder = `${root}/external/book`) {
  const markdown = "# A prepared book\n\n![Cover](images/cover.png)\n\n## Chapter one\n\n<!-- source-location: pdf-page:7/block:1 -->\nA rule needs reasons.\n<!-- source-location: unknown -->\n"
  await fs.mkdir(`${folder}/images`, { recursive: true })
  await fs.writeFile(`${folder}/images/cover.png`, "image bytes")
  await fs.writeFile(`${folder}/source.md`, markdown)
  const metadata = { version: 1, source: { filename: "source.md", sha256: digest(markdown) }, original: { filename: "Book.pdf", sha256: "a".repeat(64) }, images: [{ path: "images/cover.png", sha256: digest("image bytes") }] }
  await fs.writeFile(`${folder}/manifest.json`, JSON.stringify(metadata))
  return { folder, source: `${folder}/source.md`, markdown, metadata }
}
beforeEach(async () => {
  ({ path: root, cleanup } = await createTempProject("prepared-source"))
  vi.clearAllMocks()
  vi.mocked(copyFileVerifiedAtomic).mockReset().mockImplementation(realFs.copyFile)
  vi.mocked(writeFileAtomic).mockReset().mockImplementation(realFs.writeFile)
  useWikiStore.setState({ project: project(), llmConfig: config, projectLlmOverride: undefined, taskModelRouting: { chatPresetId: null, ingestPresetId: null } })
})
afterEach(async () => { await cleanup() })

describe("prepared source adapter for upstream ingestion", () => {
  it("imports the exact text, manifest and images, then queues only the entry", async () => {
    const input = await fixture()
    const result = await importSourceFiles(project(), [input.source], config)
    expect(result.skipped).toEqual([])
    expect(result.imported).toHaveLength(1)
    const entry = result.imported[0]
    expect(entry).toMatch(/\/raw\/sources\/Book--[a-f0-9]{64}\.wiki-source\/source.md$/)
    expect(await fs.readFile(entry, "utf8")).toBe(input.markdown)
    expect(await fs.readFile(`${path.dirname(entry)}/manifest.json`, "utf8")).toBe(JSON.stringify(input.metadata))
    expect(await fs.readFile(`${path.dirname(entry)}/images/cover.png`, "utf8")).toBe("image bytes")
    expect(vi.mocked(writeFileAtomic).mock.calls.slice(-1)[0]?.[0]).toBe(entry)
    expect(enqueueBatch).toHaveBeenCalledWith("prepared", [{ sourcePath: entry, folderContext: expect.any(String) }])
    expect(isIngestableSourcePath(entry)).toBe(true)
    expect(isIngestableSourcePath(`${path.dirname(entry)}/manifest.json`)).toBe(false)
    expect(isIngestableSourcePath(`${path.dirname(entry)}/images/cover.png`)).toBe(false)
    expect(isIngestableSourcePath("/project/raw/sources/ordinary-image.png")).toBe(true)
  })
  it("supports selecting the bundle folder and imports the same identity again", async () => {
    const input = await fixture()
    const first = await importSourceFolder(project(), input.folder, config)
    const second = await importSourceFiles(project(), [input.source], config)
    expect(second.imported).toEqual(first.imported)
    expect(copyFileVerifiedAtomic).toHaveBeenCalledTimes(1)
  })
  it("imports a folder containing a book package and a short note into the same upstream queue", async () => {
    await fixture()
    await fs.writeFile(`${root}/external/note.md`, "# Short note\nA personal interpretation of rules.")
    const result = await importSourceFolder(project(), `${root}/external`, config)
    expect(result.skipped).toEqual([])
    expect(result.imported).toHaveLength(2)
    expect(result.imported.some((p) => p.endsWith("/note.md"))).toBe(true)
    expect(result.imported.some((p) => p.endsWith(".wiki-source/source.md"))).toBe(true)
    expect(enqueueBatch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueueBatch).mock.calls[0][1]).toHaveLength(2)
  })
  it("does not change ordinary file imports or infer a package without its manifest", async () => {
    await fs.mkdir(`${root}/external`)
    await fs.writeFile(`${root}/external/source.md`, "# An ordinary note")
    const result = await importSourceFiles(project(), [`${root}/external/source.md`], config)
    expect(result.imported).toEqual([`${project().path}/raw/sources/source.md`])
    expect(await importPreparedSource(project().path, `${root}/note.txt`, limit)).toBeNull()
  })
  it("rejects a corrupt package without copying or queueing any part", async () => {
    const input = await fixture()
    await fs.appendFile(input.source, "changed")
    const result = await importSourceFolder(project(), input.folder, config)
    expect(result.imported).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(copyFileVerifiedAtomic).not.toHaveBeenCalled()
    expect(enqueueBatch).not.toHaveBeenCalled()
  })
  it("preserves ordinary folder import when manifest.json belongs to another format", async () => {
    const input = await fixture()
    await fs.writeFile(`${input.folder}/manifest.json`, JSON.stringify({ name: "unrelated format" }))
    const result = await importSourceFolder(project(), input.folder, config)
    expect(result.imported.some((p) => p === `${project().path}/raw/sources/book/source.md`)).toBe(true)
    expect(result.imported.every((p) => !p.includes(".wiki-source/"))).toBe(true)
  })
  it.each(["file", "bundle", "parent"])("rejects explicitly named bundles missing the manifest through %s import", async (kind) => {
    const input = await fixture(`${root}/external/book.wiki-source`)
    await fs.unlink(`${input.folder}/manifest.json`)
    const result = kind === "file" ? await importSourceFiles(project(), [input.source], config)
      : await importSourceFolder(project(), kind === "bundle" ? input.folder : `${root}/external`, config)
    expect(result.imported).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(copyFileVerifiedAtomic).not.toHaveBeenCalled()
    expect(enqueueBatch).not.toHaveBeenCalled()
  })
  it.each(["bundle", "parent"])("does not treat a bundle missing source.md as independent image sources through %s import", async (kind) => {
    const input = await fixture(`${root}/external/book.wiki-source`)
    await fs.unlink(input.source)
    const result = await importSourceFolder(project(), kind === "bundle" ? input.folder : `${root}/external`, config)
    expect(result.imported).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(copyFileVerifiedAtomic).not.toHaveBeenCalled()
    expect(enqueueBatch).not.toHaveBeenCalled()
  })
  it("keeps an interrupted import unready and safely resumes without duplicate identities", async () => {
    const input = await fixture()
    vi.mocked(writeFileAtomic).mockImplementationOnce(realFs.writeFile).mockRejectedValueOnce(new Error("disk full"))
    await expect(importPreparedSource(project().path, input.source, limit)).rejects.toThrow("disk full")
    const roots = await fs.readdir(`${project().path}/raw/sources`)
    const dest = `${project().path}/raw/sources/${roots[0]}`
    await expect(fs.access(`${dest}/source.md`)).rejects.toThrow()
    expect(isIngestableSourcePath(`${dest}/images/cover.png`)).toBe(false)
    const result = await importPreparedSource(project().path, input.source, limit)
    expect(result).toBe(`${dest}/source.md`)
    expect(copyFileVerifiedAtomic).toHaveBeenCalledTimes(1)
  })
  it("serializes concurrent imports of the same package", async () => {
    const input = await fixture()
    const results = await Promise.all([importPreparedSource(project().path, input.source, limit), importPreparedSource(project().path, input.source, limit)])
    expect(results[0]).toBe(results[1])
    expect(copyFileVerifiedAtomic).toHaveBeenCalledTimes(1)
  })
  it("resumes after a failed atomic asset copy without exposing an entry", async () => {
    const input = await fixture()
    vi.mocked(copyFileVerifiedAtomic).mockRejectedValueOnce(new Error("copy interrupted"))
    await expect(importPreparedSource(project().path, input.source, limit)).rejects.toThrow("copy interrupted")
    const folders = await fs.readdir(`${project().path}/raw/sources`)
    await expect(fs.access(`${project().path}/raw/sources/${folders[0]}/source.md`)).rejects.toThrow()
    const entry = await importPreparedSource(project().path, input.source, limit)
    expect(entry).toBe(`${project().path}/raw/sources/${folders[0]}/source.md`)
    expect(await fs.readFile(entry!, "utf8")).toBe(input.markdown)
    expect(await fs.readdir(`${project().path}/raw/sources`)).toHaveLength(1)
  })
  it("rejects modified imported text before upstream cache or model use", async () => {
    const input = await fixture()
    const entry = (await importPreparedSource(project().path, input.source, limit))!
    await fs.appendFile(entry, "changed")
    await expect(autoIngest(project().path, entry, config)).rejects.toThrow("清单不一致")
    expect(streamChat).not.toHaveBeenCalled()
    await expect(importPreparedSource(project().path, input.source, limit)).rejects.toThrow("已保留原文件")
  })
  it("detects changed imported assets and never overwrites them", async () => {
    const input = await fixture()
    const entry = (await importPreparedSource(project().path, input.source, limit))!
    await fs.writeFile(`${path.dirname(entry)}/images/cover.png`, "edited image")
    await expect(validatePreparedSource(entry)).rejects.toThrow("清单不一致")
    await expect(importPreparedSource(project().path, input.source, limit)).rejects.toThrow("已保留原文件")
    expect(await fs.readFile(`${path.dirname(entry)}/images/cover.png`, "utf8")).toBe("edited image")
  })
  it("versions image-only and provenance-only changes", async () => {
    const input = await fixture()
    const first = await importPreparedSource(project().path, input.source, limit)
    await fs.writeFile(`${input.folder}/images/cover.png`, "new image")
    input.metadata.images[0].sha256 = digest("new image")
    await fs.writeFile(`${input.folder}/manifest.json`, JSON.stringify(input.metadata))
    const second = await importPreparedSource(project().path, input.source, limit)
    expect(second).not.toBe(first)
    input.metadata.original.filename = "New title.pdf"
    await fs.writeFile(`${input.folder}/manifest.json`, JSON.stringify(input.metadata))
    expect(await importPreparedSource(project().path, input.source, limit)).not.toBe(second)
  })
  it("rejects coherent in-place package revisions before the text-only upstream cache", async () => {
    const input = await fixture()
    const entry = (await importPreparedSource(project().path, input.source, limit))!
    await fs.writeFile(`${path.dirname(entry)}/images/cover.png`, "new image")
    input.metadata.images[0].sha256 = digest("new image")
    await fs.writeFile(`${path.dirname(entry)}/manifest.json`, JSON.stringify(input.metadata))
    await expect(autoIngest(project().path, entry, config)).rejects.toThrow("源包版本已变化")
    expect(streamChat).not.toHaveBeenCalled()
  })
  it("honors whole-package size limits and folder include filters", async () => {
    const input = await fixture()
    await expect(importPreparedSource(project().path, input.source, 10)).rejects.toThrow("大小限制")
    const result = await importSourceFolder(project(), input.folder, config, normalizeSourceWatchConfig({ includeExtensions: ["txt"] }))
    expect(result.imported).toEqual([])
    expect(result.skipped[0].reason).toBe("excluded")
  })
  it("rejects unsafe image paths before any copy", async () => {
    const input = await fixture()
    const content = input.markdown.replace("images/cover.png", "images/../../secret.png")
    input.metadata.source.sha256 = digest(content)
    await fs.writeFile(input.source, content)
    await fs.writeFile(`${input.folder}/manifest.json`, JSON.stringify(input.metadata))
    await expect(importPreparedSource(project().path, input.source, limit)).rejects.toThrow("相对路径")
    expect(copyFileVerifiedAtomic).not.toHaveBeenCalled()
  })
  it("rejects the whole bundle when an asset is explicitly excluded", async () => {
    const input = await fixture()
    const result = await importSourceFiles(project(), [input.source], config, normalizeSourceWatchConfig({ excludeExtensions: ["png"] }))
    expect(result.imported).toEqual([])
    expect(result.skipped[0].detail).toContain("排除规则")
    expect(copyFileVerifiedAtomic).not.toHaveBeenCalled()
    expect(enqueueBatch).not.toHaveBeenCalled()
  })
})
