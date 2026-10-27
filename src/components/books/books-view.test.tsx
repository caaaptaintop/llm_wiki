import type { ReactElement, ReactNode } from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { BookManifest, BookTopicSuggestion } from "@/lib/book-workflow"
import type { WikiProject } from "@/types/wiki"

// Exercise handlers and async boundaries without adding a DOM dependency.
// This hook harness does not claim browser layout or React lifecycle coverage.
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value
    }]
  },
  useRef: (current: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current }
    return hooks.slots[index]
  },
  useEffect: (effect: () => void | (() => void)) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) { hooks.slots[index] = true; hooks.effects.push(effect) }
  },
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, values?: unknown) => key + (values ? JSON.stringify(values) : ""),
}) }))
vi.mock("@/components/ui/button", () => ({ Button: "button" }))
vi.mock("@/components/ui/input", () => ({ Input: "input" }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("@/lib/book-workflow", () => ({
  listBooks: vi.fn(), prepareBook: vi.fn(), processBook: vi.fn(), synthesizeBooks: vi.fn(), discoverBookTopics: vi.fn(),
}))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn() }))

const context = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<(state: Record<string, unknown>) => void>(),
  config: { provider: "codex-cli", apiKey: "", model: "test" },
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign((selector: (state: typeof context.state) => unknown) => selector(context.state), {
    getState: () => context.state,
    subscribe: (listener: (state: typeof context.state) => void) => {
      context.listeners.add(listener)
      return () => context.listeners.delete(listener)
    },
  }),
}))
vi.mock("@/lib/llm-task-routing", () => ({
  getTaskLlmConfig: vi.fn(() => context.config),
  resolveTaskLlmConfig: vi.fn(() => context.config),
}))

import { open } from "@tauri-apps/plugin-dialog"
import { listBooks, prepareBook, processBook, synthesizeBooks, discoverBookTopics } from "@/lib/book-workflow"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { BooksView } from "./books-view"

type Element = ReactElement<Record<string, unknown>>
let tree: ReactNode
let cleanup: (() => void)[] = []
const project: WikiProject = { id: "a", path: "/project-a", name: "A" }

function book(id = "one", status: BookManifest["status"] = "prepared"): BookManifest {
  return {
    version: 1, id, title: id, status, revision: "version-one", sourceHash: "source",
    sourcePath: `raw/books/${id}/source.md`, parsedPath: `raw/books/${id}/source.md`,
    overviewPath: `wiki/books/${id}/overview.md`, updatedAt: "2026-10-26", warnings: ["Check pagination"],
    chapters: [{
      id: "chapter-1", index: 1, title: "Chapter One", kind: "chapter", textPath: `raw/books/${id}/chapter.md`,
      notesPath: `wiki/books/${id}/notes.md`, status: status === "complete" ? "complete" : "pending",
      evidenceCount: status === "complete" ? 2 : 0, lineStart: 3, lineEnd: 12, pdfPageStart: 1, pdfPageEnd: 2,
    }],
  }
}

function render() {
  hooks.cursor = 0
  const root = BooksView() as ReactElement<{ project: WikiProject }>
  tree = typeof root.type === "function"
    ? (root.type as (props: typeof root.props) => ReactNode)(root.props)
    : root
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  render()
}
async function mount(books = [book()]) {
  vi.mocked(listBooks).mockResolvedValue(books)
  render()
  cleanup = hooks.effects.splice(0).map((effect) => effect()).filter((value): value is () => void => typeof value === "function")
  await settle()
  vi.mocked(refreshProjectFileTree).mockClear()
}
function nodes(node: ReactNode = tree): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null))
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [element, ...nodes(element.props.children as ReactNode ?? null)]
}
function text(node: ReactNode = tree): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("")
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode ?? null)
  return ""
}
function button(key: string) {
  const result = nodes().find((node) => node.type === "button" && text(node).startsWith(key))
  if (!result) throw new Error(`Button not found: ${key}`)
  return result.props as { disabled?: boolean; onClick: () => void }
}
function deferred<T>() {
  let resolve!: (result: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function switchProject(next: WikiProject) {
  context.state.project = next
  for (const listener of context.listeners) listener(context.state)
}

function checkMaterial(index: number, checked = true) {
  const checkbox = nodes().filter((node) => node.type === "input" && node.props.type === "checkbox")[index]
  expect(checkbox.props.disabled).toBe(false)
  ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked } })
  render()
}

