/**
 * Map a wiki-side image reference back to its raw source file.
 *
 * Image URLs we generate always live under
 *   `<project>/wiki/media/<slug>/img-N.<ext>`
 * — emitted either ABSOLUTE or WIKI-RELATIVE (`media/<slug>/img-N.png`).
 * The slug is the source-summary slug for the raw source identity. Root
 * sources keep their legacy basename stem slug; nested sources include their
 * `raw/sources` relative path plus a stable hash.
 *
 * Used in two places that want to "open the original document
 * around this image" rather than its LLM summary:
 *   - search-view's lightbox "Jump to source document" button
 *   - chat references panel's image badge (Phase 4 multimodal UI)
 *
 * Returns null when:
 *   - the URL doesn't match the expected media-directory shape, OR
 *   - no file with that stem exists under raw/sources/ (e.g. the
 *     user moved / deleted the original after ingest, leaving only
 *     the wiki summary). Callers fall back gracefully.
 */
import { listDirectory, readFile, readFileAsBase64 } from "@/commands/fs"
import {
  sourceIdentityForPath,
  sourceSummarySlugCandidatesFromIdentity,
} from "@/lib/source-identity"
import type { FileNode } from "@/types/wiki"
import { filterRawSourceTree } from "@/lib/source-filter"
import { findLocalMarkdownImageRefs, type SourceImageFigureCaption } from "@/lib/extract-source-images"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { isPreparedSourceArtifact } from "@/lib/prepared-source"
import { sourceLocationsForRange } from "@/lib/book-source"

function mediaReference(imageUrl: string, projectPath: string) {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const url = normalizePath(imageUrl)
  const relative = url.startsWith(`${root}/wiki/`) ? url.slice(root.length + 6)
    : url.replace(/^(?:\.\/|\.\.\/|wiki\/)/, "")
  const match = /^media\/([^/]+)\/([^/]+)$/.exec(relative)
  if (!match) return null
  if (match[1] === "." || match[1] === ".." || /[\u0000-\u001f]/.test(match[1])) return null
  // Preserve legacy percent-encoded slugs. Decoding the filename alone
  // must never introduce a new path segment or an external read.
  let name: string
  try { name = decodeURIComponent(match[2]) } catch { return null }
  if (/[\\/\u0000-\u001f]/.test(name) || name === "." || name === "..") return null
  return { slug: match[1], name, absolute: `${root}/wiki/media/${match[1]}/${name}` }
}

export async function findRawSourceForImage(
  imageUrl: string,
  projectPath: string,
): Promise<string | null> {
  const media = mediaReference(imageUrl, projectPath)
  if (!media) return null
  const slug = media.slug
  const normalizedProjectPath = normalizePath(projectPath).replace(/\/+$/, "")

  let tree: FileNode[]
  try {
    tree = filterRawSourceTree(await listDirectory(`${normalizedProjectPath}/raw/sources`, true))
  } catch {
    return null
  }

  const exact: string[] = []
  const legacy: string[] = []
  const findByMediaSlug = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          findByMediaSlug(node.children)
        }
        continue
      }
      const identity = sourceIdentityForPath(normalizedProjectPath, node.path)
      if (isPreparedSourceArtifact(node.path)) continue
      if (sourceSummarySlugCandidatesFromIdentity(identity).includes(slug)) exact.push(node.path)

      // Backward compatibility for media folders created before nested source
      // identities were encoded into the slug.
      const stem = node.name.replace(/\.[^.]+$/, "")
      if (stem === slug) legacy.push(node.path)
    }
  }
  findByMediaSlug(tree)
  const matches = exact.length ? exact : legacy
  return matches.length === 1 ? matches[0] : null
}

export interface SourceMarkdownImageMatch {
  /** Source Markdown URL (not the copied wiki/media URL). */
  url: string
  /** Actual one-based source line containing this unique image reference. */
  line: number
  /** Only an immediately preceding marker, allowing blank lines. Never inferred. */
  sourceLocation: string | null
  /** Only a uniquely adjacent explicit figure caption, after byte verification. */
  figureCaption?: SourceImageFigureCaption
}

