import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { describe, expect, it } from "vitest"
import { remarkReaderLayout } from "./remark-reader-layout"
import { remarkHideSourceLocations } from "./remark-hide-source-locations"
import { remarkReaderReferences } from "./reader-presentation"

const key = "a".repeat(64)
const start = `<!-- section-knowledge:${key}:start -->`
const end = `<!-- section-knowledge:${key}:end -->`
const cite = "出处：[原文](#raw%2Fsources%2Fbook.md)，行 12–13；pdf-page:4/block:2。"
const unknown = "出处：[原文](#raw%2Fsources%2Fbook.md)，行 14–14；unknown。"
const meta = "类型：参数。来源章节：第八章 · 交付。"
function render(body: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [
    [remarkReaderLayout, { evidenceLabel: "出处与章节" }], remarkHideSourceLocations, remarkReaderReferences,
  ] }, body))
}

describe("reading layout preserves full evidence", () => {
  it("folds only evidence and record metadata; keeps all conditions, locators and links", () => {
    const body = `# 页\n\n## 已有小节\n\n${start}\n\n### 场景精度\n\n${meta}\n\n施工不低于LOD350或按合同；运维LOD400及以上。\n\n${cite}\n\n${unknown}\n\n${end}`
    const html = render(body)
    expect(html).toContain("<h2>场景精度</h2>")
    expect(html).toContain("<p>施工不低于LOD350或按合同；运维LOD400及以上。</p>\n<details")
    expect(html).toContain("<summary>出处与章节 · 2</summary>")
    expect(html).toContain(meta)
    expect(html).toContain('href="#raw%2Fsources%2Fbook.md"')
    expect(html).toContain('data-reader-locator="pdf-page:4/block:2"')
    expect(html).toContain("行 14–14；unknown。")
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    expect(html).not.toContain("section-knowledge")
    expect(body).toContain(cite)
    expect(body).toContain(start)
  })

  it("keeps each record's provenance with its own citations", () => {
    const html = render(`${start}\n\n### 第一项\n\n${meta}\n\n事实一。\n\n${cite}\n\n### 第二项\n\n类型：方法。来源章节：第二章。\n\n事实二。\n\n${unknown}\n\n${end}`)
    expect(html.match(/<details /g)).toHaveLength(2)
    const sections = html.split("<h2>第二项</h2>")
    expect(sections[0]).toContain(meta)
    expect(sections[0]).not.toContain("来源章节：第二章")
    expect(sections[1]).toContain("来源章节：第二章")
  })

  it("does not promote ordinary headings or hide prose and code resembling metadata", () => {
    const html = render(`## 常规\n\n### 子项\n\n类型：方法。来源章节：用户正文。\n\n出处：这段话还包含结论，必须可见。\n\n\`pdf-page:4/block:2\`\n\n\`\`\`text\n${cite}\n\`\`\``)
    expect(html).toContain("<h3>子项</h3>")
    expect(html).not.toContain("<details")
    expect(html).toContain("必须可见")
  })

  it("retains source offsets for displayed facts and folded provenance", () => {
    const body = `${start}\n\n### 参数\n\n${meta}\n\n保留事实。\n\n${cite}\n\n${end}`
    const positions: number[] = []
    renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [[remarkReaderLayout, { evidenceLabel: "出处" }], remarkHideSourceLocations],
      components: { p: ({ node, children }) => { positions.push(node?.position?.start.offset ?? -1); return createElement("p", null, children) } },
    }, body))
    expect(positions).toEqual([body.indexOf("保留事实"), body.indexOf(meta), body.indexOf(cite)])
  })
})
