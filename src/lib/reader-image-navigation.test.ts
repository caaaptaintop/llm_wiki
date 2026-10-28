import { describe, expect, it, vi } from "vitest"
import { findReaderImage, imageScrollTarget, readerImageScrollSource, scrollReaderImage } from "./reader-image-navigation"

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://${path}` }))

describe("file-bound image navigation", () => {
  it("lets the matching chat reader consume a request without selecting its file; rejects other readers", () => {
    const request = imageScrollTarget("/project/raw/sources/book/source.md", "images/chart.jpg")!
    expect(readerImageScrollSource(request, "/project/raw/sources/book/source.md", "/project/wiki/other.md")).toBe("images/chart.jpg")
    expect(readerImageScrollSource(request, "/project/raw/sources/other/source.md", null)).toBeNull()
    expect(readerImageScrollSource("llm-wiki-image:invalid", "/project/raw/sources/book/source.md", null)).toBeNull()
    expect(imageScrollTarget("/project/raw/sources/book/source.md", null)).toBeNull()
  })

  it("preserves the plain/binary preview contract and limits legacy requests to the selected file", () => {
    expect(imageScrollTarget("/project/raw/sources/report.pdf", "/project/wiki/media/report/img-1.png")).toBe("/project/wiki/media/report/img-1.png")
    expect(readerImageScrollSource("images/chart.jpg", "/a.md", "/a.md")).toBe("images/chart.jpg")
    expect(readerImageScrollSource("images/chart.jpg", "/a.md", "/b.md")).toBeNull()
  })

  it("matches complete decoded image paths, never another folder's same basename", () => {
    const image = (src: string) => ({ getAttribute: () => src })
    const wrong = image("images/other/图 1.jpg")
    const right = image("images/%E5%9B%BE%201.jpg")
    const images = [wrong, right]
    expect(findReaderImage(images, "images/图 1.jpg", "/project", "/project/raw/sources/book")).toBe(right)
    expect(findReaderImage(images, "images/missing/图 1.jpg", "/project", "/project/raw/sources/book")).toBeNull()
    expect(findReaderImage(images, "/project/raw/sources/book/images/图 1.jpg", "/project", "/project/raw/sources/book")).toBe(right)
  })

  it("matches wiki fallback media references against their absolute forms", () => {
    const right = { getAttribute: () => "../media/book/001-chart.jpg" }
    expect(findReaderImage([right], "media/book/001-chart.jpg", "/project", "/project/wiki/sources")).toBe(right)
  })

  function imageFixture(complete: boolean) {
    const events = new EventTarget()
    const details = { tagName: "DETAILS", open: false, parentElement: null }
    const target = {
      complete, loading: "lazy", parentElement: details,
      scrollIntoView: vi.fn(),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    }
    return { events, details, target, image: target as unknown as HTMLImageElement }
  }

  it("opens collapsed details, scrolls a lazy target now and after its load, then consumes the request", () => {
    const f = imageFixture(false)
    const consumed = vi.fn()
    const cleanup = scrollReaderImage(f.image, consumed)
    expect(f.details.open).toBe(true)
    expect(f.target.loading).toBe("eager")
    expect(f.target.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" })
    expect(consumed).not.toHaveBeenCalled()
    f.events.dispatchEvent(new Event("load"))
    expect(f.target.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(consumed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("cleans up stale load listeners and consumes already-loaded images immediately", () => {
    const pending = imageFixture(false)
    const consumed = vi.fn()
    const cleanup = scrollReaderImage(pending.image, consumed)
    cleanup()
    pending.events.dispatchEvent(new Event("load"))
    expect(consumed).not.toHaveBeenCalled()
    const ready = imageFixture(true)
    scrollReaderImage(ready.image, consumed)()
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it("keeps a loaded target anchored until earlier images have their final heights", () => {
    const earlier = imageFixture(false)
    const target = imageFixture(true)
    const later = imageFixture(false)
    const rootEvents = new EventTarget()
    const root = {
      querySelectorAll: () => [earlier.image, target.image, later.image],
      addEventListener: rootEvents.addEventListener.bind(rootEvents),
      removeEventListener: rootEvents.removeEventListener.bind(rootEvents),
    } as unknown as HTMLElement
    const consumed = vi.fn()
    const cleanup = scrollReaderImage(target.image, consumed, root)
    expect(consumed).not.toHaveBeenCalled()
    expect(earlier.target.loading).toBe("eager")
    expect(later.target.loading).toBe("lazy")
    earlier.events.dispatchEvent(new Event("load"))
    expect(target.target.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(consumed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("stops anchoring when the user scrolls and ignores later load events", () => {
    const earlier = imageFixture(false)
    const target = imageFixture(true)
    const events = new EventTarget()
    const root = {
      querySelectorAll: () => [earlier.image, target.image],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as HTMLElement
    const consumed = vi.fn()
    const cleanup = scrollReaderImage(target.image, consumed, root)
    events.dispatchEvent(new Event("wheel"))
    earlier.events.dispatchEvent(new Event("load"))
    expect(target.target.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(consumed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("settles failed earlier images and cleans up stale navigation without consuming it", () => {
    const earlier = imageFixture(false)
    const target = imageFixture(true)
    const events = new EventTarget()
    const root = {
      querySelectorAll: () => [earlier.image, target.image],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as HTMLElement
    const consumed = vi.fn()
    scrollReaderImage(target.image, consumed, root)
    earlier.events.dispatchEvent(new Event("error"))
    expect(consumed).toHaveBeenCalledTimes(1)
    const cleanup = scrollReaderImage(target.image, consumed, root)
    cleanup()
    earlier.events.dispatchEvent(new Event("load"))
    expect(consumed).toHaveBeenCalledTimes(1)
  })
})