const SOURCE_LOCATION_LINE = /^<!-- source-location: ((?:pdf-page|epub-spine):[1-9]\d*\/block:[1-9]\d*|unknown) -->\s*$/
// Require a numbered, standalone title, not a mention such as “见图 7-9”.
const FIGURE_CAPTION_LINE = /^ {0,3}(?:图\s*|(?:Figure|Fig\.?)\s+)(\d+(?:[.．\-–—]\d+)*)(\s*[:：]\s*|\.\s+|\s+)\S.*$/i

function adjacentFigureCaption(
  lines: string[], imageIndex: number, imageLines: Set<number>, captionLines: Set<number>,
): SourceImageFigureCaption | undefined {
  // Only blank lines and exact provenance comments may be crossed.
  const adjacent = (index: number, direction: number): number => {
    index += direction
    while (index >= 0 && index < lines.length
      && (!lines[index].trim() || SOURCE_LOCATION_LINE.test(lines[index]))) index += direction
    return index
  }
  let candidates = [-1, 1].map((direction) => ({ direction, index: adjacent(imageIndex, direction) }))
    .filter(({ index }) => captionLines.has(index))
  if (candidates.length === 2) {
    // A prose reference such as "Figure 2 depicts ..." can flank the image
    // opposite "Figure 2: Title". Prefer that explicit title only when both
    // refer to the same number; conflicting or equally explicit titles stay ambiguous.
    const labels = candidates.map(({ index }) => FIGURE_CAPTION_LINE.exec(lines[index])!)
    const delimited = candidates.filter((_, i) => /[:：.]/.test(labels[i][2]))
    if (labels[0][1] === labels[1][1] && delimited.length === 1) candidates = delimited
  }
  if (candidates.length !== 1) return undefined
  const { direction, index } = candidates[0]
  const otherSide = adjacent(index, direction)
  // A title between two images (or beside another title) has ambiguous
  // ownership. Do not assign the following image's title to this image.
  if (imageLines.has(otherSide) || captionLines.has(otherSide)) return undefined
  let previous = index - 1
  while (previous >= 0 && !lines[previous].trim()) previous--
  const marker = previous >= 0 ? SOURCE_LOCATION_LINE.exec(lines[previous]) : null
  return { text: lines[index], line: index + 1, sourceLocation: marker?.[1] ?? null }
}

function localImagePath(root: string, sourcePath: string, url: string): string | null {
  const path = isAbsolutePath(url) ? normalizePath(url)
    : `${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/${normalizePath(url)}`
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== ".") parts.push(part)
  }
  const absolute = parts.join("/")
  return absolute.startsWith(`${root}/`) ? absolute : null
}

