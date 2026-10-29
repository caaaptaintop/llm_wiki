import { createElement, type ReactElement, type MouseEvent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildProjectPathIndexFromTree } from "@/lib/wiki-page-resolver"

const context = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  effects: [] as (() => void)[],
  root: { querySelectorAll: vi.fn() },
  titles: {} as Record<string, string>,
  alert: vi.fn(),
  persistHooks: false,
  memoIndex: 0,
  refIndex: 0,
  memos: [] as { deps: unknown[]; value: unknown }[],
  refs: [] as { current: unknown }[],
}))
vi.mock("@/hooks/use-reference-titles", () => ({ useReferenceTitles: () => context.titles }))
vi.mock("@/stores/app-dialog-store", () => ({ useAppDialog: () => ({ alert: context.alert }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    if (!context.persistHooks) return factory()
    const index = context.memoIndex++
    const old = context.memos[index]
    if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return old.value
    const value = factory()
    context.memos[index] = { deps, value }
    return value
  },
  useRef: (initial: unknown) => {
    if (!context.persistHooks) return { current: initial === null ? context.root : initial }
    const index = context.refIndex++
    return context.refs[index] ??= { current: initial === null ? context.root : initial }
  },
  useEffect: (effect: () => void) => context.effects.push(effect),
}))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (selector: (state: typeof context.state) => unknown) => selector(context.state) }))
vi.mock("react-markdown", () => ({ default: () => null }))
vi.mock("@/components/mermaid-diagram", () => ({ MermaidDiagram: () => null, unwrapMermaidPre: () => null }))

import { WikiReader } from "./wiki-reader"
import { remarkHideSourceLocations } from "@/lib/remark-hide-source-locations"

const filePath = "/project/wiki/books/book-id/revision/book-id-chapter-1.md"
const evidence = "book-id-chapter-1-p1-e1"
const chapterPath = "/project/raw/books/book-id/revision/chapter-id.md"
const sourcePath = "/project/raw/books/book-id/source.epub"
type Anchor = ReactElement<{ onClick: (event: MouseEvent<HTMLAnchorElement>) => void }>

function render(body = "# Chapter") {
  context.effects = []
  return WikiReader({ body, filePath })
}
async function renderMarkdown(body: string, sourceOffset = 0) {
  const { default: Markdown } = await vi.importActual<typeof import("react-markdown")>("react-markdown")
  const preview = WikiReader({ body, sourceBody: body, sourceOffset, filePath }).props.children
  return renderToStaticMarkup(createElement(Markdown, preview.props))
}
function click(href: string) {
  const tree = render() as ReactElement<{ children: ReactElement<{ components: { a: (props: { href: string; children: string }) => Anchor } }> }>
  const link = tree.props.children.props.components.a({ href, children: "Read" })
  const preventDefault = vi.fn()
  link.props.onClick({ preventDefault } as unknown as MouseEvent<HTMLAnchorElement>)
  return preventDefault
}

beforeEach(() => {
  context.persistHooks = false
  context.memos = []
  context.refs = []
  context.titles = {}
  context.alert.mockReset()
  context.root.querySelectorAll.mockReturnValue([])
  context.state = {
    project: { id: "p", path: "/project" }, selectedFile: filePath, pendingScrollHeading: null,
    openPathInPreview: vi.fn(), setPendingScrollHeading: vi.fn(),
    projectPathIndex: buildProjectPathIndexFromTree([filePath, chapterPath, sourcePath]
      .map((path) => ({ name: path.split("/").pop()!, path, is_dir: false }))),
  }
})

