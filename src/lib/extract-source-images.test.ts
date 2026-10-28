import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  readFileAsBase64: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile,
  createDirectory: mocks.createDirectory,
  fileExists: vi.fn(),
  readFileAsBase64: mocks.readFileAsBase64,
}))

import { buildImageMarkdownSection, extractAndSaveSourceImages, findLocalMarkdownImageRefs, type SavedImage } from "./extract-source-images"
import { sourceLocationsForRange } from "./book-source"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.readFileAsBase64.mockResolvedValue({ base64: "aW1hZ2U=", mimeType: "image/png" })
})

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })
})

describe("extractAndSaveSourceImages", () => {
  it("prefixes the original title to the cached description in the same image body and preserves title provenance", () => {
    const image: SavedImage = { index: 1, relPath: "media/book/one.jpg", absPath: "/project/wiki/media/book/one.jpg", page: null, width: 0, height: 0, mimeType: "image/jpeg", sha256: "one" }
    const title = "图 7-9 人工智能视觉识别预制板的进度跟踪"
    const description = "现场照片呈现识别框与统计结果。"
    const captions = new Map([["one", description]])
    const section = buildImageMarkdownSection([image], captions, new Map([[image.relPath, {
      sourcePath: "raw/sources/book/source.md", line: 5089, sourceLocation: "pdf-page:148/block:4",
      figureCaption: { text: title, line: 5092, sourceLocation: "unknown" },
    }]]))
    expect(section).toContain(`![${title}；${description}](${image.relPath})`)
    expect(section).toContain(`\n${title}\n`)
    expect(section).toContain("出处：[[raw/sources/book/source.md]]，行 5089；pdf-page:148/block:4。")
    expect(section).toContain("图题出处：[[raw/sources/book/source.md]]，行 5092；unknown。")
    const imageStart = section.indexOf("![")
    expect(sourceLocationsForRange(section, imageStart, imageStart + 10)).toEqual(["pdf-page:148/block:4"])
    const titleStart = section.lastIndexOf(`\n${title}\n`) + 1
    expect(sourceLocationsForRange(section, titleStart, titleStart + title.length)).toEqual([])
    expect([...captions]).toEqual([["one", description]])
  })

  it.each([null, "epub-spine:3/block:2"])("uses only the caption's own location (%s), without leaking onto the next image", (location) => {
    const image = (name: string): SavedImage => ({ index: 1, relPath: `media/${name}.jpg`, absPath: `/project/wiki/media/${name}.jpg`, page: null, width: 0, height: 0, mimeType: "image/jpeg", sha256: name })
    const first = image("one"), second = image("two")
    const title = "Figure 7-9: Slab tracking"
    const section = buildImageMarkdownSection([first, second], new Map([["two", "Second image description"]]), new Map([[first.relPath, {
      sourcePath: "raw/sources/book/source.md", line: 10, sourceLocation: "pdf-page:8/block:4",
      figureCaption: { text: title, line: 13, sourceLocation: location },
    }]]))
    expect(section).toContain(`![${title}](${first.relPath})`)
    expect(section).toContain(`![Second image description](${second.relPath})`)
    expect(section).toContain(`行 13；${location ?? "unknown"}。`)
    const titleStart = section.lastIndexOf(`\n${title}\n`) + 1
    expect(sourceLocationsForRange(section, titleStart, titleStart + title.length)).toEqual(location ? [location] : [])
    const nextImage = section.indexOf("![Second")
    expect(sourceLocationsForRange(section, nextImage, nextImage + 10)).toEqual([])
  })

  it("escapes alt-only syntax without changing the verbatim source title or cached caption", () => {
    const title = "Fig. 7.9: Tracking [slabs]"
    const description = "Existing [boxes]\nand counts"
    const captions = new Map([["one", description]])
    const image: SavedImage = { index: 1, relPath: "media/one.jpg", absPath: "/unused.jpg", page: null, width: 0, height: 0, mimeType: "image/jpeg", sha256: "one" }
    const section = buildImageMarkdownSection([image], captions, new Map([[image.relPath, {
      sourcePath: "raw/sources/book/source.md", line: 10, sourceLocation: null,
      figureCaption: { text: title, line: 12, sourceLocation: null },
    }]]))
    expect(section).toContain("![Fig. 7.9: Tracking [slabs)；Existing [boxes) and counts](media/one.jpg)")
    expect(section).toContain(`\n${title}\n`)
    expect(captions.get("one")).toBe(description)
  })

  it("keeps verified image provenance separate and does not leak a page marker onto the next image", () => {
    const image = (relPath: string): SavedImage => ({ relPath, absPath: `/project/wiki/${relPath}`, index: 1, page: null, width: 0, height: 0, mimeType: "image/jpeg", sha256: relPath })
    const section = buildImageMarkdownSection([image("media/one.jpg"), image("media/two.jpg")], new Map([
      ["media/one.jpg", "flowchart"], ["media/two.jpg", "roadmap"],
    ]), new Map([["media/one.jpg", { sourcePath: "raw/sources/book.wiki-source/source.md", line: 210, sourceLocation: "pdf-page:8/block:4" }]]))
    expect(section).toContain("行 210；pdf-page:8/block:4")
    const first = section.indexOf("![flowchart]")
    const second = section.indexOf("![roadmap]")
    expect(sourceLocationsForRange(section, first, first + 12)).toEqual(["pdf-page:8/block:4"])
    expect(sourceLocationsForRange(section, second, second + 10)).toEqual([])
  })

  it("imports a standalone image as the source's only saved image", async () => {
    const images = await extractAndSaveSourceImages(
      "/project",
      "/project/raw/sources/process flow.JPG",
      "process-flow",
    )

    expect(mocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/process-flow")
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/project/raw/sources/process flow.JPG",
      "/project/wiki/media/process-flow/001-process flow.JPG",
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/jpeg",
      page: null,
      relPath: "media/process-flow/001-process flow.JPG",
      absPath: "/project/wiki/media/process-flow/001-process flow.JPG",
    })
    expect(images[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
