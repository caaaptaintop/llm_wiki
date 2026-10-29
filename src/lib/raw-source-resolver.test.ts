import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { readFile as readBytes } from "node:fs/promises"
import { findRawSourceForImage, findRawSourceImageTarget, imageUrlToAbsolute, resolveSourceMarkdownImage } from "./raw-source-resolver"
import { buildImageMarkdownSection, type SavedImage } from "./extract-source-images"
import {
  legacySourceSummarySlugFromIdentity,
  sourceSummarySlugCandidatesFromIdentity,
  sourceSummarySlugFromIdentity,
} from "./source-identity"

vi.mock("@/commands/fs", () => ({ ...realFs,
  readFileAsBase64: async (path: string) => ({ base64: (await readBytes(path)).toString("base64"), mimeType: "image/jpeg" }),
}))

describe("raw source image resolver", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    tmp = await createTempProject("raw-source-resolver")
    await writeFileRaw(`${tmp.path}/raw/sources/report.pdf`, "root source\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.pdf`, "nested source\n")
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("resolves legacy root-level media slugs by raw source stem", async () => {
    if (!tmp) throw new Error("missing temp project")

    await expect(
      findRawSourceForImage(`${tmp.path}/wiki/media/report/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/report.pdf`)
  })

  it("resolves nested source media slugs by source-summary slug", async () => {
    if (!tmp) throw new Error("missing temp project")

    const slug = sourceSummarySlugFromIdentity("project-a/config.pdf")

    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/project-a/config.pdf`)
  })

  it("resolves media slugs for sources inside raw dotfolders", async () => {
    if (!tmp) throw new Error("missing temp project")

    await writeFileRaw(`${tmp.path}/raw/sources/.claude/research.md`, "dotfolder source\n")
    const slug = sourceSummarySlugFromIdentity(".claude/research.md")

    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/.claude/research.md`)
  })

  it("resolves nested source media slugs created with legacy percent-encoded source slugs", async () => {
    if (!tmp) throw new Error("missing temp project")

    await writeFileRaw(`${tmp.path}/raw/sources/2024年/污水处理.pdf`, "nested CJK source\n")
    const slug = legacySourceSummarySlugFromIdentity("2024年/污水处理.pdf")

    expect(slug).toContain("%")
    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/2024年/污水处理.pdf`)
  })

  it("normalizes wiki-relative image URLs to absolute wiki media paths", () => {
    expect(imageUrlToAbsolute("media/report/img-1.png", "/project")).toBe(
      "/project/wiki/media/report/img-1.png",
    )
  })

  it("resolves both byte-bounded and former media slugs for a long CJK source", async () => {
    if (!tmp) throw new Error("missing temp project")
    const identity = `${"资料".repeat(8)}/${"中文".repeat(35)}.pdf`
    const rawPath = `${tmp.path}/raw/sources/${identity}`
    await writeFileRaw(rawPath, "long CJK source\n")
    const candidates = sourceSummarySlugCandidatesFromIdentity(identity)
    expect(candidates[0]).not.toBe(candidates[1])

    for (const slug of candidates.slice(0, 2)) {
      await expect(findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path)).resolves.toBe(rawPath)
    }
  })

  it("prefers exact source identity over an unrelated nested legacy basename", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/raw/sources/a/report.pdf`, "another source")
    await expect(findRawSourceForImage("media/report/img-1.png", tmp.path)).resolves.toBe(`${tmp.path}/raw/sources/report.pdf`)
    await writeFileRaw(`${tmp.path}/raw/sources/other/report.txt`, "another")
    await writeFileRaw(`${tmp.path}/raw/sources/report.md`, "collision")
    await expect(findRawSourceForImage("media/report/img-1.png", tmp.path)).resolves.toBeNull()
  })

  it.each(["https://example.com/media/report/img-1.png", "/other/wiki/media/report/img-1.png", "media/report/../img-1.png", "media/report/%2e%2e%2fimg.png"])("rejects external and escaping media URLs: %s", async (url) => {
    if (!tmp) throw new Error("missing temp project")
    await expect(findRawSourceForImage(url, tmp.path)).resolves.toBeNull()
  })

  async function sourceFixture(markdown: string) {
    if (!tmp) throw new Error("missing temp project")
    const identity = `图表--${"a".repeat(64)}.wiki-source/source.md`
    const source = `${tmp.path}/raw/sources/${identity}`
    const dir = source.slice(0, source.lastIndexOf("/"))
    const slug = sourceSummarySlugFromIdentity(identity)
    await writeFileRaw(source, markdown)
    return { root: tmp.path, source, dir, slug, media: `${tmp.path}/wiki/media/${slug}` }
  }

  async function resolveFigureFixture(markdown: string, name = "chart.jpg") {
    const f = await sourceFixture(markdown)
    for (const file of new Set([name, "chart.jpg", "other.jpg"])) {
      await writeFileRaw(`${f.dir}/images/${file}`, file)
      await writeFileRaw(`${f.media}/001-${file}`, file)
    }
    return resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/001-${name}`)
  }

  it.each([
    ["![](images/chart.jpg)\n\n图 7-9 人工智能视觉识别预制板的进度跟踪", "图 7-9 人工智能视觉识别预制板的进度跟踪", 3],
    ["图7-9：预制板进度\n\n![](images/chart.jpg)", "图7-9：预制板进度", 1],
    ["![](images/chart.jpg)\nFigure 7-9. Tracking precast slabs", "Figure 7-9. Tracking precast slabs", 2],
    ["Fig. 7.9: Slab tracking\n<!-- source-location: unknown -->\n![](images/chart.jpg)", "Fig. 7.9: Slab tracking", 1],
    ["![](images/chart.jpg)\r\n\r\n  Figure 3 — Workflow  ", "  Figure 3 — Workflow  ", 3],
  ])("retains only an adjacent explicit numbered caption verbatim: %s", async (markdown, text, line) => {
    expect((await resolveFigureFixture(markdown))?.figureCaption).toEqual({ text, line, sourceLocation: null })
  })

  it("keeps the figure's own marker separate from the image marker", async () => {
    const markdown = "<!-- source-location: pdf-page:148/block:4 -->\n![](images/chart.jpg)\n<!-- source-location: unknown -->\n\n图 7-9 进度跟踪"
    expect(await resolveFigureFixture(markdown)).toMatchObject({
      line: 2, sourceLocation: "pdf-page:148/block:4",
      figureCaption: { text: "图 7-9 进度跟踪", line: 5, sourceLocation: "unknown" },
    })
    const explicit = "![](images/chart.jpg)\n<!-- source-location: unknown -->\n\n<!-- source-location: pdf-page:149/block:1 -->\n\nFigure 7-9: Tracking"
    expect((await resolveFigureFixture(explicit))?.figureCaption).toEqual({
      text: "Figure 7-9: Tracking", line: 6, sourceLocation: "pdf-page:149/block:1",
    })
  })

  it("prefers a delimited title over an adjacent same-number reference sentence", async () => {
    const markdown = "Figure 2 depicts the sequence.\n\n<!-- source-location: pdf-page:5/block:2 -->\n![](images/chart.jpg)\n<!-- source-location: unknown -->\n\nFigure 2: Example sequence."
    expect((await resolveFigureFixture(markdown))?.figureCaption).toEqual({
      text: "Figure 2: Example sequence.", line: 7, sourceLocation: "unknown",
    })
    // Delimiters cannot resolve conflicting figure numbers or two titles.
    for (const leading of ["Figure 3 depicts the sequence.", "Figure 2: Another title."]) {
      expect((await resolveFigureFixture(markdown.replace("Figure 2 depicts the sequence.", leading)))?.figureCaption).toBeUndefined()
    }
  })

  it.each([
    "正文见图 7-9 进度跟踪", "图像 7-9 进度跟踪", "表 7-9 进度跟踪", "Figurehead 7 Tracking",
    "图 7-9所示为进度跟踪", "图 7-9", "![图 7-9 进度跟踪](images/other.jpg)",
    "`图 7-9 进度跟踪`", "    图 7-9 进度跟踪", "\t图 7-9 进度跟踪",
    "# 图 7-9 进度跟踪", "图 7-9 进度跟踪\n---", "| 图 7-9 进度跟踪 |", "图 7-9 进度跟踪 | 其他列",
    "- 图 7-9 进度跟踪", "<!-- 图 7-9 进度跟踪 -->",
  ])("does not infer a title from non-caption content: %s", async (text) => {
    const result = await resolveFigureFixture(`![](images/chart.jpg)\n\n${text}`)
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty("figureCaption")
  })

  it.each([
    "说明正文", "### 下一节", "| 项目 | 值 |\n| --- | --- |", "<!-- unrelated comment -->",
    "```md", "~~~md", "    代码示例", "![](images/other.jpg)", "![](https://example.com/other.jpg)",
  ])("does not cross a structural boundary on either side: %s", async (boundary) => {
    for (const markdown of [
      `![](images/chart.jpg)\n${boundary}\n图 7-9 进度跟踪`,
      `图 7-9 进度跟踪\n${boundary}\n![](images/chart.jpg)`,
    ]) {
      expect((await resolveFigureFixture(markdown))?.figureCaption).toBeUndefined()
    }
  })

  it.each(["```md", "~~~md"])("does not use figure examples inside %s fences", async (fence) => {
    const delimiter = fence.slice(0, 3)
    for (const markdown of [
      `![](images/chart.jpg)\n${fence}\n图 7-9 进度跟踪\n${delimiter}`,
      `${fence}\n图 7-9 进度跟踪\n${delimiter}\n![](images/chart.jpg)`,
    ]) expect((await resolveFigureFixture(markdown))?.figureCaption).toBeUndefined()
  })

  it("never steals the second of two adjacent images' following title", async () => {
    const markdown = "![](images/chart.jpg)\n\n<!-- source-location: unknown -->\n![](images/other.jpg)\n\n图 7-9 第二张图片"
    expect((await resolveFigureFixture(markdown))?.figureCaption).toBeUndefined()
    expect((await resolveFigureFixture(markdown, "other.jpg"))?.figureCaption).toEqual({ text: "图 7-9 第二张图片", line: 6, sourceLocation: null })
  })

  it.each([
    "![](images/chart.jpg)\n图 7-9 两图之间\n![](images/other.jpg)",
    "图 7-8 前图题\n![](images/chart.jpg)\n图 7-9 后图题",
    "![](images/chart.jpg)\n图 7-8 第一题\n\n图 7-9 第二题",
    "![](images/chart.jpg) ![](images/other.jpg)\n图 7-9 共享图题",
  ])("leaves ambiguous caption ownership unresolved: %s", async (markdown) => {
    expect((await resolveFigureFixture(markdown))?.figureCaption).toBeUndefined()
    expect((await resolveFigureFixture(markdown, "other.jpg"))?.figureCaption).toBeUndefined()
  })

  it("does not derive a figure number from an image's filename or alt", async () => {
    expect((await resolveFigureFixture("![图 7-9 进度跟踪](images/figure-7-9.jpg)", "figure-7-9.jpg"))?.figureCaption).toBeUndefined()
  })

  it("carries the 5089/5092 source layout into one image body with the existing cached description", async () => {
    const title = "图 7-9 人工智能视觉识别预制板的进度跟踪"
    const markdown = [...Array<string>(5087).fill(""), "<!-- source-location: pdf-page:148/block:4 -->", "![](images/page_147_image_3.jpg)", "<!-- source-location: unknown -->", "", title].join("\n")
    const match = await resolveFigureFixture(markdown, "page_147_image_3.jpg")
    expect(match).toMatchObject({ line: 5089, sourceLocation: "pdf-page:148/block:4", figureCaption: { text: title, line: 5092, sourceLocation: "unknown" } })
    const image: SavedImage = { index: 1, mimeType: "image/jpeg", page: null, width: 0, height: 0, relPath: "media/book/001-page_147_image_3.jpg", absPath: "/unused.jpg", sha256: "existing-cache-sha" }
    const section = buildImageMarkdownSection([image], new Map([[image.sha256, "既有描述：多幅现场照片呈现预制板识别与统计结果。"]]), new Map([[image.relPath, { sourcePath: "raw/sources/book/source.md", line: match!.line, sourceLocation: match!.sourceLocation, figureCaption: match!.figureCaption }]]))
    expect(section.split("\n").find((line) => line.startsWith("!["))).toBe(`![${title}；既有描述：多幅现场照片呈现预制板识别与统计结果。](${image.relPath})`)
    expect(section).toContain("图题出处：[[raw/sources/book/source.md]]，行 5092；unknown。")
  })

  it("maps actual numbered media copies back to source URL, line and supplied PDF marker", async () => {
    const markdown = "# 报告\n\n<!-- source-location: pdf-page:8/block:4 -->\n![图1](images/page_7_image_3.jpg)\n\n<!-- source-location: pdf-page:17/block:3 -->\n![图2](images/page_16_image_3.jpg)\n"
    const f = await sourceFixture(markdown)
    await writeFileRaw(`${f.dir}/images/page_7_image_3.jpg`, "image-one")
    await writeFileRaw(`${f.dir}/images/page_16_image_3.jpg`, "image-two")
    await writeFileRaw(`${f.media}/001-page_7_image_3.jpg`, "image-one")
    await writeFileRaw(`${f.media}/002-page_16_image_3.jpg`, "image-two")
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `media/${f.slug}/001-page_7_image_3.jpg`)).resolves.toEqual({
      url: "images/page_7_image_3.jpg", line: 4, sourceLocation: "pdf-page:8/block:4",
    })
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/002-page_16_image_3.jpg`)).resolves.toEqual({
      url: "images/page_16_image_3.jpg", line: 7, sourceLocation: "pdf-page:17/block:3",
    })
    await expect(findRawSourceImageTarget(`../media/${f.slug}/001-page_7_image_3.jpg`, f.root)).resolves.toEqual({ path: f.source, imageSrc: "images/page_7_image_3.jpg" })
  })

  it("verifies bytes when basenames collide and does not derive an index from reference order", async () => {
    const markdown = "![a](images/a/chart.jpg)\n![b](images/b/chart.jpg)"
    const f = await sourceFixture(markdown)
    await writeFileRaw(`${f.dir}/images/a/chart.jpg`, "first")
    await writeFileRaw(`${f.dir}/images/b/chart.jpg`, "second")
    await writeFileRaw(`${f.media}/001-chart.jpg`, "second")
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/001-chart.jpg`)).resolves.toEqual({ url: "images/b/chart.jpg", line: 2, sourceLocation: null })
    await writeFileRaw(`${f.dir}/images/a/chart.jpg`, "second")
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/001-chart.jpg`)).resolves.toBeNull()
  })

  it("refuses changed images, wrong source identity and repeated source occurrences", async () => {
    const markdown = "![a](images/chart.jpg)\n![again](images/chart.jpg)"
    const f = await sourceFixture(markdown)
    await writeFileRaw(`${f.dir}/images/chart.jpg`, "same")
    await writeFileRaw(`${f.media}/001-chart.jpg`, "same")
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/001-chart.jpg`)).resolves.toBeNull()
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown.split("\n")[0], `media/other/001-chart.jpg`)).resolves.toBeNull()
    await writeFileRaw(`${f.media}/001-chart.jpg`, "different")
    await expect(findRawSourceImageTarget(`${f.media}/001-chart.jpg`, f.root)).resolves.toEqual({ path: f.source, imageSrc: null })
  })

  it.each([
    ["<!-- source-location: unknown -->\n![a](images/chart.jpg)", 2, "unknown"],
    ["<!-- source-location: pdf-page:8/block:4 -->\n\n![a](images/chart.jpg)", 3, "pdf-page:8/block:4"],
    ["<!-- source-location: pdf-page:8/block:4 -->\n说明文字\n![a](images/chart.jpg)", 3, null],
    ["```md\n<!-- source-location: pdf-page:8/block:4 -->\n![fake](images/chart.jpg)\n```\n![a](images/chart.jpg)", 5, null],
    ["`![fake](images/chart.jpg)`\n![a](images/chart.jpg)", 2, null],
  ])("uses only the adjacent real marker: %s", async (markdown, line, sourceLocation) => {
    const f = await sourceFixture(markdown)
    await writeFileRaw(`${f.dir}/images/chart.jpg`, "image")
    await writeFileRaw(`${f.media}/001-chart.jpg`, "image")
    await expect(resolveSourceMarkdownImage(f.root, f.source, markdown, `${f.media}/001-chart.jpg`)).resolves.toEqual({ url: "images/chart.jpg", line, sourceLocation })
  })
})