async function imageHash(path: string): Promise<string> {
  const { base64 } = await readFileAsBase64(path)
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Reverse the Markdown extractor's numbered-name copy using matching bytes,
 * not a basename guess or an index (failed imports can shift the index).
 * Shared with provenance consumers; never parses binary sources, writes,
 * extracts images or calls a model. Ambiguous occurrences stay unresolved.
 */
export async function resolveSourceMarkdownImage(
  projectPath: string,
  sourcePath: string,
  markdown: string,
  imageUrl: string,
): Promise<SourceMarkdownImageMatch | null> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const source = normalizePath(sourcePath)
  const media = mediaReference(imageUrl, root)
  if (!media || !source.startsWith(`${root}/raw/sources/`)
    || source.split("/").some((part) => part === "." || part === "..")
    || !sourceSummarySlugCandidatesFromIdentity(sourceIdentityForPath(root, source)).includes(media.slug)) return null
  const copiedName = /^\d{3,}-(.+)$/.exec(media.name)?.[1]
  if (!copiedName) return null
  const lines = markdown.split(/\r?\n/)
  const lineStarts = [0, ...Array.from(markdown.matchAll(/\n/g), (match) => match.index! + 1)]
  const candidates: SourceMarkdownImageMatch[] = []
  const imageLines = new Set<number>()
  const standaloneImageLines = new Set<number>()
  const captionLines = new Set<number>()
  let fence = ""
  for (let index = 0; index < lines.length; index++) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(lines[index])
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (fence[0] === delimiter[1][0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
      continue
    }
    if (fence || /^( {4}|\t)/.test(lines[index])) continue
    // Ignore inline code and escaped image examples, which do not render.
    const visible = lines[index].replace(/(`+).*?\1/g, "").replace(/\\!\[/g, "[")
    if (/!\[|<img\b/i.test(visible)) imageLines.add(index)
    if (/^ {0,3}(?:!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/.test(lines[index])) standaloneImageLines.add(index)
    if (FIGURE_CAPTION_LINE.test(lines[index]) && !/[|]|!\[|<img\b/i.test(lines[index])
      && !/^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? "")) captionLines.add(index)
    for (const url of findLocalMarkdownImageRefs(visible)) {
      if (getFileName(url).replace(/[<>:"|?*\x00-\x1f]/g, "_") !== copiedName) continue
      let previous = index - 1
      while (previous >= 0 && !lines[previous].trim()) previous--
      const marker = previous >= 0 ? /^<!-- source-location: ((?:pdf-page|epub-spine):[1-9]\d*\/block:[1-9]\d*|unknown) -->\s*$/.exec(lines[previous]) : null
      const locations = marker ? sourceLocationsForRange(markdown, lineStarts[index], lineStarts[index] + lines[index].length) : []
      candidates.push({ url, line: index + 1, sourceLocation: locations.length === 1 ? locations[0] : marker?.[1] === "unknown" ? "unknown" : null })
    }
  }
  if (!candidates.length) return null
  try {
    const hash = await imageHash(media.absolute)
    const matches: SourceMarkdownImageMatch[] = []
    for (const candidate of candidates) {
      const path = localImagePath(root, source, candidate.url)
      if (!path) continue
      try { if (await imageHash(path) === hash) matches.push(candidate) } catch { /* Missing/changed images cannot establish a match. */ }
    }
    if (matches.length !== 1) return null
    const match = matches[0]
    const figureCaption = standaloneImageLines.has(match.line - 1)
      ? adjacentFigureCaption(lines, match.line - 1, imageLines, captionLines) : undefined
    return figureCaption ? { ...match, figureCaption } : match
  } catch { return null }
}

/** Resolve the source file and its exact Markdown scroll reference together. */
export async function findRawSourceImageTarget(imageUrl: string, projectPath: string): Promise<{ path: string; imageSrc: string | null } | null> {
  const path = await findRawSourceForImage(imageUrl, projectPath)
  if (!path) return null
  if (!/\.(?:md|mdx|txt|org)$/i.test(path)) return { path, imageSrc: imageUrlToAbsolute(imageUrl, projectPath) }
  const markdown = await readFile(path)
  const match = await resolveSourceMarkdownImage(projectPath, path, markdown, imageUrl)
  return { path, imageSrc: match?.url ?? null }
}

/**
 * Normalize a markdown image URL to the absolute-path form that
 * the unified Rust extractor emits in raw-source previews. Used
 * by jump-to-source code paths that want to set a `<img data-mdsrc>`
 * scroll target on the raw-source preview — the raw side renders
 * absolute URLs, so a wiki-relative URL we got from a wiki page's
 * safety-net section needs to be promoted to absolute first.
 *
 * Idempotent: passing an already-absolute URL returns it unchanged.
 */
export function imageUrlToAbsolute(
  imageUrl: string,
  projectPath: string,
): string {
  const media = mediaReference(imageUrl, projectPath)
  if (media) return media.absolute
  const isAbsolute =
    imageUrl.startsWith("/") ||
    /^[a-zA-Z]:/.test(imageUrl) ||
    imageUrl.startsWith("\\\\")
  if (isAbsolute) return imageUrl
  const cleaned = imageUrl.replace(/^\.\//, "")
  return `${projectPath.replace(/\/+$/, "")}/wiki/${cleaned}`
}