describe("WikiReader navigation", () => {
  it("follows a source line citation after its paragraph renders", () => {
    context.state.pendingScrollHeading = { path: filePath, anchor: "L12" }
    const scrollIntoView = vi.fn()
    context.root.querySelectorAll.mockImplementation((selector: string) => selector === "[data-source-line-start]"
      ? [{ dataset: { sourceLineStart: "10", sourceLineEnd: "14" }, scrollIntoView }]
      : [])
    render("内容")
    context.effects.forEach(effect => effect())
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" })
    expect(context.state.setPendingScrollHeading).toHaveBeenCalledWith(null)
  })
  it("retains paragraph and image component types when navigation clears or reference titles arrive", () => {
    context.persistHooks = true
    let sourceOffset = 0
    const renderAgain = () => {
      context.memoIndex = 0
      context.refIndex = 0
      return WikiReader({ body: "![Chart](images/chart.jpg)", sourceBody: "![Chart](images/chart.jpg)", sourceOffset, filePath }).props.children.props.components
    }
    context.state.pendingScrollImageSrc = "images/chart.jpg"
    const first = renderAgain()
    context.state.pendingScrollImageSrc = null
    context.titles = { [chapterPath]: "New title" }
    sourceOffset = 60
    const next = renderAgain()
    expect(next.p).toBe(first.p)
    expect(next.img).toBe(first.img)
    expect(next.p({ node: { position: { start: { line: 1 }, end: { line: 1 } } }, children: "paragraph" }).props["data-source-start"]).toBe(60)
  })
  it.each(["设计", "施工策划", "现场实施", "成本与计量", "安全与进度", "竣工与运维"])("renders the Chinese label %s without requiring a space", async (label) => {
    expect(await renderMarkdown(`- **${label}：**关联模型。`)).toContain(`<strong>${label}：</strong>关联模型。`)
  })

  it("pairs adjacent Chinese emphasis correctly instead of bolding the text between labels", async () => {
    const html = await renderMarkdown("这是**“BIM”**技术，与**LOD**相邻。\n\n**施工：**关联**现场：**复核")
    expect(html).toContain("这是<strong>“BIM”</strong>技术，与<strong>LOD</strong>相邻。")
    expect(html).toContain("<strong>施工：</strong>关联<strong>现场：</strong>复核")
  })

  it.each([
    ["`**施工：**关联`", "**施工：**关联</code>"],
    ["```markdown\n**施工：**关联\n```", "**施工：**关联\n</code>"],
    ["    **施工：**关联", "**施工：**关联\n</code>"],
    ["\\**施工：**关联", "**施工：**关联"],
    ["&#42;&#42;施工：&#42;&#42;关联", "**施工：**关联"],
    ["**English:**next", "**English:**next"],
    ["**施工：未闭合", "**施工：未闭合"],
  ])("preserves literal Markdown and non-CJK rules: %s", async (source, expected) => {
    const html = await renderMarkdown(source)
    expect(html).toContain(expected)
    expect(html).not.toContain("<strong>")
  })

  it("keeps links, GFM tables, formulas, escaped HTML and user-added spacing intact", async () => {
    const html = await renderMarkdown("**设计：** 以构件集成。\n\n| 阶段 | 内容 |\n| --- | --- |\n| **施工：**关联 | [**现场：**复核](#bim) |\n\n**成本：**核对 &amp; 留痕。 $x^2$ `<script>`")
    expect(html).toContain("<strong>设计：</strong> 以构件集成。")
    expect(html).toContain("<strong>施工：</strong>关联")
    expect(html).toContain('href="#bim"')
    expect(html).toContain("<strong>现场：</strong>复核")
    expect(html).toContain("<strong>成本：</strong>核对 &amp; 留痕。")
    expect(html).toContain("katex")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it.each(["\n", "\r\n"])("preserves source selection offsets with %j line endings", async (newline) => {
    const body = ["**施工：**关联。", "", "**现场：**复核。"].join(newline)
    const html = await renderMarkdown(body, 17)
    expect(html).toContain('data-source-start="17"')
    expect(html).toContain(`data-source-start="${17 + body.indexOf("**现场")}"`)
    expect(html).toContain(`data-source-end="${17 + body.length}"`)
    expect(html).toContain("<strong>施工：</strong>")
    expect(html).toContain("<strong>现场：</strong>")
  })

  it("opens the original source from a displayed managed citation", () => {
    const source = "/project/raw/sources/指南/source.md"
    context.state.projectPathIndex = buildProjectPathIndexFromTree([filePath, source].map(path => ({ name: path.split("/").pop()!, path, is_dir: false })))
    expect(click(`#${encodeURIComponent("raw/sources/指南/source.md")}`)).toHaveBeenCalledOnce()
    expect(context.state.openPathInPreview).toHaveBeenCalledWith(source)
  })

  it("folds resolved source references but keeps aliased knowledge and entity links visible", async () => {
    const source = "/project/wiki/sources/research.md"
    const entity = "/project/wiki/entities/device.md"
    context.state.projectPathIndex = buildProjectPathIndexFromTree([filePath, source, entity].map(path => ({ name: path.split("/").pop()!, path, is_dir: false })))
    const html = await renderMarkdown("来源：[[sources/research]]。\n\n证据：[[sources/research|仿真耗时4.48分钟]]。\n\n来源：[[entities/device]]。")
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html.indexOf("仿真耗时4.48分钟")).toBeGreaterThan(html.indexOf("</details>"))
    expect(html.indexOf("#entities%2Fdevice")).toBeGreaterThan(html.indexOf("</details>"))
  })

  it("displays resolved page titles while preserving explicit aliases and original navigation", () => {
    const observer = "/project/wiki/characters/sample-observer.md"
    context.state.projectPathIndex = buildProjectPathIndexFromTree([filePath, observer].map((path) => ({ name: path.split("/").pop()!, path, is_dir: false })))
    context.titles = { [observer]: "Sample Observer" }
    const preview = render("[[characters/sample-observer]] and [[characters/sample-observer|示例观察员]]").props.children
    const href = "#characters%2Fsample-observer"
    const automatic = preview.props.components.a({ href, children: "characters/sample-observer" })
    expect(automatic.props.children).toBe("Sample Observer")
    automatic.props.onClick({ preventDefault: vi.fn() })
    expect(context.state.openPathInPreview).toHaveBeenCalledWith(observer)
    expect(preview.props.components.a({ href, children: "示例观察员" }).props.children).toBe("示例观察员")
  })

  it("opens the complete locator on demand rather than rendering it in the paragraph", () => {
    const preview = render().props.children
    const reference = preview.props.components.span({ node: { properties: { "data-reader-locator": "epub-spine:3/block:2" } }, children: "[1]" })
    expect(reference.type).toBe("button")
    expect(reference.props.children).toBe("[1]")
    reference.props.onClick()
    expect(context.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("epub-spine:3/block:2") }))
  })

  it("filters preview comments after parsing without replacing source text or selection offsets", () => {
    const body = "<!-- source-location: unknown -->\n\n# Chapter\n\nEvidence text."
    const preview = WikiReader({ body, sourceBody: body, sourceOffset: 80, filePath }).props.children
    expect(preview.props.remarkPlugins).toContain(remarkHideSourceLocations)
    expect(preview.props.children).toBe(body)
    const paragraph = preview.props.components.p({ node: { position: { start: { line: 5 }, end: { line: 5 } } }, children: "Evidence text." })
    expect(paragraph.props["data-source-start"]).toBe(80 + body.indexOf("Evidence text."))
    expect(paragraph.props["data-source-end"]).toBe(80 + body.length)
  })

  it("intercepts book Markdown links and opens indexed chapter text and original files in preview", () => {
    expect(click("../../../../raw/books/book-id/revision/chapter-id.md")).toHaveBeenCalledOnce()
    expect(context.state.openPathInPreview).toHaveBeenLastCalledWith(chapterPath)
    expect(click("../../../../raw/books/book-id/source.epub")).toHaveBeenCalledOnce()
    expect(context.state.openPathInPreview).toHaveBeenLastCalledWith(sourcePath)
  })

  it("prevents WebView fallback navigation for invalid local files and custom protocols", () => {
    for (const href of ["../../../../../outside.md", "/outside.md", "file:///outside.md", "tauri://file", "missing.md"]) {
      expect(click(href)).toHaveBeenCalledOnce()
    }
    expect(context.state.openPathInPreview).not.toHaveBeenCalled()
    expect(click("https://example.com/article")).not.toHaveBeenCalled()
  })

  it("passes the decoded evidence anchor into the atomic preview action", () => {
    click(`#${encodeURIComponent(`book-id-chapter-1#${evidence}`)}`)
    expect(context.state.openPathInPreview).toHaveBeenCalledWith(filePath, evidence)
  })

  it("waits for the target heading to render, scrolls once and consumes the pending request", () => {
    context.state.pendingScrollHeading = { path: filePath, anchor: evidence }
    render("")
    context.effects.forEach((effect) => effect())
    expect(context.state.setPendingScrollHeading).not.toHaveBeenCalled()
    const scrollIntoView = vi.fn()
    context.root.querySelectorAll.mockReturnValue([{ id: "", textContent: evidence, scrollIntoView }])
    render(`### ${evidence}`)
    context.effects.forEach((effect) => effect())
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" })
    expect(context.state.setPendingScrollHeading).toHaveBeenCalledWith(null)
  })

  it("never consumes a heading request belonging to another preview file", () => {
    context.state.pendingScrollHeading = { path: "/project/wiki/other.md", anchor: evidence }
    const scrollIntoView = vi.fn()
    context.root.querySelectorAll.mockReturnValue([{ id: "", textContent: evidence, scrollIntoView }])
    render()
    context.effects.forEach((effect) => effect())
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(context.state.setPendingScrollHeading).not.toHaveBeenCalled()
  })

  it("scrolls directly for a same-page literal heading link", () => {
    const scrollIntoView = vi.fn()
    context.root.querySelectorAll.mockReturnValue([{ id: "", textContent: evidence, scrollIntoView }])
    click(`#${evidence}`)
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(context.state.openPathInPreview).not.toHaveBeenCalled()
  })
})
