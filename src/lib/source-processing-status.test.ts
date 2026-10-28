import { afterEach, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => ({ ...realFs,
  readFileAsBase64: async (p: string) => ({ base64: (await fs.readFile(p)).toString("base64"), mimeType: "image/png" }),
}))
import { readSourceProcessingStatus } from "./source-processing-status"
import { knowledgeHash, planKnowledgeUnits } from "./section-knowledge"
import { saveIngestCache } from "./ingest-cache"
import { sourceSummarySlugFromIdentity } from "./source-identity"

const cleanups: Array<() => Promise<void>> = []
const previousLanguage = useWikiStore.getState().outputLanguage
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); useWikiStore.setState({ outputLanguage: previousLanguage }) })
const source = "raw/sources/book.wiki-source/source.md"
const content = "# 示例书\n## 第一章 进度\n按偏差调整计划。\n## 第二章 成本\n变更后重算工程量。\n"
const config = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-terra", maxContextSize: 524288 }

async function fixture() {
  const project = await createTempProject()
  cleanups.push(project.cleanup)
  const root = project.path
  await realFs.writeFile(`${root}/${source}`, content)
  await realFs.writeFile(`${root}/schema.md`, "schema")
  return root
}

it("distinguishes saved, pending and missing records from successful source ingestion", async () => {
  const root = await fixture()
  const units = planKnowledgeUnits(content), hash = await knowledgeHash(content)
  const dir = `${root}/.llm-wiki/section-knowledge/${await knowledgeHash(source)}/${hash}`
  const configKey = JSON.stringify({ version: 1, schema: "schema", model: config.model, provider: config.provider })
  const keys = await Promise.all(units.map(u => knowledgeHash(source + hash + configKey + JSON.stringify(u))))
  await realFs.writeFile(`${dir}/${keys[0]}.json`, JSON.stringify({ version: 1, key: keys[0], unit: units[0], audit: { issues: [] }, extraction: { records: [] } }))
  await realFs.writeFile(`${dir}/${keys[1]}-pending.json`, "{}")
  await saveIngestCache(root, "book.wiki-source/source.md", content, [])
  const status = await readSourceProcessingStatus(root, `${root}/${source}`, config)
  expect(status.ingested).toBe(true)
  expect(status.chapters.map(c => [c.saved, c.pending])).toEqual([[1, 0], [0, 1]])
  expect(status.notes.join(" ")).toContain("人工改动不会被静默覆盖")
  const changedModel = await readSourceProcessingStatus(root, `${root}/${source}`, { ...config, model: "other" })
  expect(changedModel.chapters.every(c => c.saved === 0)).toBe(true)
  await realFs.writeFile(`${dir}/${keys[0]}.json`, "not json")
  expect((await readSourceProcessingStatus(root, `${root}/${source}`, config)).chapters[0].invalid).toBe(1)
})

it("counts described images only from this source and the selected output language", async () => {
  const root = await fixture()
  const slug = sourceSummarySlugFromIdentity("book.wiki-source/source.md")
  const image = `${root}/wiki/media/${slug}/a.png`
  await realFs.writeFile(image, "image-bytes")
  const hash = await knowledgeHash("image-bytes")
  useWikiStore.setState({ outputLanguage: "Chinese" })
  const cachePath = `${root}/.llm-wiki/image-caption-cache.json`
  await realFs.writeFile(cachePath, JSON.stringify({ [hash]: { imageHash: hash, caption: "English caption", outputLanguage: "English", capturedAt: "2026-01-01" } }))
  expect((await readSourceProcessingStatus(root, `${root}/${source}`, config)).images).toEqual({ extracted: 1, described: 0, unreadable: 0 })
  await realFs.writeFile(cachePath, JSON.stringify({ [hash]: { imageHash: hash, caption: "中文描述", outputLanguage: "Chinese", capturedAt: "2026-01-01" } }))
  expect((await readSourceProcessingStatus(root, `${root}/${source}`, config)).images.described).toBe(1)
  expect(await fs.readFile(`${root}/${source}`, "utf8")).toBe(content)
})

it("does not claim chapter extraction is unavailable for ordinary short materials", async () => {
  const root = await fixture()
  await realFs.writeFile(`${root}/raw/sources/note.md`, "# 短文\n正文")
  const status = await readSourceProcessingStatus(root, `${root}/raw/sources/note.md`, config)
  expect(status.chapters).toEqual([])
  expect(status.notes.join(" ")).toContain("沿用原版分析与生成")
})

it("rejects paths outside the source directory", async () => {
  await expect(readSourceProcessingStatus("/project", "/project/raw/sources/../../secret", config)).rejects.toThrow("原始资料目录")
})
