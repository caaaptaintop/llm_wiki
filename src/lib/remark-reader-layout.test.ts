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
const meta = "类型：参数。来源章节：第五章 · 示例。"
function render(body: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [
    [remarkReaderLayout, { evidenceLabel: "出处与章节", sourceReferences: { "#source-summary": "研究摘要", "#raw%2Fsources%2Fbook.md": "原文" } }], remarkHideSourceLocations, remarkReaderReferences,
  ] }, body))
}

describe("reading layout preserves full evidence", () => {
  it("accepts source-location provenance comments inside explicit evidence while preserving knowledge", () => {
    const html = render("实验在仿真环境中测试。\n\n<!-- wiki-evidence:start -->\n\n来源：study.md，PDF第3页／区块2。\n\n<!-- source-location: pdf-page:3/block:2 -->\n\n<!-- wiki-evidence:end -->\n\n每批最多20个构件。")
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html.indexOf("实验在仿真环境")).toBeLessThan(html.indexOf("<details"))
    expect(html.indexOf("PDF第3页")).toBeGreaterThan(html.indexOf("<details"))
    expect(html.indexOf("每批最多20个")).toBeGreaterThan(html.indexOf("</details>"))
  })

  it("folds explicitly separated bibliography and provenance without hiding adjacent knowledge", () => {
    const html = render(`## 工程应用\n\n研究将平台用于地形测绘，结果限于该案例。\n\n<!-- wiki-evidence:start -->\n\n来源：[研究摘要](#source-summary)。资料定位：PDF物理页20／区块8；表格定位未知。\n\n> Example Research. (2020). A field study.\n\n该引用定位：PDF物理页20／区块9。\n\n<!-- wiki-evidence:end -->\n\n## 数据组织\n\n保留构件ID和状态。`)
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html).toContain('<summary>出处与章节 · 3</summary>')
    expect(html.indexOf("结果限于该案例")).toBeLessThan(html.indexOf("<details"))
    expect(html.indexOf("资料定位")).toBeGreaterThan(html.indexOf("<details"))
    expect(html.indexOf("该引用定位")).toBeLessThan(html.indexOf("</details>"))
    expect(html).toContain('href="#source-summary"')
    expect(html).toContain("Example Research. (2020). A field study.")
    expect(html.indexOf("保留构件ID和状态")).toBeGreaterThan(html.indexOf("</details>"))
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })

  it("keeps managed-record metadata inside an explicit provenance fold", () => {
    const html = render(`${start}\n\n### 应用参数\n\n${meta}\n\n参数按合同约定。\n\n<!-- wiki-evidence:start -->\n\n${cite}\n\n${unknown}\n\n<!-- wiki-evidence:end -->\n\n${end}`)
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html.indexOf(meta)).toBeGreaterThan(html.indexOf("<details"))
    expect(html).toContain('data-reader-locator="pdf-page:4/block:2"')
    expect(html.indexOf("参数按合同约定")).toBeLessThan(html.indexOf("<details"))
  })

  it.each([
    "<!-- wiki-evidence:start -->\n\n出处说明未闭合。\n\n## 后续知识\n\n必须保留。",
    "<!-- wiki-evidence:start -->\n\n## 误包住的标题\n\n必须保留。\n\n<!-- wiki-evidence:end -->",
    "<!-- wiki-evidence:start -->\n\n![事实图](images/fact.png)\n\n<!-- wiki-evidence:end -->",
    "<!-- wiki-evidence:start -->\n\n<!-- wiki-evidence:start -->\n\n必须保留。\n\n<!-- wiki-evidence:end -->\n\n<!-- wiki-evidence:end -->",
  ])("does not conceal content in malformed or structurally unsafe provenance blocks", body => {
    const html = render(body)
    expect(html).not.toContain("<details")
    expect(html).toMatch(/必须保留|<img/)
  })

  it("folds standalone legacy locators and source links without changing navigation", () => {
    const html = render("## 转换步骤\n\n保留几何、名称和ID。\n\n定位：`pdf-page:10/block:2`。\n\n来源：[研究摘要](#source-summary)。")
    expect(html).toContain("<p>保留几何、名称和ID。</p>")
    expect(html).toContain("<summary>出处与章节 · 2</summary>")
    expect(html).toContain('data-reader-locator="pdf-page:10/block:2"')
    expect(html).toContain('href="#source-summary"')
  })

  it("folds pure physical-page references but keeps source facts and quoted examples visible", () => {
    const html = render("定位：PDF物理页10，§4.5；PDF物理页15–16，图12–14。\n\n来源：[设备](#device)提供传感数据。\n\n定位：采用卫星定位，精度按合同确定。\n\n> 定位：`pdf-page:4/block:2`。")
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html).toContain("PDF物理页10，§4.5；PDF物理页15–16，图12–14。")
    expect(html).toContain("提供传感数据。")
    expect(html).toContain("采用卫星定位，精度按合同确定。")
    expect(html).toContain("<blockquote>\n<p>定位：")
  })

  it.each(["该仿真耗时4.48分钟，仅适用于原材料布置。", "**该仿真耗时4.48分钟**，仅适用于原材料布置。", "该仿真耗时4.48分钟"])("keeps factual link labels visible: %s", label => {
    const html = render(`证据：[${label}](#fact)。\n\n来源：[${label}](#source-summary)。\n\n出处：[${label}](#source-summary)，行 12–13；pdf-page:4/block:2。`)
    expect(html).not.toContain("<details")
    expect(html).toContain("4.48分钟")
  })

  it("keeps facts before and after canonical source links visible", () => {
    const html = render("出处：该仿真耗时4.48分钟。[研究摘要](#source-summary)，行 12–13；pdf-page:4/block:2。\n\n出处：[研究摘要](#source-summary)仅限该布置，行 12–13；unknown。")
    expect(html).not.toContain("<details")
    expect(html).toContain("4.48分钟")
    expect(html).toContain("仅限该布置")
  })

  it.each(["", " "])("keeps an image before citations with separator %j", separator => {
    const html = render(`![关键节点](images/node.jpg)${separator}[来源：L12](raw/sources/example/source.md#L12)`)
    expect(html).toContain('<img src="images/node.jpg" alt="关键节点"/>')
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('<details'))
    expect(html).toContain('<summary>出处与章节 · 1</summary>')
    expect(html).toContain('href="raw/sources/example/source.md#L12"')
  })

  it("folds trailing legacy inline citations while keeping every fact and source target", () => {
    const link = "[来源：L12，pdf-page:4/block:2](raw/sources/example/source.md#L12)"
    const second = "[L18，pdf-page:5/block:1](raw/sources/example/source.md#L18)"
    const body = `采用试验方案。${link}；${second}\n\n参数按合同确定。`
    const html = render(body)
    expect(html).toContain("<p>采用试验方案。</p>")
    expect(html).toContain("<summary>出处与章节 · 2</summary>")
    expect(html).toContain('href="raw/sources/example/source.md#L12"')
    expect(html).toContain('href="raw/sources/example/source.md#L18"')
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf('href="raw/sources/example/source.md#L12"'))
    expect(html).toContain("参数按合同确定。")
  })

  it("keeps a standalone citation label with its folded links", () => {
    const html = render("定位：[L12，pdf-page:4/block:2](raw/sources/example/source.md#L12)")
    expect(html).not.toContain("<p>定位：</p>")
    expect(html).toContain('<p>定位：<a href="raw/sources/example/source.md#L12">')
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("定位："))
  })

  it.each(["![关键节点](images/node.jpg)", "`操作条件`"])("keeps content after a locator label visible: %s", content => {
    const html = render(`定位：${content}[L12](raw/sources/example/source.md#L12)`)
    const detail = html.indexOf("<details")
    expect(detail).toBeGreaterThan(0)
    expect(html.indexOf(content.startsWith("!") ? "<img" : "<code")).toBeLessThan(detail)
    expect(html.slice(detail)).not.toMatch(/<img|<code/)
  })

  it("never folds a link followed by a substantive condition or an ordinary link", () => {
    const html = render("采用方案[来源：L12，pdf-page:4/block:2](raw/sources/example/source.md#L12)，仅限试验阶段。\n\n[来源网站](https://example.com)\n\n`来源：L12`不是出处链接。")
    expect(html).not.toContain("<details")
    expect(html).toContain("仅限试验阶段。")
  })
  it("folds only evidence and record metadata; keeps all conditions, locators and links", () => {
    const body = `# 页\n\n## 已有小节\n\n已有小节的正文。\n\n${start}\n\n### 场景精度\n\n${meta}\n\n测试模式采用A级或按约定；演示模式采用B级及以上。\n\n${cite}\n\n${unknown}\n\n${end}`
    const html = render(body)
    expect(html).toContain("<h2>场景精度</h2>")
    expect(html).toContain("<p>测试模式采用A级或按约定；演示模式采用B级及以上。</p>\n<details")
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

  it("preserves explicit groups over consecutive managed blocks", () => {
    const secondKey = "b".repeat(64)
    const second = `${start.replace(key, secondKey)}\n\n### 另一方法\n\n${meta}\n\n方法二。\n\n${cite}\n\n${end.replace(key, secondKey)}`
    const html = render(`## 分组\n\n${start}\n\n### 方法步骤\n\n${meta}\n\n方法一。\n\n${cite}\n\n${end}\n\n${second}`)
    expect(html).toContain("<h2>分组</h2>")
    expect(html).toContain("<h3>方法步骤</h3>")
    expect(html).toContain("<h3>另一方法</h3>")
    expect(html.match(/<details /g)).toHaveLength(2)
  })

  it("keeps each record's provenance with its own citations", () => {
    const html = render(`${start}\n\n### 第一项\n\n${meta}\n\n事实一。\n\n${cite}\n\n### 第二项\n\n类型：方法。来源章节：第二章。\n\n事实二。\n\n${unknown}\n\n${end}`)
    expect(html.match(/<details /g)).toHaveLength(2)
    const sections = html.split("<h2>第二项</h2>")
    expect(sections[0]).toContain(meta)
    expect(sections[0]).not.toContain("来源章节：第二章")
    expect(sections[1]).toContain("来源章节：第二章")
  })

  it("keeps metadata with its record when the next record has an explicit provenance block", () => {
    const first = "类型：方法。来源章节：第一章。"
    const second = "类型：参数。来源章节：第二章。"
    const html = render(`${start}\n\n### 记录甲\n\n${first}\n\n事实甲，无规范引文。\n\n### 记录乙\n\n<!-- wiki-evidence:start -->\n\n${second}\n\n<!-- wiki-evidence:end -->\n\n事实乙。\n\n${end}`)
    expect(html.indexOf(first)).toBeLessThan(html.indexOf("记录乙"))
    expect(html.slice(html.indexOf("记录乙"))).not.toContain(first)
    expect(html.slice(html.indexOf("记录乙"))).toContain(second)
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
      remarkPlugins: [[remarkReaderLayout, { evidenceLabel: "出处", sourceReferences: { "#raw%2Fsources%2Fbook.md": "原文" } }], remarkHideSourceLocations],
      components: { p: ({ node, children }) => { positions.push(node?.position?.start.offset ?? -1); return createElement("p", null, children) } },
    }, body))
    expect(positions).toEqual([body.indexOf("保留事实"), body.indexOf(meta), body.indexOf(cite)])
  })
})
