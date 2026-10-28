import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { buildProjectPathIndexFromTree } from "@/lib/wiki-page-resolver"

const context = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (selector: (s: typeof context.state) => unknown) => selector(context.state) }))
vi.mock("@/hooks/use-reference-titles", () => ({ useReferenceTitles: () => ({ "/p/raw/sources/a/source.md": "同名书", "/p/raw/sources/b/source.md": "同名书" }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
import { FrontmatterPanel } from "./frontmatter-panel"

describe("compact metadata", () => {
  it("deduplicates resolved paths, retains distinct same-title sources, and starts metadata closed", () => {
    context.state = { project: { path: "/p" }, openPathInPreview: vi.fn(), projectPathIndex: buildProjectPathIndexFromTree(
      ["/p/raw/sources/a/source.md", "/p/raw/sources/b/source.md"].map(path => ({ path, name: "source.md", is_dir: false }))) }
    const data = { title: "样页", type: "concept", author: "admin", sources: ["a/source.md", "raw/sources/a/source.md", "b/source.md"], tags: [], related: [] }
    const before = JSON.stringify(data)
    const html = renderToStaticMarkup(createElement(FrontmatterPanel, { data, titleInBody: true }))
    expect(html.match(/aria-label="Open 同名书/g)).toHaveLength(2)
    expect(html).toContain("<details")
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    expect(html).toContain("admin")
    expect(html).not.toContain("样页")
    expect(JSON.stringify(data)).toBe(before)
    expect(renderToStaticMarkup(createElement(FrontmatterPanel, { data }))).toContain("样页")
  })
})
