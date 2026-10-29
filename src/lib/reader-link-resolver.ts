import { getFileName, isAbsolutePath, normalizePath } from "./path-utils"
import { resolveRelatedSlug, type ProjectPathIndex } from "./wiki-page-resolver"

export interface ReaderLinkTarget { path: string; anchor: string | null }

function decode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return /[\u0000-\u001f\u007f]/u.test(decoded) ? null : decoded
  } catch {
    return null
  }
}

function indexedFile(index: ProjectPathIndex, path: string, root: string): string | null {
  if (!path.startsWith(`${root}/`)) return null
  // byPath also contains directories. Only filesByName establishes a file.
  return index.filesByName.get(getFileName(path))
    ?.find((entry) => normalizePath(entry.path) === path)?.path ?? null
}

/** Resolve only indexed project files. Never turn a URL into a filesystem path. */
export function resolveReaderLink(
  index: ProjectPathIndex,
  href: string,
  filePath: string | undefined,
  projectPath: string,
): ReaderLinkTarget | null {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  if (!isAbsolutePath(root) || /[\u0000-\u001f\u007f]/u.test(root)
    || root.split("/").some((part) => part === "." || part === "..")) return null
  if (!href || href !== href.trim()) return null

  if (href.startsWith("#")) {
    // transformWikilinks encodes the whole target, including its inner '#'.
    const decoded = decode(href.slice(1))
    if (!decoded || /[:\\]/.test(decoded)) return null
    const split = decoded.indexOf("#")
    const slug = split < 0 ? decoded : decoded.slice(0, split)
    const anchor = split < 0 ? null : decoded.slice(split + 1) || null
    // Managed citations use [[raw/sources/...]], while ordinary wikilinks
    // remain Wiki-only. Require an exact indexed file under this project's
    // sources root; never guess basenames or normalize a traversal into it.
    if (slug.startsWith("raw/sources/")) {
      if (slug.split("/").some(part => !part || part === "." || part === "..")
        || /[?]|%(?:2e|2f|5c|3a)/i.test(slug)) return null
      const path = indexedFile(index, `${root}/${slug}`, `${root}/raw/sources`)
      return path ? { path, anchor } : null
    }
    const resolved = resolveRelatedSlug(index, slug, `${root}/wiki`)
    const path = resolved && indexedFile(index, normalizePath(resolved), `${root}/wiki`)
    return path ? { path, anchor } : null
  }

  if (!filePath) return null
  const current = normalizePath(filePath)
  if (!indexedFile(index, current, root)
    || current.split("/").some((part) => part === "." || part === "..")) return null
  const split = href.indexOf("#")
  const relative = decode(split < 0 ? href : href.slice(0, split))
  const anchor = split < 0 ? null : decode(href.slice(split + 1))
  if (split >= 0 && anchor === null) return null
  // Reject absolute/UNC/drive paths, schemes, queries, control characters,
  // backslashes and nested escape encodings before resolving any segments.
  if (!relative || relative.startsWith("/") || /[:\\?]/.test(relative)
    || /%(?:2e|2f|5c|3a)/i.test(relative)) return null
  // Older generated citations use project-root raw paths, even from a nested
  // Wiki page. Resolve only that explicit namespace and an indexed source file.
  if (relative.startsWith("raw/sources/")) {
    if (relative.split("/").some(part => !part || part === "." || part === "..")) return null
    const path = indexedFile(index, `${root}/${relative}`, `${root}/raw/sources`)
    return path ? { path, anchor: anchor || null } : null
  }
  const parts = current.slice(root.length + 1).split("/")
  parts.pop()
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      // Do not allow even a temporary climb outside the project boundary.
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  const path = indexedFile(index, `${root}/${parts.join("/")}`, root)
  return path ? { path, anchor: anchor || null } : null
}

/** Evidence headings are their literal IDs; no CSS selector interpolation. */
export function findReaderHeading<T extends { id: string; textContent: string | null }>(
  headings: Iterable<T>, anchor: string,
): T | null {
  for (const heading of headings) {
    if (heading.id === anchor || heading.textContent?.trim() === anchor) return heading
  }
  return null
}
