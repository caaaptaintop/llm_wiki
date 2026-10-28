import { fileExists, listDirectory, readFile, readFileAsBase64 } from "@/commands/fs"
import { normalizePath } from "./path-utils"
import { sourceIdentityForPath, sourceSummarySlugFromIdentity } from "./source-identity"
import { checkIngestCache } from "./ingest-cache"
import { knowledgeHash, planKnowledgeUnits } from "./section-knowledge"
import { loadCaptionCache } from "./image-caption-pipeline"
import { getLanguagePromptName } from "./language-metadata"
import { getOutputLanguage } from "./output-language"
import { parseFrontmatter } from "./frontmatter"
import type { LlmConfig } from "@/stores/wiki-store"

export interface SourceProcessingStatus {
  title: string
  ingested: boolean | null
  chapters: Array<{ title: string; total: number; saved: number; pending: number; invalid: number }>
  images: { extracted: number; described: number; unreadable: number }
  notes: string[]
}

/** Read existing ingestion artifacts on demand. A saved checkpoint is progress,
 * not proof that the current Wiki page or every answer is correct. No model
 * calls, source parsing, checkpoint repair, or writes occur in this reader. */
export async function readSourceProcessingStatus(
  projectPath: string, sourcePath: string, config: LlmConfig,
): Promise<SourceProcessingStatus> {
  const root = normalizePath(projectPath), source = normalizePath(sourcePath)
  if (!source.startsWith(`${root}/raw/sources/`) || source.slice(root.length + 1).split("/").some(p => p === ".." || p === ".")) {
    throw new Error("来源不在当前项目的原始资料目录中")
  }
  const identity = sourceIdentityForPath(root, source)
  const fullIdentity = source.slice(root.length + 1)
  const slug = sourceSummarySlugFromIdentity(identity)
  const result: SourceProcessingStatus = {
    title: source.split("/").pop()!, ingested: null, chapters: [],
    images: { extracted: 0, described: 0, unreadable: 0 }, notes: [],
  }
  // Binary sources must not be re-parsed merely to inspect status.
  const isText = /\.(?:md|mdx|txt|org)$/i.test(source)
  const content = isText ? await readFile(source) : ""
  result.title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || result.title
  if (isText) result.ingested = (await checkIngestCache(root, identity, content)) !== null
  const summary = `${root}/wiki/sources/${slug}.md`
  if (await fileExists(summary)) {
    const page = parseFrontmatter(await readFile(summary))
    if (typeof page.frontmatter?.title === "string") result.title = page.frontmatter.title
  }
  if (fullIdentity.endsWith(".wiki-source/source.md")) {
    const units = planKnowledgeUnits(content, Math.max(1_000, Math.min(12_000, Math.floor(config.maxContextSize * 0.2))))
    const sourceHash = await knowledgeHash(content)
    const directory = `${root}/.llm-wiki/section-knowledge/${await knowledgeHash(fullIdentity)}/${sourceHash}`
    const configKey = JSON.stringify({ version: 1, schema: await readFile(`${root}/schema.md`), model: config.model, provider: config.provider })
    for (const unit of units) {
      let chapter = result.chapters.find(c => c.title === unit.chapter)
      if (!chapter) { chapter = { title: unit.chapter, total: 0, saved: 0, pending: 0, invalid: 0 }; result.chapters.push(chapter) }
      chapter.total++
      const key = await knowledgeHash(fullIdentity + sourceHash + configKey + JSON.stringify(unit))
      const cpPath = `${directory}/${key}.json`
      if (await fileExists(cpPath)) {
        try {
          const cp = JSON.parse(await readFile(cpPath))
          if (cp.version !== 1 || cp.key !== key || JSON.stringify(cp.unit) !== JSON.stringify(unit)
            || !Array.isArray(cp.audit?.issues) || cp.audit.issues.length || !Array.isArray(cp.extraction?.records)) throw new Error("invalid")
          chapter.saved++
        } catch { chapter.invalid++ }
      } else if (await fileExists(`${directory}/${key}-pending.json`)) {
        chapter.pending++
      }
    }
  }
  result.notes.push(result.chapters.length
    ? "章节数字是当前来源、模型和规则匹配的已保存文本检查点。继续时会重新核对页面及出处，人工改动不会被静默覆盖。前言、附录与纯图像不计入这些数字。"
    : "此来源沿用原版分析与生成流程，没有匹配的多章源包逐节检查点；这不表示来源无法提炼。")
  const media = `${root}/wiki/media/${slug}`
  if (await fileExists(media)) {
    const cache = await loadCaptionCache(root, getLanguagePromptName(getOutputLanguage(content)))
    const files = (await listDirectory(media)).filter(f => !f.is_dir && /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(f.name))
    result.images.extracted = files.length
    for (const file of files) {
      try {
        // Read only direct children of the source's existing media directory.
        if (normalizePath(file.path) !== `${media}/${file.name}` || /[/\\]/.test(file.name)) throw new Error("invalid media path")
        const data = await readFileAsBase64(file.path)
        const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("")
        if (cache.get(hash)?.trim()) result.images.described++
      } catch { result.images.unreadable++ }
    }
  }
  result.notes.push("图片数字仅统计这份来源已提取的图片及当前输出语言的描述缓存；未提取的图、描述准确性、知识覆盖与回答正确性仍需分别核验。")
  return result
}
