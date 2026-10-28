import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildPageMerger } from "./ingest"
import { mergePageContent } from "./page-merge"
import { useWikiStore } from "@/stores/wiki-store"

const response = vi.hoisted(() => ({ text: "" }))
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_config, _messages, callbacks) => {
    callbacks.onToken(response.text)
    callbacks.onDone()
  }),
}))

const oldPage = '---\ntitle: Curiosity\nsources: ["book.md"]\n---\n# Curiosity\n\nThe observer enters a demonstration room. This is evidence from the book.'
const newPage = '---\ntitle: Curiosity\nsources: ["note.md"]\n---\n# Curiosity\n\nA personal note reflects on curiosity and risk.'
const mergedPage = '---\ntitle: Curiosity\nsources: ["book.md", "note.md"]\n---\n# Curiosity\n\nThe observer enters a demonstration room, according to the book. Separately, a personal note reflects on curiosity and risk. This interpretation does not establish the author’s intention.'
const frame = (body: string) => `---FILE: wiki/merged-page.md---\n${body}\n---END FILE---`

describe("ingest page merge output boundary", () => {
  beforeEach(() => { response.text = "" })

  it("writes only the complete document, excluding CLI status before and after it", async () => {
    response.text = `Preparing merge.\n\n${frame(mergedPage)}\n\n合并稿已交付。会话自动保存未完成：Stop 钩子未找到本会话的 transcript。`
    const output = await mergePageContent(newPage, oldPage, buildPageMerger(useWikiStore.getState().llmConfig), {
      pagePath: "wiki/themes/curiosity.md", sourceFileName: "note.md",
    })
    expect(output).toContain("The observer enters a demonstration room, according to the book")
    expect(output).toContain("a personal note reflects on curiosity and risk")
    expect(output).toContain('"book.md"')
    expect(output).toContain('"note.md"')
    expect(output).not.toMatch(/Preparing|合并稿|Stop 钩子|transcript|---FILE|---END FILE/)
  })

  it.each([
    mergedPage,
    `---FILE: wiki/merged-page.md---\n${mergedPage}`,
    frame(mergedPage) + "\n" + frame(mergedPage),
    frame(mergedPage).replace("wiki/merged-page.md", "wiki/other.md"),
    frame(mergedPage) + "\n---FILE: ../../outside.md---\nunsafe\n---END FILE---",
  ])("rejects missing, truncated, ambiguous or unexpected file boundaries", async (output) => {
    response.text = output
    await expect(buildPageMerger(useWikiStore.getState().llmConfig)(oldPage, newPage, "note.md"))
      .rejects.toThrow("one complete merged file block")
  })

  it("rejects an unclosed draft followed by a new file and preserves the fallback backup", async () => {
    response.text = `---FILE: wiki/merged-page.md---\n${oldPage}\n${frame(mergedPage)}`
    const backup = vi.fn()
    const output = await mergePageContent(newPage, oldPage, buildPageMerger(useWikiStore.getState().llmConfig), {
      pagePath: "wiki/themes/curiosity.md", sourceFileName: "note.md", backup,
    })
    expect(backup).toHaveBeenCalledWith(oldPage)
    expect(output).toContain("A personal note reflects")
    expect(output).not.toContain("---FILE:")
  })

  it("preserves literal file markers inside fenced examples", async () => {
    const body = mergedPage + "\n\n```text\n---FILE: wiki/example.md---\nexample\n---END FILE---\n```\n\nFinal paragraph."
    response.text = frame(body) + "\n\nCLI status outside the document."
    const output = await buildPageMerger(useWikiStore.getState().llmConfig)(oldPage, newPage, "note.md")
    expect(output).toBe(body)
    expect(output).not.toContain("CLI status")
  })
})