const discoveredTopic: BookTopicSuggestion = {
  title: "共同议题", rationale: "比较长期论证与近期观察的差异。", sourceIds: ["one", "two"], evidenceIds: ["ev-one", "ev-two"],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(refreshProjectFileTree).mockReset().mockResolvedValue(undefined)
  vi.mocked(discoverBookTopics).mockReset().mockResolvedValue([])
  hooks.slots = []; hooks.effects = []; hooks.cursor = 0
  context.listeners.clear()
  context.config = { provider: "codex-cli", apiKey: "", model: "test" }
  context.state = {
    project, llmConfig: context.config, providerConfigs: {}, taskModelRouting: {}, projectLlmOverride: {}, customLlmPresets: [],
    openPathInPreview: vi.fn(), setActiveView: vi.fn(),
  }
  cleanup = []
})
afterEach(() => { for (const dispose of cleanup) dispose() })

describe("BooksView", () => {
  it("routes the default import workflow to Sources without starting evidence processing", async () => {
    await mount([book("one", "complete")])
    button("books.goToSources").onClick()
    expect(context.state.setActiveView).toHaveBeenCalledWith("sources")
    expect(prepareBook).not.toHaveBeenCalled()
    expect(processBook).not.toHaveBeenCalled()
    expect(discoverBookTopics).not.toHaveBeenCalled()
    expect(synthesizeBooks).not.toHaveBeenCalled()
    expect(text()).toContain("one")
  })

  it("imports the external path through prepareBook and excludes processing while the dialog is open", async () => {
    await mount()
    const dialog = deferred<string | null>()
    vi.mocked(open).mockReturnValue(dialog.promise)
    vi.mocked(prepareBook).mockResolvedValue(book("imported"))
    button("books.import").onClick()
    await settle()
    expect(button("books.process").disabled).toBe(true)
    button("books.process").onClick() // The imperative lock also guards rapid/stale clicks.
    expect(processBook).not.toHaveBeenCalled()
    expect(vi.mocked(open).mock.calls[0][0]?.filters?.[0].extensions).toEqual(["md", "markdown", "txt"])
    dialog.resolve("/outside/book.cleaned.md")
    await settle()
    expect(prepareBook).toHaveBeenCalledWith(project.path, "/outside/book.cleaned.md")
    expect(refreshProjectFileTree).toHaveBeenCalledWith(project.path, { projectId: project.id, bumpDataVersion: true })
    expect(text()).toContain("imported")
    expect(button("books.import").disabled).toBe(false)
  })

  it("shows import errors and releases the operation lock", async () => {
    await mount()
    vi.mocked(open).mockResolvedValue("/outside/new.txt")
    vi.mocked(prepareBook).mockRejectedValue(new Error("cannot read source"))
    button("books.import").onClick()
    await settle()
    expect(text()).toContain("cannot read source")
    expect(button("books.import").disabled).toBe(false)
    expect(button("books.process").disabled).toBe(false)
  })

  it("uses ingest routing, accepts a CLI model without an API key, and renders live chapter progress", async () => {
    await mount()
    const processing = deferred<BookManifest>()
    vi.mocked(processBook).mockReturnValue(processing.promise)
    button("books.process").onClick()
    expect(getTaskLlmConfig).toHaveBeenCalledWith("ingest")
    const options = vi.mocked(processBook).mock.calls[0][3]!
    const progress = book("one", "processing")
    progress.chapters[0] = { ...progress.chapters[0], status: "complete", evidenceCount: 7 }
    options.onProgress?.(progress)
    await settle()
    expect(text()).toContain('books.progress{"done":1,"total":1}')
    expect(text()).toContain("books.pdfPages")
    expect(text()).toContain("Check pagination")
    expect(button("books.import").disabled).toBe(true)
    processing.resolve(book("one", "partial"))
    await settle()
    expect(text()).toContain("books.incomplete")
    expect(text()).not.toContain("books.completed")
    expect(button("books.import").disabled).toBe(false)
    expect(refreshProjectFileTree).toHaveBeenCalledWith(project.path, { projectId: project.id, bumpDataVersion: true })
  })

  it("cancels processing and reloads saved progress before allowing another operation", async () => {
    await mount()
    const processing = deferred<BookManifest>()
    vi.mocked(processBook).mockReturnValue(processing.promise)
    button("books.process").onClick()
    await settle()
    const signal = vi.mocked(processBook).mock.calls[0][3]!.signal!
    button("common.cancel").onClick()
    expect(signal.aborted).toBe(true)
    await settle()
    expect(button("books.import").disabled).toBe(true)
    processing.reject(new Error("AbortError"))
    await settle()
    expect(listBooks).toHaveBeenCalledTimes(2)
    expect(text()).toContain("books.cancelled")
    expect(text()).not.toContain("books.completed")
    expect(button("books.import").disabled).toBe(false)
  })

  it("keeps processing failures visible and releases the lock even if progress reload also fails", async () => {
    await mount()
    vi.mocked(processBook).mockRejectedValue(new Error("model failed"))
    vi.mocked(listBooks).mockRejectedValue(new Error("reload failed"))
    button("books.process").onClick()
    await settle()
    expect(text()).toContain("model failed")
    expect(text()).not.toContain("books.completed")
    expect(button("books.import").disabled).toBe(false)
  })

  it("aborts on project switch and ignores late progress and completion", async () => {
    await mount()
    const processing = deferred<BookManifest>()
    vi.mocked(processBook).mockReturnValue(processing.promise)
    button("books.process").onClick()
    const options = vi.mocked(processBook).mock.calls[0][3]!
    switchProject({ id: "b", path: "/project-b", name: "B" })
    expect(options.signal?.aborted).toBe(true)
    // Returning to the old project must not revive the invalidated operation.
    switchProject(project)
    options.onProgress?.(book("late-result", "complete"))
    processing.resolve(book("late-result", "complete"))
    await settle()
    expect(text()).not.toContain("late-result")
    expect(listBooks).toHaveBeenCalledTimes(1)
    expect(refreshProjectFileTree).not.toHaveBeenCalled()
  })

  it("aborts on unmount and does not prepare an import chosen afterwards", async () => {
    await mount()
    const dialog = deferred<string | null>()
    vi.mocked(open).mockReturnValue(dialog.promise)
    button("books.import").onClick()
    for (const dispose of cleanup) dispose()
    dialog.resolve("/outside/new.markdown")
    await settle()
    expect(prepareBook).not.toHaveBeenCalled()
  })

  it("opens project-relative chapter files through the existing preview API", async () => {
    await mount([book("one", "complete")])
    button("books.notes").onClick()
    expect(context.state.openPathInPreview).toHaveBeenCalledWith("/project-a/wiki/books/one/notes.md")
  })

  it.each([undefined, "", "原材料.pdf"])("shows an available original filename as plain identity text: %s", async (originalFilename) => {
    const saved = Object.assign(book(), {
      preparation: { path: "raw/books/one/manifest.json", hash: "manifest-hash", originalFilename, originalHash: "original-hash" },
    })
    await mount([saved])
    const identity = nodes().find((node) => node.type === "p" && text(node).startsWith("books.originalMaterial"))
    if (originalFilename) {
      expect(identity).toBeDefined()
      expect(text(identity)).toContain(originalFilename)
      expect(nodes(identity).some((node) => node.type === "a" || node.type === "button")).toBe(false)
    } else expect(identity).toBeUndefined()
    expect(text()).not.toContain("original-hash")
    button("books.original").onClick()
    expect(context.state.openPathInPreview).toHaveBeenCalledWith("/project-a/raw/books/one/source.md")
  })

  it.each(["complete", "switch", "failure"] as const)("requires two completed books and handles synthesis outcome: %s", async (outcome) => {
    const malformed = book("incomplete", "complete")
    malformed.chapters[0].status = "error"
    await mount([book("one", "complete"), book("two", "complete"), malformed])
    const checkboxes = nodes().filter((node) => node.type === "input" && node.props.type === "checkbox")
    expect(checkboxes[2].props.disabled).toBe(true)
    expect(text(nodes().find((node) => node.type === "button" && text(node).startsWith("incomplete")))).toContain("books.status.partial")
    const topic = nodes().find((node) => node.props.id === "books-topic")!
    ;(topic.props.onChange as (event: unknown) => void)({ target: { value: "  shared ideas  " } })
    ;(checkboxes[0].props.onChange as (event: unknown) => void)({ target: { checked: true } })
    render()
    expect(button("books.synthesize").disabled).toBe(true)
    ;(checkboxes[1].props.onChange as (event: unknown) => void)({ target: { checked: true } })
    render()
    expect(button("books.synthesize").disabled).toBe(false)
    const synthesis = deferred<string>()
    vi.mocked(synthesizeBooks).mockReturnValue(synthesis.promise)
    const form = nodes().find((node) => node.type === "form")!
    ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() })
    expect(synthesizeBooks).toHaveBeenCalledWith(project.path, ["one", "two"], "shared ideas", context.config, { signal: expect.any(AbortSignal) })
    if (outcome === "switch") {
      switchProject({ id: "b", path: "/project-b", name: "B" })
      expect(vi.mocked(synthesizeBooks).mock.calls[0][4]?.signal?.aborted).toBe(true)
    }
    if (outcome === "failure") synthesis.reject(new Error("synthesis failed"))
    else synthesis.resolve("wiki/synthesis/shared.md")
    // Keep this harness on the old view while exercising its late completion.
    if (outcome === "switch") switchProject(project)
    await settle()
    if (outcome === "complete") {
      expect(context.state.openPathInPreview).toHaveBeenCalledWith("/project-a/wiki/synthesis/shared.md")
      expect(refreshProjectFileTree).toHaveBeenCalledWith(project.path, { projectId: project.id, bumpDataVersion: true })
    } else {
      expect(context.state.openPathInPreview).not.toHaveBeenCalled()
      expect(refreshProjectFileTree).not.toHaveBeenCalled()
      if (outcome === "failure") {
        expect(text()).toContain("synthesis failed")
        expect(button("books.import").disabled).toBe(false)
      }
    }
  })

  it("discovers without a typed topic and synthesizes only the candidate's completed-source subset", async () => {
    await mount([
      { ...book("one", "complete"), title: "一本书" },
      { ...book("two", "complete"), title: "一份报告" },
      { ...book("three", "complete"), title: "一则短笔记" },
    ])
    expect(button("books.discoverTopics").disabled).toBe(true)
    checkMaterial(0)
    expect(button("books.discoverTopics").disabled).toBe(true)
    checkMaterial(1)
    checkMaterial(2)
    expect(button("books.discoverTopics").disabled).toBe(false)
    expect(button("books.synthesize").disabled).toBe(true)
    expect(discoverBookTopics).not.toHaveBeenCalled() // No automatic background LLM work.
    vi.mocked(discoverBookTopics).mockResolvedValue([
      { ...discoveredTopic, sourceIds: ["one", "three"] },
      { ...discoveredTopic, title: "Single source", sourceIds: ["one"] },
      { ...discoveredTopic, title: "Unselected source", sourceIds: ["one", "outside"] },
    ])
    button("books.discoverTopics").onClick()
    await settle()
    expect(discoverBookTopics).toHaveBeenCalledWith(project.path, ["one", "two", "three"], context.config, { signal: expect.any(AbortSignal) })
    expect(getTaskLlmConfig).toHaveBeenCalledWith("ingest")
    const cards = nodes().filter((node) => node.type === "article")
    expect(cards).toHaveLength(1)
    expect(text(cards[0])).toContain(discoveredTopic.rationale)
    expect(text(cards[0])).toContain('books.relatedMaterials{"total":2}')
    expect(text(cards[0])).toContain("一本书 · 一则短笔记")
    expect(text(cards[0])).not.toContain("一份报告")
    vi.mocked(synthesizeBooks).mockResolvedValue("wiki/synthesis/subset.md")
    button("books.generateTopic").onClick()
    await settle()
    expect(synthesizeBooks).toHaveBeenCalledWith(project.path, ["one", "three"], discoveredTopic.title, context.config, { signal: expect.any(AbortSignal) })
    expect(context.state.openPathInPreview).toHaveBeenCalledWith("/project-a/wiki/synthesis/subset.md")
  })

  it.each(["selection", "reload", "import"] as const)("clears discovered topics on %s without automatically discovering again", async (change) => {
    await mount([book("one", "complete"), book("two", "complete")])
    checkMaterial(0)
    checkMaterial(1)
    vi.mocked(discoverBookTopics).mockResolvedValue([discoveredTopic])
    button("books.discoverTopics").onClick()
    await settle()
    expect(text()).toContain(discoveredTopic.title)
    if (change === "selection") checkMaterial(1, false)
    else if (change === "reload") button("books.refresh").onClick()
    else {
      vi.mocked(open).mockResolvedValue(null)
      button("books.import").onClick()
    }
    await settle()
    expect(nodes().filter((node) => node.type === "article")).toHaveLength(0)
    expect(text()).not.toContain(discoveredTopic.title)
    expect(discoverBookTopics).toHaveBeenCalledTimes(1)
  })

  it.each(["cancel", "project", "unmount"] as const)("aborts discovery and ignores late results after %s", async (reason) => {
    await mount([book("one", "complete"), book("two", "complete")])
    checkMaterial(0)
    checkMaterial(1)
    const discovery = deferred<BookTopicSuggestion[]>()
    vi.mocked(discoverBookTopics).mockReturnValue(discovery.promise)
    button("books.discoverTopics").onClick()
    await settle()
    expect(button("books.import").disabled).toBe(true)
    expect(button("books.discoverTopics").disabled).toBe(true)
    button("books.discoverTopics").onClick()
    expect(discoverBookTopics).toHaveBeenCalledTimes(1)
    const signal = vi.mocked(discoverBookTopics).mock.calls[0][3]?.signal
    if (reason === "cancel") button("common.cancel").onClick()
    else if (reason === "project") {
      switchProject({ id: "b", path: "/project-b", name: "B" })
      switchProject(project)
    } else for (const dispose of cleanup) dispose()
    expect(signal?.aborted).toBe(true)
    discovery.resolve([discoveredTopic])
    await settle()
    expect(text()).not.toContain(discoveredTopic.title)
    expect(context.state.openPathInPreview).not.toHaveBeenCalled()
    expect(refreshProjectFileTree).not.toHaveBeenCalled()
    if (reason === "cancel") {
      expect(text()).toContain("books.cancelled")
      expect(button("books.import").disabled).toBe(false)
    }
  })

  it.each(["empty", "failure"] as const)("reports a discovery %s and releases the operation lock", async (outcome) => {
    await mount([book("one", "complete"), book("two", "complete")])
    checkMaterial(0)
    checkMaterial(1)
    if (outcome === "failure") vi.mocked(discoverBookTopics).mockRejectedValue(new Error("discovery failed"))
    button("books.discoverTopics").onClick()
    await settle()
    expect(text()).toContain(outcome === "empty" ? "books.noTopics" : "discovery failed")
    expect(button("books.import").disabled).toBe(false)
    expect(nodes().filter((node) => node.type === "article")).toHaveLength(0)
  })

  it("guides a missing hosted-model configuration to settings", async () => {
    context.config.provider = "openai"
    await mount()
    expect(button("books.process").disabled).toBe(true)
    button("books.settings").onClick()
    expect(context.state.setActiveView).toHaveBeenCalledWith("settings")
  })
})
