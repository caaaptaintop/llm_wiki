import { useEffect, useMemo, useRef } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { transformImageEmbeds, transformWikilinks } from "@/lib/wikilink-transform"
import { findReaderHeading, resolveReaderLink } from "@/lib/reader-link-resolver"
import { remarkHideSourceLocations } from "@/lib/remark-hide-source-locations"
import { remarkReaderLayout } from "@/lib/remark-reader-layout"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { findReaderImage, readerImageScrollSource, scrollReaderImage } from "@/lib/reader-image-navigation"
import { normalizePath } from "@/lib/path-utils"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { useWikiStore } from "@/stores/wiki-store"
import { useReferenceTitles } from "@/hooks/use-reference-titles"
import { PREPARED_REFERENCE_PATTERN, referenceLabel, remarkReaderReferences } from "@/lib/reader-presentation"
import { resolveSourceReference } from "@/lib/wiki-page-resolver"
import { useAppDialog } from "@/stores/app-dialog-store"
import { useTranslation } from "react-i18next"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

interface WikiReaderProps {
  body: string
  /** Original, untransformed Markdown body used for DOM-to-source mapping. */
  sourceBody?: string
  /** Character offset where sourceBody begins in the full Markdown file. */
  sourceOffset?: number
  /**
   * Absolute path of the markdown file being rendered. Used to
   * resolve relative image references against the file's own
   * directory (Obsidian-style), so e.g. `../assets/x.png` works.
   * Optional — when omitted, image paths fall back to wiki-root
   * resolution.
   */
  filePath?: string
}

/**
 * Read-only render of a wiki page body. Distinct from WikiEditor
 * (Milkdown WYSIWYG) because Milkdown round-trips the markdown
 * through prosemirror — applying our wikilink → markdown-link
 * pre-processing there would mean the user's saves overwrite the
 * original `[[…]]` source with `[label](#slug)`. Here, since we
 * never serialize back to disk, transforming for display is safe.
 *
 * Wikilink anchor clicks are intercepted: `#slug` is resolved
 * against the project's wiki tree and routed to the wiki preview,
 * giving the user single-click navigation between pages.
 */
