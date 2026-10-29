import { describe, expect, it } from "vitest"
import { buildProjectPathIndexFromTree } from "./wiki-page-resolver"
import { findReaderHeading, resolveReaderLink } from "./reader-link-resolver"
import { transformWikilinks } from "./wikilink-transform"

const root = "/project"
const notes = "/project/wiki/books/book-id/revision/book-id-chapter-1.md"
const chapter = "/project/raw/books/book-id/revision/book-id-chapter-1.md"
const source = "/project/raw/books/book-id/source.epub"
const evidence = "book-id-chapter-1-p1-e1"
const index = buildProjectPathIndexFromTree([
  ...[notes, chapter, source, "/project/wiki/books/book-id/revision/有 空格.md", "/outside.md", "/project-other/outside.md"]
    .map((path) => ({ name: path.split("/").pop()!, path, is_dir: false })),
  { name: "folder.md", path: "/project/wiki/books/book-id/revision/folder.md", is_dir: true },
])

describe("resolveReaderLink", () => {
  it("resolves root-relative source citations from a nested knowledge page without traversal", () => {
    const raw = "/project/raw/sources/example/source.md"
    const sourceIndex = buildProjectPathIndexFromTree([notes, raw].map(path => ({ name: path.split("/").pop()!, path, is_dir: false })))
    expect(resolveReaderLink(sourceIndex, "raw/sources/example/source.md#L12", notes, root)).toEqual({ path: raw, anchor: "L12" })
    expect(resolveReaderLink(sourceIndex, "raw/sources/../../wiki/books/book-id/revision/book-id-chapter-1.md", notes, root)).toBeNull()
    expect(resolveReaderLink(sourceIndex, "raw/sources/missing.md", notes, root)).toBeNull()
  })
  it("opens prepared raw-source wikilinks only inside the indexed sources directory", () => {
    const raw = "/project/raw/sources/指南/source.md"
    const sourceIndex = buildProjectPathIndexFromTree([
      { name: "source.md", path: raw, is_dir: false },
      { name: "folder.md", path: "/project/raw/sources/folder.md", is_dir: true },
    ])
    const href = transformWikilinks("[[raw/sources/指南/source.md|出处]]").match(/\]\((.+)\)$/)![1]
    expect(resolveReaderLink(sourceIndex, href, notes, root)).toEqual({ path: raw, anchor: null })
    expect(resolveReaderLink(sourceIndex, `${href}%23章节`, notes, root)).toEqual({ path: raw, anchor: "章节" })
    for (const bad of ["#raw/sources/../outside.md", "#raw/sources/%2e%2e/outside.md", "#raw/sources/%252e%252e/outside.md", "#raw/sources/folder.md", "#raw/sources/missing.md", "#raw/sources-other/指南/source.md", "#raw/sources//指南/source.md", "#raw/sources/指南/source.md%00"]) {
      expect(resolveReaderLink(sourceIndex, bad, notes, root)).toBeNull()
    }
  })

  it("opens the actual indexed chapter text and original file relative to book notes", () => {
    expect(resolveReaderLink(index, "../../../../raw/books/book-id/revision/book-id-chapter-1.md", notes, root))
      .toEqual({ path: chapter, anchor: null })
    expect(resolveReaderLink(index, "../../../../raw/books/book-id/source.epub", notes, root))
      .toEqual({ path: source, anchor: null })
  })

  it("decodes filenames once and preserves ordinary Markdown heading fragments", () => {
    expect(resolveReaderLink(index, "./%E6%9C%89%20%E7%A9%BA%E6%A0%BC.md#%E4%BE%9D%E6%8D%AE", notes, root))
      .toEqual({ path: "/project/wiki/books/book-id/revision/有 空格.md", anchor: "依据" })
  })

  it("preserves the evidence anchor encoded by the actual wikilink transform", () => {
    const transformed = transformWikilinks(`[[book-id-chapter-1#${evidence}|依据]]`)
    const href = transformed.match(/\]\((.+)\)$/)![1]
    expect(resolveReaderLink(index, href, notes, root)).toEqual({ path: notes, anchor: evidence })
    expect(resolveReaderLink(index, `#book-id-chapter-1#${evidence}`, notes, root)).toEqual({ path: notes, anchor: evidence })
    expect(resolveReaderLink(index, "#book-id-chapter-1", undefined, root)).toEqual({ path: notes, anchor: null })
  })

  it.each([
    "../../../../../outside.md", "../../../../../project-other/outside.md", "../../../../../project/wiki/books/book-id/revision/book-id-chapter-1.md",
    "%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.md", "%252e%252e/outside.md",
    "/outside.md", "//server/share/file.md", "C:/outside.md", "C:\\outside.md", "\\\\server\\share\\file.md",
    "file:///outside.md", "tauri://localhost/file", "javascript:alert(1)", "data:text/plain,test", "https://example.com/file.md", "mailto:test@example.com",
    "https%3A%2F%2Fexample.com/file.md", "%2F%2Fserver/share/file.md", "..%5C..%5Coutside.md",
    "book-id-chapter-1.md?outside=true", "book-id-chapter-1.md%00", "book-id-chapter-1.md#%00", "book-id-chapter-1.md#%ZZ", "%ZZ.md",
    "missing.md", "folder.md", " #book-id-chapter-1", "#../book-id-chapter-1", "#wiki/../../outside", "#file%3A/outside",
  ])("rejects unsafe, missing or directory targets: %s", (href) => {
    expect(resolveReaderLink(index, href, notes, root)).toBeNull()
  })

  it("does not guess the base directory or accept an unindexed/outside current file", () => {
    for (const base of [undefined, "/outside.md", "/project/wiki/missing.md", "/project/../outside.md"]) {
      expect(resolveReaderLink(index, "./source.epub", base, root)).toBeNull()
    }
  })

  it("supports Windows project and indexed file separators without accepting drive hrefs", () => {
    const windows = buildProjectPathIndexFromTree([
      { name: "notes.md", path: "C:\\project\\wiki\\notes.md", is_dir: false },
      { name: "source.pdf", path: "C:\\project\\raw\\source.pdf", is_dir: false },
    ])
    expect(resolveReaderLink(windows, "../raw/source.pdf", "C:\\project\\wiki\\notes.md", "C:\\project"))
      .toEqual({ path: "C:\\project\\raw\\source.pdf", anchor: null })
    expect(resolveReaderLink(windows, "D:/outside.pdf", "C:\\project\\wiki\\notes.md", "C:\\project")).toBeNull()
  })
})

describe("findReaderHeading", () => {
  it("matches exact generated evidence headings as well as existing DOM IDs", () => {
    const headings = [{ id: "", textContent: "Chapter" }, { id: "", textContent: ` ${evidence} ` }, { id: "existing", textContent: "Existing title" }]
    expect(findReaderHeading(headings, evidence)).toBe(headings[1])
    expect(findReaderHeading(headings, "existing")).toBe(headings[2])
    expect(findReaderHeading(headings, "missing")).toBeNull()
    expect(findReaderHeading(headings, '"] h1')).toBeNull()
  })
})
