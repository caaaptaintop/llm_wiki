import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { describe, expect, it } from "vitest"
import { referenceLabel, remarkReaderReferences } from "./reader-presentation"

function render(body: string, compact = true) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: compact ? [remarkReaderReferences] : [] }, body))
}

describe("shared Wiki reading presentation", () => {
  it("compacts EPUB and PDF locators in inline code and prose, with stable repeated reference numbers", () => {
    const body = "出处：`epub-spine:3/block:2`、`pdf-page:7/block:1`。再次见 epub-spine:3/block:2。"
    expect(render(body, false)).toContain("<code>epub-spine:3/block:2</code>")
    const html = render(body)
    expect(html).toContain('data-reader-locator="epub-spine:3/block:2">[1]</span>')
    expect(html).toContain('data-reader-locator="pdf-page:7/block:1">[2]</span>')
    expect(html.match(/>\[1\]<\/span>/g)).toHaveLength(2)
    expect(body).toContain("`epub-spine:3/block:2`")
  })

  it.each([
    "```text\nepub-spine:3/block:2\n```", "~~~text\npdf-page:7/block:1\n~~~",
    "    epub-spine:3/block:2", "`Latitude` and `Longitude`", "`example epub-spine:3/block:2`",
    "[epub-spine:3/block:2](https://example.com)", "https://example.com/epub-spine:3/block:2",
    "epub-spine:0/block:2 and my_epub-spine:3/block:2x",
  ])("keeps code examples, explicit links and unrelated text unchanged: %s", (body) => {
    expect(render(body)).toBe(render(body, false))
  })

  it("marks only managed source identities and preserves the complete target", () => {
    const ref = `alice--${"a".repeat(64)}.wiki-source/source.md`
    const html = render(`来源：\`${ref}\`。普通代码：\`source.md\`。`)
    expect(html).toContain(`data-reader-source="${ref}"`)
    expect(html).toContain("<code>source.md</code>")
    expect(referenceLabel(ref)).toBe("alice")
    expect(referenceLabel(ref, "爱丽丝梦游仙境")).toBe("爱丽丝梦游仙境")
    expect(referenceLabel("themes/组织学习.md")).toBe("组织学习")
    expect(referenceLabel("characters/white-rabbit")).toBe("white rabbit")
  })

  it.each([
    "`epub-spine:3/block:9`—`epub-spine:3/block:10`",
    "epub-spine:3/block:9 — epub-spine:3/block:10",
  ])("keeps an entire locator range under one reference: %s", (range) => {
    const html = render(`先见 \`epub-spine:3/block:2\`。出处：${range}。`)
    expect(html).toContain('data-reader-locator="epub-spine:3/block:9 — epub-spine:3/block:10">[2]</span>')
    expect(html).not.toContain("[3]")
  })

  it("retains paragraph source offsets when the displayed citation becomes shorter", () => {
    const body = "# Page\n\nText `epub-spine:3/block:2`.\n\nNext paragraph."
    const positions: number[] = []
    renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkReaderReferences], components: { p: ({ node, children }) => {
        positions.push(node?.position?.start.offset ?? -1)
        return createElement("p", null, children)
      } },
    }, body))
    expect(positions).toEqual([body.indexOf("Text"), body.indexOf("Next")])
  })
})
