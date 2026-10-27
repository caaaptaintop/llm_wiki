import { describe, expect, it } from "vitest"
import { buildCliChatEvidence } from "./cli-chat-evidence"

describe("CLI evidence modes", () => {
  it("faithful mode excludes generated summaries and non-source references even if the backend returns them", () => {
    const result = buildCliChatEvidence("faithful", "What changed?", "UNSUPPORTED SUMMARY", [
      { title: "Wiki", path: "wiki/topic.md", kind: "wiki", snippet: "UNSUPPORTED WIKI" },
      { title: "Web", path: "https://example.com", kind: "source", snippet: "UNSUPPORTED WEB" },
      { title: "Guide", path: "raw/sources/guide/source.md", kind: "source", snippet: "lines 42–44: draft only" },
    ])
    expect(result.context).toContain("lines 42–44: draft only")
    expect(result.context).not.toContain("UNSUPPORTED")
    expect(result.system).toContain("do not call tools")
    expect(result.hasEvidence).toBe(true)
  })
  it("does not treat a source filename without an excerpt as evidence", () => {
    const result = buildCliChatEvidence("faithful", "Give a value", "fabricated answer", [
      { title: "Guide", path: "raw/sources/guide.md", kind: "source" },
    ])
    expect(result.hasEvidence).toBe(false)
    expect(result.context).toContain("sources are insufficient")
    expect(result.context).not.toContain("fabricated")
  })
  it("smart mode preserves supplied evidence and states its bounded retrieval limitation", () => {
    const result = buildCliChatEvidence("smart", "Question", "Original excerpt", [])
    expect(result.context).toContain("Original excerpt")
    expect(result.system).toContain("one bounded retrieval pass")
    expect(result.system).toContain("take precedence")
  })
  it("standard mode retains the existing general-knowledge fallback", () => {
    const result = buildCliChatEvidence("standard", "Hello", "", [])
    expect(result.hasEvidence).toBe(false)
    expect(result.system).toContain("answer directly")
  })
  it("keeps scope metadata separate from evidence, even if no source was found", () => {
    const result = buildCliChatEvidence("faithful", "Question", "", [], "限定：Current paper")
    expect(result.context).toContain("Retrieval scope metadata (NOT evidence)")
    expect(result.context).toContain("Current paper")
    expect(result.system).toContain("Briefly state the current retrieval scope")
    expect(result.hasEvidence).toBe(false)
  })
  it("smart evidence explicitly rejects earlier answers and retrieval plans as evidence", () => {
    expect(buildCliChatEvidence("smart", "Question", "Current evidence", []).system).toContain("Prior assistant answers, earlier retrieval results and retrieval plans are not evidence")
  })
})
