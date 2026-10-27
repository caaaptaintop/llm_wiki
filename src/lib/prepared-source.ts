import { copyFileVerifiedAtomic, createDirectory, fileExists, getFileSize, readFile, readFileAsBase64, writeFileAtomic } from "@/commands/fs"
import { bookImagePaths } from "./book-source"
import { normalizePath } from "./path-utils"
import { withProjectLock } from "./project-mutex"

const LIMIT = 100 * 1024 * 1024
const PACKAGE_DIR = /^.+--[a-f0-9]{64}\.wiki-source$/

/** Ordinary folders may also contain source.md and an unrelated manifest. */
export async function isPreparedSourceFile(path: string): Promise<boolean> {
  const source = normalizePath(path)
  if (!source.endsWith("/source.md")) return false
  const directory = source.slice(0, -"/source.md".length)
  if (directory.endsWith(".wiki-source")) return true
  if (!await fileExists(`${directory}/manifest.json`)) return false
  if (await getFileSize(`${directory}/manifest.json`) > 1024 * 1024) return false
  try {
    return JSON.parse(await readFile(`${directory}/manifest.json`))?.source?.filename === "source.md"
  } catch { return false }
}

/** A managed bundle has exactly one ingestable entry; assets are not sources. */
export function isPreparedSourceArtifact(path: string): boolean {
  const parts = normalizePath(path).split("/")
  const packageIndex = parts.findIndex((part) => PACKAGE_DIR.test(part))
  return packageIndex >= 0 && packageIndex < parts.length - 1 && parts.slice(packageIndex + 1).join("/") !== "source.md"
}

export async function validatePreparedSource(path: string): Promise<void> {
  const parts = normalizePath(path).split("/")
  const directory = parts.find((part) => PACKAGE_DIR.test(part))
  if (!directory) return
  if (isPreparedSourceArtifact(path)) throw new Error("只能入库源包的 source.md")
  const prepared = await readPreparedSource(path, LIMIT)
  if (!prepared) throw new Error("源包不完整，请重新导入完整源包")
  if (!directory.endsWith(`--${prepared.revision}.wiki-source`)) throw new Error("源包版本已变化，请重新导出并导入，不能覆盖原来源版本")
}

async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function fileHash(path: string): Promise<string> {
  if (await getFileSize(path) > LIMIT) throw new Error("源包文件超过 100 MB")
  const { base64 } = await readFileAsBase64(path)
  return hash(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)))
}

/**
 * Adapt an external source package to the upstream raw/sources queue.
 * Validate before writing and publish source.md last, atomically: watcher
 * events for partially copied assets must never start ingestion.
 */
async function readPreparedSource(sourcePath: string, maxBytes: number, isAllowed: (path: string) => boolean = () => true) {
  const source = normalizePath(sourcePath)
  if (!await isPreparedSourceFile(source)) return null
  const sourceDir = source.slice(0, -"/source.md".length)
  if (!await fileExists(`${sourceDir}/manifest.json`)) throw new Error("源包缺少 manifest.json，请重新导出完整源包")
  if (!isAllowed(`${sourceDir}/manifest.json`)) throw new Error("源包清单被当前排除规则禁止导入")
  const limit = Math.min(LIMIT, maxBytes)
  const manifestSize = await getFileSize(`${sourceDir}/manifest.json`)
  let size = manifestSize + await getFileSize(source)
  if (manifestSize > 1024 * 1024 || size > limit) throw new Error("源文件包超过大小限制")
  const manifest = await readFile(`${sourceDir}/manifest.json`)
  const metadata = JSON.parse(manifest)
  const markdown = await readFile(source)
  if (!markdown.trim()) throw new Error("源文件没有正文")
  if (metadata.version !== 1 || metadata.source?.filename !== "source.md" || metadata.source?.sha256 !== await hash(markdown)
    || !Array.isArray(metadata.images)) throw new Error("源文件包内容与清单不一致，请重新导出")
  if (metadata.original && (typeof metadata.original.filename !== "string" || /[/\\\u0000-\u001f]/.test(metadata.original.filename)
    || !/^[a-f0-9]{64}$/.test(metadata.original.sha256))) throw new Error("原材料标识无效")
  const images = bookImagePaths(markdown)
  if (metadata.images.length !== images.length) throw new Error("源包图片与清单不一致")
  const assets: Array<{ path: string; sha256: string }> = []
  for (const path of images) {
    if (!isAllowed(`${sourceDir}/${path}`)) throw new Error("源包图片被当前排除规则禁止导入")
    const entry = metadata.images.find((image: { path?: string }) => image?.path === path)
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("源包图片清单无效")
    size += await getFileSize(`${sourceDir}/${path}`)
    if (size > limit) throw new Error("源文件与图片合计超过大小限制")
    if (await fileHash(`${sourceDir}/${path}`) !== entry.sha256) throw new Error("源包图片与清单不一致")
    assets.push({ path, sha256: entry.sha256 })
  }
  // The manifest covers the text and assets. Its digest also versions changes
  // to provenance and images when the source text itself is unchanged.
  const revision = await hash(manifest)
  const title = String(metadata.original?.filename ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? "prepared")
    .replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 50) || "prepared"
  return { sourceDir, markdown, manifest, assets, revision, title }
}

export async function importPreparedSource(projectPath: string, sourcePath: string, maxBytes: number, isAllowed?: (path: string) => boolean): Promise<string | null> {
  const prepared = await readPreparedSource(sourcePath, maxBytes, isAllowed)
  if (!prepared) return null
  const { sourceDir, markdown, manifest, assets, revision, title } = prepared
  const destination = `${normalizePath(projectPath).replace(/\/$/, "")}/raw/sources/${title}--${revision}.wiki-source`
  return withProjectLock(`prepared:${destination}`, async () => {
    const ready = await fileExists(`${destination}/source.md`)
    // Existing or interrupted imports are checked, never silently overwritten.
    for (const [name, expected] of [["source.md", markdown], ["manifest.json", manifest]]) {
      if (await fileExists(`${destination}/${name}`)) {
        if (await readFile(`${destination}/${name}`) !== expected) throw new Error("已导入源包被修改，已保留原文件")
      } else if (ready) throw new Error("已导入源包缺少文件，请恢复完整源包")
    }
    for (const asset of assets) {
      const target = `${destination}/${asset.path}`
      if (await fileExists(target)) {
        if (await fileHash(target) !== asset.sha256) throw new Error("已导入源包图片被修改，已保留原文件")
      } else {
        if (ready) throw new Error("已导入源包缺少图片，请恢复完整源包")
        await createDirectory(target.slice(0, target.lastIndexOf("/")))
        await copyFileVerifiedAtomic(`${sourceDir}/${asset.path}`, target, asset.sha256)
        if (await fileHash(target) !== asset.sha256) throw new Error("复制期间源包图片发生变化，请重新导出")
      }
    }
    if (!ready) {
      await createDirectory(destination)
      await writeFileAtomic(`${destination}/manifest.json`, manifest)
      await writeFileAtomic(`${destination}/source.md`, markdown)
    }
    return `${destination}/source.md`
  })
}
