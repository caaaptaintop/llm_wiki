import { describe, expect, it } from "vitest"
import { bookImagePaths, hasSourceLocations, sourceLocationsForRange } from "./book-source"

describe("external source contract", () => {
  it("keeps PDF pages distinct from EPUB spine and ends block attribution explicitly", () => {
    const text = "Unmapped intro\n<!-- source-location: epub-spine:2/block:3 -->\nA mapped passage.\n<!-- source-location: unknown -->\nAn unmapped passage.\n<!-- source-location: pdf-page:7/block:1 -->\nAnother mapped passage.\n<!-- source-location: unknown -->\n"
    const range = (quote: string) => sourceLocationsForRange(text, text.indexOf(quote), text.indexOf(quote) + quote.length)
    expect(range("A mapped passage.")).toEqual(["epub-spine:2/block:3"])
    expect(range("Another mapped passage.")).toEqual(["pdf-page:7/block:1"])
    expect(range("An unmapped passage.")).toEqual([])
    expect(range("Unmapped intro")).toEqual([])
    expect(sourceLocationsForRange(text, 0, text.length)).toEqual([])
    expect(hasSourceLocations(text)).toBe(true)
  })
  it("ignores marker and image examples inside code", () => {
    const text = "````markdown\n```\n<!-- source-location: pdf-page:99/block:1 -->\n![example](https://example.org/image.png)\n````\n`![inline](../outside.jpg)`\n![real](images/cover.jpg)"
    expect(hasSourceLocations(text)).toBe(false)
    expect(bookImagePaths(text)).toEqual(["images/cover.jpg"])
  })
  it("decodes portable image paths and deduplicates references", () => {
    expect(bookImagePaths("![x](images/a%20%28b%29.jpg)\n![x](images/a%20%28b%29.jpg)")).toEqual(["images/a (b).jpg"])
  })
  it("does not read escaped image examples, but recognizes an even backslash count", () => {
    expect(bookImagePaths(String.raw`\![](images/missing.png)`)).toEqual([])
    expect(bookImagePaths(String.raw`\![example][ref]`)).toEqual([])
    expect(bookImagePaths(String.raw`\\![](images/real.png)`)).toEqual(["images/real.png"])
  })
  it.each(["../secret.png", "images/../secret.png", "images/%2e%2e/secret.png", "https://example.org/a.jpg", "/tmp/a.jpg", "images/a.svg"])("rejects an unsafe or unsupported image path: %s", (path) => {
    expect(() => bookImagePaths(`![x](${path})`)).toThrow("images/")
  })
  it("requires the exporter to normalize reference and HTML images", () => {
    expect(() => bookImagePaths('![cover][image]\n[image]: images/a.jpg')).toThrow("导出工具")
    expect(() => bookImagePaths('<img src="images/a.jpg">')).toThrow("导出工具")
  })
})
