import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { describe, expect, it } from "vitest"
import { remarkHideSourceLocations } from "./remark-hide-source-locations"

const marker = "<!-- source-location: epub-spine:1/block:1 -->"
const unknown = "<!-- source-location: unknown -->"
function render(source: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkHideSourceLocations] }, source))
}

describe("source-location preview comments", () => {
  it("hides EPUB, PDF and unknown standalone markers while keeping prose and images", () => {
    const source = `${marker}\n# Chapter\n\n![cover](images/cover.jpg)\n\n<!-- source-location: pdf-page:7/block:2 -->\nA passage.\n${unknown}\nAnother passage.`
    const html = render(source)
    expect(html).not.toContain("source-location:")
    expect(html).toContain("Chapter")
    expect(html).toContain("images/cover.jpg")
    expect(html).toContain("A passage.")
    expect(html).toContain("Another passage.")
    expect(source).toContain(marker)
    expect(source).toContain(unknown)
  })

  it.each([
    `\`\`\`markdown\n${marker}\n\`\`\``,
    `\`\`\`\`markdown\n\`\`\`\n${marker}\n\`\`\`\``,
    `~~~html\n${marker}\n~~~`,
    `    ${marker}`,
    `\t${marker}`,
    `\`${marker}\``,
    `\`\`example ${marker}\ntext\`\``,
  ])("preserves locator examples parsed as code: %s", (source) => {
    expect(render(source)).toContain("&lt;!-- source-location: epub-spine:1/block:1 --&gt;")
    expect(render(source)).toContain("<code")
  })

  it("preserves inline, escaped, unrelated and malformed comments", () => {
    for (const source of [
      `Before ${marker} after.`, `*${marker}*`, `\\${marker}`,
      `&lt;!-- source-location: unknown --&gt;`, `${marker} visible on the same line`,
      "<!-- source-location: unsupported -->", "<!-- source-location: unknown", "<!-- ordinary note -->",
    ]) expect(render(source)).toContain("&lt;!--")
  })

  it("hides standalone marker blocks in quotations and lists", () => {
    const html = render(`> ${marker}\n>\n> Quoted prose.\n\n- ${unknown}\n\n  List prose.`)
    expect(html).not.toContain("source-location:")
    expect(html).toContain("Quoted prose.")
    expect(html).toContain("List prose.")
  })

  it("preserves original line and offset positions after hidden markers, including CRLF", () => {
    for (const newline of ["\n", "\r\n"]) {
      const source = [marker, "", "First paragraph.", "", unknown, "", "Second paragraph."].join(newline)
      const starts: Array<{ line: number | undefined; offset: number | undefined }> = []
      renderToStaticMarkup(createElement(ReactMarkdown, {
        remarkPlugins: [remarkHideSourceLocations],
        components: { p: ({ node, children }) => {
          starts.push({ line: node?.position?.start.line, offset: node?.position?.start.offset })
          return createElement("p", null, children)
        } },
      }, source))
      expect(starts).toEqual([
        { line: 3, offset: source.indexOf("First paragraph.") },
        { line: 7, offset: source.indexOf("Second paragraph.") },
      ])
    }
  })
})
