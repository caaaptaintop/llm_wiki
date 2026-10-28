import { useEffect, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { BookOpen, Loader2, Plus, RefreshCw, Square } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import {
  listBooks, prepareBook, processBook, synthesizeBooks, discoverBookTopics,
  type BookManifest, type BookTopicSuggestion,
} from "@/lib/book-workflow"
import { getTaskLlmConfig, resolveTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { isAbsolutePath, joinPath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

function isComplete(book: BookManifest) {
  return book.status === "complete" && book.chapters.length > 0
    && book.chapters.every((chapter) => chapter.status === "complete")
}

export function BooksView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  if (!project) return <div className="p-8 text-muted-foreground">{t("books.noProject")}</div>
  // Project-local state and in-flight work must never survive a project switch.
  return <ProjectBooks key={`${project.id}:${project.path}`} project={project} />
}

function ProjectBooks({ project }: { project: WikiProject }) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const routing = useWikiStore((s) => s.taskModelRouting)
  const projectOverride = useWikiStore((s) => s.projectLlmOverride)
  const customPresets = useWikiStore((s) => s.customLlmPresets)
  const llmReady = hasUsableLlm(resolveTaskLlmConfig(
    "ingest", llmConfig, providerConfigs, routing, projectOverride, customPresets,
  ))
  const [books, setBooks] = useState<BookManifest[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chosenIds, setChosenIds] = useState<string[]>([])
  const [topic, setTopic] = useState("")
  const [suggestions, setSuggestions] = useState<BookTopicSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<"import" | "process" | "discover" | "synthesize" | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(false)
  const loadingRef = useRef(false)
  const pending = useRef<AbortController | null>(null)
  const busy = loading || operation !== null
  const selected = books.find((book) => book.id === selectedId) ?? books[0]
  const eligibleIds = chosenIds.filter((id) => books.some((book) => book.id === id && isComplete(book)))

  function isCurrent() {
    const current = useWikiStore.getState().project
    return mounted.current && current?.id === project.id && current.path === project.path
  }

  function updateBook(book: BookManifest) {
    setBooks((current) => current.some((item) => item.id === book.id)
      ? current.map((item) => item.id === book.id ? book : item)
      : [...current, book])
  }

  async function refreshFiles() {
    if (!isCurrent()) return
    try {
      await refreshProjectFileTree(project.path, { projectId: project.id, bumpDataVersion: true })
    } catch (err) {
      if (isCurrent()) setError((previous) => previous ?? t("books.failed", { message: String(err) }))
    }
  }

  async function reload() {
    if (!isCurrent() || loadingRef.current || pending.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    setSuggestions([])
    setNotice(null)
    try {
      const result = await listBooks(project.path)
      if (isCurrent()) {
        setBooks(result)
        await refreshFiles()
      }
    } catch (err) {
      if (isCurrent()) setError(t("books.failed", { message: String(err) }))
    } finally {
      loadingRef.current = false
      if (isCurrent()) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    // Invalidate immediately, even before React commits the new project view.
    const unsubscribe = useWikiStore.subscribe((state) => {
      if (state.project?.id !== project.id || state.project.path !== project.path) {
        mounted.current = false
        pending.current?.abort()
      }
    })
    void reload()
    return () => {
      mounted.current = false
      pending.current?.abort()
      unsubscribe()
    }
  }, [project.id, project.path])

  function start(kind: NonNullable<typeof operation>) {
    if (!isCurrent() || loadingRef.current || pending.current) return null
    const controller = new AbortController()
    pending.current = controller
    setOperation(kind)
    setCancelling(false)
    setError(null)
    setNotice(null)
    if (kind !== "synthesize") setSuggestions([])
    return controller
  }

  function finish(controller: AbortController) {
    if (pending.current !== controller) return
    pending.current = null
    if (isCurrent()) {
      setOperation(null)
      setCancelling(false)
    }
  }

  async function handleImport() {
    const controller = start("import")
    if (!controller) return
    try {
      const sourcePath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t("books.fileFilter"), extensions: ["md", "markdown", "txt"] }],
      })
      if (!sourcePath || Array.isArray(sourcePath) || !isCurrent() || controller.signal.aborted) return
      const book = await prepareBook(project.path, sourcePath)
      if (!isCurrent() || controller.signal.aborted) return
      updateBook(book)
      setSelectedId(book.id)
      await refreshFiles()
    } catch (err) {
      if (isCurrent()) setError(t("books.failed", { message: String(err) }))
    } finally {
      finish(controller)
    }
  }

  async function handleProcess() {
    if (!selected) return
    const config = getTaskLlmConfig("ingest")
    if (!hasUsableLlm(config)) { setError(t("books.configureLlm")); return }
    const controller = start("process")
    if (!controller) return
    try {
      const result = await processBook(project.path, selected.id, config, {
        signal: controller.signal,
        onProgress: (book) => {
          if (isCurrent() && !controller.signal.aborted) updateBook(book)
        },
      })
      if (!isCurrent()) return
      updateBook(result)
      if (!controller.signal.aborted) {
        if (isComplete(result)) setNotice(t("books.completed"))
        else setError(t("books.incomplete"))
      }
    } catch (err) {
      if (isCurrent() && !controller.signal.aborted) setError(t("books.failed", { message: String(err) }))
    } finally {
      // Re-read persisted progress after a failure or cancellation. A cancelled
      // call may have saved additional chapters since its last callback.
      if (isCurrent()) {
        try {
          const result = await listBooks(project.path)
          if (isCurrent()) setBooks(result)
        } catch (err) {
          if (isCurrent()) setError((previous) => previous ?? t("books.failed", { message: String(err) }))
        }
        await refreshFiles()
        if (isCurrent() && controller.signal.aborted) setNotice(t("books.cancelled"))
      }
      finish(controller)
    }
  }

  function openPreview(path: string) {
    if (!path || !isCurrent()) return
    useWikiStore.getState().openPathInPreview(isAbsolutePath(path) ? path : joinPath(project.path, path))
  }

  async function handleDiscover() {
    if (eligibleIds.length < 2) return
    const config = getTaskLlmConfig("ingest")
    if (!hasUsableLlm(config)) { setError(t("books.configureLlm")); return }
    const controller = start("discover")
    if (!controller) return
    try {
      const result = await discoverBookTopics(project.path, eligibleIds, config, { signal: controller.signal })
      if (!isCurrent() || controller.signal.aborted) return
      const allowed = new Set(eligibleIds)
      // A useful theme may cover only part of the selection. Never expand it
      // to unrelated selected material or accept unselected source IDs.
      const valid = result.map((suggestion) => ({
        ...suggestion, title: suggestion.title.trim(), sourceIds: [...new Set(suggestion.sourceIds)],
      })).filter((suggestion) => suggestion.title && suggestion.sourceIds.length >= 2
        && suggestion.sourceIds.every((id) => allowed.has(id)))
      setSuggestions(valid)
      if (valid.length === 0) setNotice(t("books.noTopics"))
    } catch (err) {
      if (isCurrent() && !controller.signal.aborted) setError(t("books.failed", { message: String(err) }))
    } finally {
      if (isCurrent() && controller.signal.aborted) setNotice(t("books.cancelled"))
      finish(controller)
    }
  }

  async function handleSynthesize(suggestion?: BookTopicSuggestion) {
    const sourceIds = suggestion?.sourceIds ?? eligibleIds
    const title = (suggestion?.title ?? topic).trim()
    if (sourceIds.length < 2 || !title || sourceIds.some((id) => !eligibleIds.includes(id))) return
    const config = getTaskLlmConfig("ingest")
    if (!hasUsableLlm(config)) { setError(t("books.configureLlm")); return }
    const controller = start("synthesize")
    if (!controller) return
    try {
      const path = await synthesizeBooks(project.path, sourceIds, title, config, { signal: controller.signal })
      if (isCurrent() && !controller.signal.aborted) {
        if (!path) throw new Error(t("books.noOutput"))
        await refreshFiles()
        if (isCurrent() && !controller.signal.aborted) openPreview(path)
      }
    } catch (err) {
      if (isCurrent() && !controller.signal.aborted) setError(t("books.failed", { message: String(err) }))
    } finally {
      if (isCurrent() && controller.signal.aborted) setNotice(t("books.cancelled"))
      finish(controller)
    }
  }

  function cancel() {
    setCancelling(true)
    pending.current?.abort()
  }

  function bookStatus(book: BookManifest) {
    const status = book.status === "complete" && !isComplete(book) ? "partial" : book.status
    return t(`books.status.${status}`)
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6 lg:px-8" aria-busy={busy}>
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><BookOpen className="size-5" />{t("books.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("books.description")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => useWikiStore.getState().setActiveView("sources")}>{t("books.goToSources")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void reload()}><RefreshCw />{t("books.refresh")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void handleImport()}><Plus />{t("books.import")}</Button>
          </div>
        </header>

        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">{t("books.evidenceHelp")}</p>
        {!llmReady && <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <span>{t("books.configureLlm")}</span>
          <Button variant="outline" onClick={() => useWikiStore.getState().setActiveView("settings")}>{t("books.settings")}</Button>
        </div>}
        {error && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {busy && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {loading ? t("common.loading") : cancelling ? t("books.cancelling") : t(`books.running.${operation}`)}
          {(operation === "process" || operation === "discover" || operation === "synthesize") && <Button size="sm" variant="outline" disabled={cancelling} onClick={cancel}><Square />{t("common.cancel")}</Button>}
        </div>}

        {!loading && books.length === 0 && <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">{t("books.empty")}</div>}
        {books.length > 0 && <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-2" aria-label={t("books.title")}>
            {books.map((book) => <div key={book.id} className={`rounded-lg border p-3 ${selected?.id === book.id ? "border-primary bg-accent/40" : ""}`}>
              <button type="button" className="w-full text-left" onClick={() => setSelectedId(book.id)} aria-pressed={selected?.id === book.id}>
                <span className="block break-words font-medium">{book.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("books.version", { revision: book.revision.slice(0, 12) })} · {bookStatus(book)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("books.progress", { done: book.chapters.filter((chapter) => chapter.status === "complete").length, total: book.chapters.length })}</span>
              </button>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="accent-primary" checked={chosenIds.includes(book.id)} disabled={busy || !isComplete(book)} onChange={(event) => {
                  setSuggestions([])
                  setNotice(null)
                  setChosenIds((ids) => event.target.checked ? [...ids, book.id] : ids.filter((id) => id !== book.id))
                }} />
                {t("books.selectForSynthesis")}
              </label>
            </div>)}
          </aside>

          {selected && <section className="min-w-0 space-y-4" aria-label={selected.title}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="break-words text-lg font-medium">{selected.title}</h2>
                <p className="text-sm text-muted-foreground">{bookStatus(selected)}</p>
                {selected.preparation?.originalFilename && <p className="mt-1 break-words text-xs text-muted-foreground">
                  {t("books.originalMaterial")}: <span>{selected.preparation.originalFilename}</span>
                </p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy || !selected.sourcePath} onClick={() => openPreview(selected.sourcePath)}>{t("books.original")}</Button>
                <Button variant="outline" disabled={busy || !selected.parsedPath} onClick={() => openPreview(selected.parsedPath)}>{t("books.fullText")}</Button>
                <Button variant="outline" disabled={busy || !isComplete(selected) || !selected.overviewPath} onClick={() => openPreview(selected.overviewPath)}>{t("books.overview")}</Button>
                <Button disabled={busy || !llmReady || isComplete(selected) || selected.chapters.length === 0} onClick={() => void handleProcess()}>
                  {selected.chapters.some((chapter) => chapter.status === "error" || chapter.status === "complete") || selected.status !== "prepared" ? t("books.resume") : t("books.process")}
                </Button>
              </div>
            </div>
            {selected.warnings.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <h3 className="font-medium">{t("books.warnings")}</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">{selected.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul>
            </div>}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t("books.chapters")}</caption>
                <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
                  {["chapters", "chapterStatus", "evidence", "location", "files"].map((key) => <th key={key} scope="col" className="px-3 py-2 font-medium">{t(`books.${key}`)}</th>)}
                </tr></thead>
                <tbody>{selected.chapters.map((chapter) => <tr key={chapter.id} className="border-t align-top">
                  <th scope="row" className="min-w-40 px-3 py-3 font-normal"><span>{chapter.index}. {chapter.title}</span>{chapter.error && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">{chapter.error}</p>}</th>
                  <td className="whitespace-nowrap px-3 py-3">{t(`books.status.${chapter.status}`)}</td>
                  <td className="px-3 py-3 tabular-nums">{chapter.evidenceCount}</td>
                  <td className="max-w-64 break-words px-3 py-3 text-xs text-muted-foreground">
                    {chapter.pdfPageStart != null && <p>{t("books.pdfPages", { start: chapter.pdfPageStart, end: chapter.pdfPageEnd ?? chapter.pdfPageStart })}</p>}
                    {chapter.epubPath && <p>{t("books.epubSection", { section: chapter.epubPath })}</p>}
                    <p>{t("books.lines", { start: chapter.lineStart, end: chapter.lineEnd })}</p>
                  </td>
                  <td className="px-3 py-2"><div className="flex gap-1">
                    <Button size="xs" variant="outline" disabled={busy || !chapter.textPath} onClick={() => openPreview(chapter.textPath)} aria-label={t("books.openChapter", { title: chapter.title })}>{t("books.chapterText")}</Button>
                    <Button size="xs" variant="outline" disabled={busy || chapter.status !== "complete" || !chapter.notesPath} onClick={() => openPreview(chapter.notesPath)} aria-label={t("books.openNotes", { title: chapter.title })}>{t("books.notes")}</Button>
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>}
        </div>}

        <section className="space-y-3 rounded-xl border p-4">
          <h2 className="font-medium">{t("books.synthesis")}</h2>
          <p className="text-sm text-muted-foreground">{t("books.synthesisHelp")}</p>
          <Button variant="outline" disabled={busy || !llmReady || eligibleIds.length < 2} onClick={() => void handleDiscover()}>{t("books.discoverTopics")}</Button>
          {suggestions.length > 0 && <div className="grid gap-3 md:grid-cols-2" aria-label={t("books.topicSuggestions")}>
            {suggestions.map((suggestion, index) => <article key={`${index}:${suggestion.title}`} className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <h3 className="break-words font-medium">{suggestion.title}</h3>
              <p className="whitespace-pre-wrap break-words text-sm">{suggestion.rationale}</p>
              <p className="break-words text-xs text-muted-foreground">
                {t("books.relatedMaterials", { total: suggestion.sourceIds.length })}: {books.filter((book) => suggestion.sourceIds.includes(book.id)).map((book) => book.title).join(" · ")}
              </p>
              <Button disabled={busy || !llmReady} onClick={() => void handleSynthesize(suggestion)}>{t("books.generateTopic")}</Button>
            </article>)}
          </div>}
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void handleSynthesize() }}>
            <div className="min-w-48 flex-1 space-y-2">
              <label htmlFor="books-topic" className="text-sm">{t("books.topic")}</label>
              <Input id="books-topic" value={topic} disabled={busy} onChange={(event) => setTopic(event.target.value)} placeholder={t("books.topicPlaceholder")} />
            </div>
            <Button type="submit" disabled={busy || !llmReady || eligibleIds.length < 2 || !topic.trim()}>{t("books.synthesize", { total: eligibleIds.length })}</Button>
          </form>
        </section>
      </div>
    </div>
  )
}
