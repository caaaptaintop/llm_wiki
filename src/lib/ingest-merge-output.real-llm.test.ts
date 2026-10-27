import fs from "node:fs/promises"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { streamBookCodex } from "@/test-helpers/book-codex"
import { buildPageMerger } from "./ingest"
import { mergePageContent } from "./page-merge"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("./llm-client", () => ({ streamChat: streamBookCodex }))

it.runIf(process.env.RUN_MERGE_CODEX_TEST === "1")("keeps real CLI status outside the merged wiki page", async () => {
  const root = process.env.BOOK_VALIDATION_ROOT!
  const existing = '---\ntitle: 好奇心与风险\nsources: ["book.md"]\n---\n# 好奇心与风险\n\n《爱丽丝梦游仙境》第一章开头，爱丽丝发现白兔拿出怀表，追随它进入兔洞，没有考虑如何返回。此处只描述这一情节，不概括全书。'
  const incoming = '---\ntitle: 好奇心与风险\nsources: ["note.md"]\n---\n# 好奇心与风险\n\n个人阅读笔记认为，好奇心可以推动探索，但观察到异常不等于理解后果。这是个人解释，不代表作者的创作意图。'
  const config = { ...useWikiStore.getState().llmConfig, provider: "codex-cli" as const, model: "gpt-6.1-sol" }
  const merger = vi.fn(buildPageMerger(config))
  const backup = vi.fn()
  const result = await mergePageContent(incoming, existing, merger, {
    pagePath: "wiki/themes/好奇心与风险.md", sourceFileName: "note.md", backup,
  })
  expect(merger).toHaveBeenCalledOnce()
  await expect(merger.mock.results[0].value).resolves.toContain("---")
  expect(backup).not.toHaveBeenCalled()
  expect(result).toContain("book.md")
  expect(result).toContain("note.md")
  expect(result).toMatch(/个人|解读|解释/)
  expect(result).not.toMatch(/---FILE:|---END FILE---|Stop 钩子|transcript|会话自动保存|合并稿已交付/)
  await fs.writeFile(path.join(root, "merge-boundary-real-result.md"), result)
}, 10 * 60_000)
