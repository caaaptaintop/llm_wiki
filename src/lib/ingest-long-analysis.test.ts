import { describe, expect, it } from "vitest"
import { parseLongSourceAnalysis } from "./ingest"

describe("long-source analysis protocol", () => {
  it.each([
    ["Chunk Analysis", "Updated Global Digest"],
    ["分块分析", "更新全局摘要"],
    ["分段分析", "更新后的全局摘要"],
  ])("separates %s from %s and ignores CLI status after the end marker", (analysis, digest) => {
    const result = parseLongSourceAnalysis(`状态前言\n## ${analysis}\n本章证据。\n### 明细\n原文位置。\n## ${digest}\n整书最新摘要。\n---END LONG SOURCE ANALYSIS---\n会话保存失败，不属于来源。`)
    expect(result).toEqual({ analysis: "本章证据。\n### 明细\n原文位置。", digest: "整书最新摘要。" })
  })

  it("preserves literal protocol-looking lines inside fenced examples", () => {
    const analysis = "```md\n## Updated Global Digest\n---END LONG SOURCE ANALYSIS---\n```\n真实分析"
    expect(parseLongSourceAnalysis(`## Chunk Analysis\n${analysis}\n## Updated Global Digest\n最新摘要\n---END LONG SOURCE ANALYSIS---`)).toEqual({ analysis, digest: "最新摘要" })
  })

  it.each([
    "## Chunk Analysis\n只有分析\n---END LONG SOURCE ANALYSIS---",
    "## Chunk Analysis\n分析\n## Updated Global Digest\n摘要但未结束",
    "## Updated Global Digest\n先出摘要\n## Chunk Analysis\n分析\n---END LONG SOURCE ANALYSIS---",
    "## Chunk Analysis\n分析\n## Updated Global Digest\n摘要\n## Updated Global Digest\n重复\n---END LONG SOURCE ANALYSIS---",
  ])("rejects an incomplete or ambiguous response without guessing a digest", response => {
    expect(() => parseLongSourceAnalysis(response)).toThrow()
  })
})
