import { useEffect, useState } from "react"
import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { useWikiStore } from "@/stores/wiki-store"

/** Read only referenced Markdown files, with the existing data-version refresh. */
export function useReferenceTitles(paths: readonly string[]): Readonly<Record<string, string>> {
  const version = useWikiStore((state) => state.dataVersion)
  const key = JSON.stringify([paths, version])
  const [loaded, setLoaded] = useState<{ key: string; titles: Record<string, string> }>({ key: "", titles: {} })
  useEffect(() => {
    let cancelled = false
    const unique = [...new Set(paths)].filter((path) => /\.md$/i.test(path))
    void Promise.all(unique.map(async (path) => {
      try {
        const { frontmatter, body } = parseFrontmatter(await readFile(path))
        const title = typeof frontmatter?.title === "string" ? frontmatter.title : body.match(/^#\s+(.+?)\s*$/m)?.[1]
        return [path, title?.trim() ?? ""] as const
      } catch { return [path, ""] as const }
    })).then((entries) => {
      if (!cancelled) setLoaded({ key, titles: Object.fromEntries(entries) })
    })
    return () => { cancelled = true }
  }, [key]) // paths are represented in the key; never apply a stale project's titles.
  return loaded.key === key ? loaded.titles : {}
}