export function WikiReader({ body, sourceBody, sourceOffset = 0, filePath }: WikiReaderProps) {
  const { t } = useTranslation()
  const appDialog = useAppDialog()
  const project = useWikiStore((s) => s.project)
  const projectPathIndex = useWikiStore((s) => s.projectPathIndex)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const pendingHeading = useWikiStore((s) => s.pendingScrollHeading)
  const setPendingHeading = useWikiStore((s) => s.setPendingScrollHeading)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const pendingImage = useWikiStore((s) => s.pendingScrollImageSrc)
  const setPendingImage = useWikiStore((s) => s.setPendingScrollImageSrc)
  const readerRef = useRef<HTMLDivElement>(null)
  const projectPath = project ? normalizePath(project.path) : null
  const referencePaths = useMemo(() => {
    const paths = new Map<string, string>()
    if (!projectPath) return paths
    for (const match of body.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) {
      const ref = match[1].trim()
      const target = resolveReaderLink(projectPathIndex, `#${encodeURIComponent(ref)}`, filePath, projectPath)
      if (target) paths.set(ref, target.path)
    }
    for (const [ref] of body.matchAll(PREPARED_REFERENCE_PATTERN)) {
      const target = resolveSourceReference(projectPathIndex, ref, `${projectPath}/raw/sources`)
      if (target.kind === "local" && normalizePath(target.path).startsWith(`${projectPath}/raw/sources/`)) paths.set(ref, target.path)
    }
    return paths
  }, [body, projectPath, projectPathIndex, filePath])
  const titlePaths = useMemo(() => [...referencePaths.values()], [referencePaths])
  const titles = useReferenceTitles(titlePaths)

  // Image embeds (`![[…]]`) must be rewritten BEFORE the generic
  // wikilink pass, otherwise the embed target gets mangled into a
  // `#fragment` link.
  const transformed = useMemo(
    () => transformWikilinks(transformImageEmbeds(body)),
    [body],
  )
  const sourceLineStarts = useMemo(() => {
    if (sourceBody === undefined) return null
    const starts = [0]
    for (let index = 0; index < sourceBody.length; index += 1) {
      if (sourceBody.charCodeAt(index) === 10) starts.push(index + 1)
    }
    return starts
  }, [sourceBody])

  const sourceAttrs = (node: unknown): Record<string, number> => {
    if (!sourceLineStarts) return {}
    const position = (node as { position?: { start?: { line?: number }; end?: { line?: number } } } | undefined)?.position
    const startLine = position?.start?.line
    const endLine = position?.end?.line
    if (!startLine || !endLine) return {}
    const start = sourceLineStarts[startLine - 1]
    const end = sourceLineStarts[endLine] ?? sourceBody?.length
    if (start === undefined || end === undefined) return {}
    return { "data-source-start": sourceOffset + start, "data-source-end": sourceOffset + end }
  }
  const renderLanguage = detectLanguage(body)
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)
  // Directory of the file being rendered (project-absolute), so
  // relative image srcs resolve against it like Obsidian does.
  const currentFileDir = useMemo(() => {
    if (!filePath) return null
    const norm = normalizePath(filePath)
    const dir = norm.slice(0, norm.lastIndexOf("/"))
    return dir || null
  }, [filePath])

  useEffect(() => {
    if (!pendingHeading || pendingHeading.path !== filePath || selectedFile !== filePath) return
    const headings = readerRef.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")
    const target = headings && findReaderHeading(Array.from(headings), pendingHeading.anchor)
    // Preview content loads asynchronously. Keep the file-bound request until
    // its heading actually renders; later navigation clears stale requests.
    if (!target) return
    target.scrollIntoView({ behavior: "auto", block: "start" })
    setPendingHeading(null)
  }, [pendingHeading, selectedFile, filePath, body, setPendingHeading])

  useEffect(() => {
    if (!pendingImage || !readerRef.current) return
    const src = readerImageScrollSource(pendingImage, filePath, selectedFile)
    if (!src) return
    const target = findReaderImage(Array.from(readerRef.current.querySelectorAll<HTMLImageElement>("img[data-mdsrc]")), src, projectPath, currentFileDir)
    const consumed = () => {
      // A load from an old render must not clear a newer navigation request.
      if (useWikiStore.getState().pendingScrollImageSrc === pendingImage) setPendingImage(null)
    }
    if (!target) { consumed(); return }
    return scrollReaderImage(target, consumed, readerRef.current)
  }, [pendingImage, filePath, selectedFile, body, projectPath, currentFileDir, setPendingImage])

  function handleAnchorClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    // Explicit web links keep their existing behavior. Every filesystem-like
    // href is intercepted, including invalid/unindexed paths, so the WebView
    // cannot navigate to an unchecked file or custom protocol as a fallback.
    if (/^https?:\/\//i.test(href)) return
    e.preventDefault()
    if (!projectPath) return
    if (href.startsWith("#")) {
      try {
        const anchor = decodeURIComponent(href.slice(1))
        const headings = readerRef.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")
        const local = headings && findReaderHeading(Array.from(headings), anchor)
        if (local) { local.scrollIntoView({ behavior: "auto", block: "start" }); return }
      } catch { return }
    }
    const target = resolveReaderLink(projectPathIndex, href, filePath, projectPath)
    if (target?.anchor) openPathInPreview(target.path, target.anchor)
    else if (target) openPathInPreview(target.path)
  }

  // Navigation and title updates must not replace paragraph/image component
  // types: replacing them detaches the image that the pending scroll awaits.
  const renderContext = useRef({ sourceAttrs, handleAnchorClick, titles, referencePaths, appDialog, openPathInPreview, projectPath, currentFileDir, t })
  renderContext.current = { sourceAttrs, handleAnchorClick, titles, referencePaths, appDialog, openPathInPreview, projectPath, currentFileDir, t }
  const components = useMemo<Components>(() => ({
          details: ({ node: _node, children, ...props }) => <details {...props} className="not-prose my-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground [&_p]:my-2">{children}</details>,
          summary: ({ node: _node, children, ...props }) => <summary {...props} className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">{children}</summary>,
          p: ({ node, children, ...props }) => <p {...renderContext.current.sourceAttrs(node)} {...props}>{children}</p>,
          li: ({ node, children, ...props }) => <li {...renderContext.current.sourceAttrs(node)} {...props}>{children}</li>,
          blockquote: ({ node, children, ...props }) => <blockquote {...renderContext.current.sourceAttrs(node)} {...props}>{children}</blockquote>,
          a: ({ href, children, ...props }) => {
            const h = typeof href === "string" ? href : ""
            const isWikilink = h.startsWith("#")
            let label = children
            if (isWikilink && typeof children === "string") {
              try {
                const ref = decodeURIComponent(h.slice(1))
                // Explicit aliases and ordinary Markdown labels stay intact.
                if (children === ref) label = referenceLabel(ref, renderContext.current.titles[renderContext.current.referencePaths.get(ref) ?? ""])
              } catch { /* Keep malformed link text unchanged. */ }
            }
            return (
              <a
                href={h || undefined}
                onClick={(e) => renderContext.current.handleAnchorClick(e, h)}
                className={
                  isWikilink
                    ? "cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                    : "text-primary underline underline-offset-2"
                }
                {...props}
              >
                {label}
              </a>
            )
          },
          span: ({ node, children, ...props }) => {
            const properties = node?.properties ?? {}
            const locator = properties["data-reader-locator"] ?? properties.dataReaderLocator
            const source = properties["data-reader-source"] ?? properties.dataReaderSource
            if (typeof locator === "string") {
              const matches = locator.split(" — ").map((part) => part.match(/^(epub-spine|pdf-page):(\d+)\/block:(\d+)$/))
              if (matches.length <= 2 && matches.every((match) => match !== null)) {
                const description = matches.map((match) => renderContext.current.t(match![1] === "epub-spine" ? "reader.epubLocator" : "reader.pdfLocator", { item: match![2], block: match![3] })).join(" — ")
                return <button type="button" className="not-prose mx-0.5 inline rounded bg-primary/5 px-1 text-xs font-normal text-primary hover:bg-primary/15" title={description}
                  aria-label={`${renderContext.current.t("reader.locator")} ${String(children)}`}
                  onClick={() => void renderContext.current.appDialog.alert({ title: renderContext.current.t("reader.locator"), message: `${description}\n\n${locator}` })}>{children}</button>
              }
            }
            if (typeof source === "string") {
              const target = renderContext.current.referencePaths.get(source)
              const label = referenceLabel(source, renderContext.current.titles[target ?? ""])
              return target
                ? <button type="button" className="not-prose cursor-pointer text-primary underline decoration-primary/40 underline-offset-2" title={source} onClick={() => renderContext.current.openPathInPreview(target)}>{label}</button>
                : <span title={source}>{label}</span>
            }
            return <span {...props}>{children}</span>
          },
          h1: ({ node, children, ...props }) => (
            <h1
              {...renderContext.current.sourceAttrs(node)}
              className="mb-4 mt-0 border-b border-border/60 pb-3 text-3xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ node, children, ...props }) => (
            <h2
              {...renderContext.current.sourceAttrs(node)}
              className="mb-3 mt-8 border-b border-border/40 pb-2 text-2xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ node, children, ...props }) => (
            <h3
              {...renderContext.current.sourceAttrs(node)}
              className="mb-2 mt-6 text-xl font-semibold leading-snug tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h3>
          ),
          img: ({ src, alt, ...props }) => (
            <img
              src={
                typeof src === "string"
                  ? resolveMarkdownImageSrc(src, renderContext.current.projectPath, renderContext.current.currentFileDir)
                  : undefined
              }
              data-mdsrc={typeof src === "string" ? src : undefined}
              alt={alt ?? ""}
              className="max-w-full rounded border border-border/40"
              loading="lazy"
              {...props}
            />
          ),
          table: ({ children, ...props }) => (
            <div className="my-2 overflow-x-auto rounded border border-border">
              <table className="w-full border-collapse text-xs" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="bg-muted" {...props}>
              {children}
            </thead>
          ),
          th: ({ node, children, ...props }) => (
            <th
              {...renderContext.current.sourceAttrs(node)}
              className="border border-border/80 bg-muted px-3 py-1.5 text-start font-semibold"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ node, children, ...props }) => (
            <td {...renderContext.current.sourceAttrs(node)} className="border border-border/60 px-3 py-1.5" {...props}>
              {children}
            </td>
          ),
          pre: ({ children, ...props }) => {
            const mermaid = unwrapMermaidPre(children)
            if (mermaid) return <>{mermaid}</>
            return <pre dir="ltr" style={{ textAlign: "left" }} {...props}>{children}</pre>
          },
          code: ({ className, children, ...props }) => {
            const lang = className?.replace("language-", "")
            const codeText = String(children).replace(/\n$/, "")
            if (lang === "mermaid") return <MermaidDiagram code={codeText} />
            return <code dir="ltr" className={className} {...props}>{children}</code>
          },
  }), [])

  return (
    <div
      ref={readerRef}
      className="prose prose-invert min-w-0 max-w-none"
      dir={direction}
      lang={htmlLang}
      style={{ textAlign: "start" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCjkFriendly, [remarkReaderLayout, { evidenceLabel: t("reader.evidenceDetails", { defaultValue: "Evidence & source details" }) }], remarkHideSourceLocations, remarkReaderReferences]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {transformed}
      </ReactMarkdown>
    </div>
  )
}
