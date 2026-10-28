import { resolveMarkdownImageSrc } from "./markdown-image-resolver"

const PREFIX = "llm-wiki-image:"

/** Bind Markdown requests to a file; plain-text/binary previews retain their existing URL contract. */
export function imageScrollTarget(path: string, src: string | null): string | null {
  if (!src) return null
  return /\.(md|mdx)$/i.test(path) ? PREFIX + JSON.stringify({ path, src }) : src
}

export function readerImageScrollSource(request: string, path: string | undefined, selectedFile: string | null): string | null {
  if (!request.startsWith(PREFIX)) return path && path === selectedFile ? request : null
  try {
    const target = JSON.parse(request.slice(PREFIX.length))
    return target.path === path && typeof target.src === "string" ? target.src : null
  } catch { return null }
}

/** Compare full resolved references; never match by basename. */
export function findReaderImage<T extends Pick<HTMLImageElement, "getAttribute">>(
  images: readonly T[], src: string, projectPath: string | null, currentFileDir: string | null,
): T | null {
  const expected = resolveMarkdownImageSrc(src, projectPath, currentFileDir)
  return images.find((image) => {
    const actual = image.getAttribute("data-mdsrc")
    return actual !== null && resolveMarkdownImageSrc(actual, projectPath, currentFileDir) === expected
  }) ?? null
}

/** Earlier images also determine the target's final position in a long document. */
export function scrollReaderImage(target: HTMLImageElement, consumed: () => void, reader?: HTMLElement): () => void {
  let parent = target.parentElement
  while (parent) {
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true
    parent = parent.parentElement
  }
  const scroll = () => target.scrollIntoView({ behavior: "auto", block: "center" })
  const images = reader ? Array.from(reader.querySelectorAll<HTMLImageElement>("img")) : [target]
  const targetIndex = images.indexOf(target)
  const pending = new Set((targetIndex >= 0 ? images.slice(0, targetIndex + 1) : [target]).filter(image => !image.complete))
  scroll()
  if (!pending.size) { consumed(); return () => {} }
  let active = true
  const listeners = new Map<HTMLImageElement, () => void>()
  const cleanup = () => {
    active = false
    for (const [image, done] of listeners) {
      image.removeEventListener("load", done)
      image.removeEventListener("error", done)
    }
    for (const event of ["wheel", "touchstart", "pointerdown"]) reader?.removeEventListener(event, cancel)
    reader?.ownerDocument?.removeEventListener("keydown", onKey)
  }
  const cancel = () => { if (active) { cleanup(); consumed() } }
  const onKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel()
  }
  for (const image of pending) {
    const done = () => {
      if (!active) return
      pending.delete(image)
      if (!pending.size) { scroll(); cleanup(); consumed() }
    }
    listeners.set(image, done)
    image.addEventListener("load", done, { once: true })
    image.addEventListener("error", done, { once: true })
    // Resolve the heights before the target, without eagerly loading later images.
    image.loading = "eager"
  }
  for (const event of ["wheel", "touchstart", "pointerdown"]) reader?.addEventListener(event, cancel, { passive: true })
  reader?.ownerDocument?.addEventListener("keydown", onKey)
  return cleanup
}
