import { describe, expect, it, vi } from "vitest"
import { appendRetrievalPlanContext, buildRetrievalPlanMessages, parseRetrievalPlan, planCliRetrieval, RETRIEVAL_PLAN_LIMITS, type RetrievalPlanInput } from "./cli-retrieval-plan"
import type { StreamCallbacks } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

const guide = { title: "建筑施工指南", path: "raw/sources/guide/source.md", aliases: ["指南"] }
const review = { title: "Construction Research Review", path: "raw/sources/review.md", aliases: ["研究综述", "综述"] }
const robot = { title: "Robot Planning", path: "raw/sources/robot.md", aliases: ["机器人论文"] }
const catalog = [guide, review, robot]
const input = (query: string, extra: Partial<RetrievalPlanInput> = {}): RetrievalPlanInput => ({ query, catalog, ...extra })
const json = (sourcePaths: string[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({
  intent: "SYN X7 条件、速度 0.7 m/s 与位姿参数", englishKeywords: ["SYN sample criteria", "robot speed pose parameters"], sourcePaths, clarification: null, ...extra,
})
const user = (content: string) => ({ role: "user", content })
const assistant = (content: string) => ({ role: "assistant", content })

describe("bounded CLI retrieval messages", () => {
  it("includes only current query, a bounded user history and catalog; never old answers or their images/citations", () => {
    const messages = buildRetrievalPlanMessages(input("指南的 SYN X7 是什么？", {
      history: [user("TOO_OLD"), ...Array.from({ length: 10 }, (_, i) => user(`query-${i}`)), assistant("SECRET_OLD_ANSWER raw/sources/fake.md")],
    }))
    expect(messages.map((m) => m.role)).toEqual(["system", "user"])
    const payload = JSON.parse(messages[1].content as string)
    expect(payload.currentUser).toContain("SYN X7")
    expect(payload.recentUsers).toEqual(Array.from({ length: 8 }, (_, i) => `query-${i + 2}`))
    expect(JSON.stringify(messages)).not.toMatch(/SECRET_OLD_ANSWER|TOO_OLD/)
    expect(messages[0].content).toContain("NEVER an answer or evidence")
    expect(messages[0].content).toContain("Do not call tools")
    expect(payload.catalog).toEqual(catalog)
  })
  it("does not silently truncate an oversized user message containing scope changes", () => {
    expect(() => buildRetrievalPlanMessages(input("问题", { history: [user("a".repeat(2001))] }))).toThrow("最近用户消息")
  })
})

describe("scope and alias resolution", () => {
  const a = { title: "施工指南", path: "raw/sources/a.md", aliases: ["甲材料"] }
  const b = { title: "机器人研究", path: "raw/sources/b.md", aliases: ["乙材料"] }
  it.each([
    "从《施工指南》切换到《机器人研究》，说明其中的机器人速度。",
    "从施工指南切换到机器人研究，说明其中的机器人速度。",
    "现在只看乙材料，比较它与施工指南的不同。",
  ])("an explicit scope switch replaces old sources, with or without title marks: %s", (query) => {
    const request = input(query, { catalog: [a, b], history: [] })
    expect(parseRetrievalPlan(json([b.path]), request).sourcePaths).toEqual([b.path])
    expect(() => parseRetrievalPlan(json([a.path, b.path]), request)).toThrow("来源")
    expect(() => parseRetrievalPlan(json([a.path]), request)).toThrow("来源")
  })
  it("does not resolve an unlisted quoted title merely by its generic document type", () => {
    const request = input("仅依据《量子计算指南》说明量子比特。", { catalog: [{ ...a, aliases: [] }] })
    for (const paths of [[a.path], []]) {
      expect(parseRetrievalPlan(json(paths), request)).toMatchObject({ sourcePaths: [], retrievalQuery: "", clarification: expect.stringContaining("未匹配") })
    }
    expect(parseRetrievalPlan(json([a.path]), { ...request, query: "指南中的要求" }).sourcePaths).toEqual([a.path])
    expect(parseRetrievalPlan(json([a.path]), { ...request, query: "仅依据《施工指南》说明要求。" }).sourcePaths).toEqual([a.path])
  })
  it.each([
    "仅依据《量子计算指南》和《施工指南》说明量子比特。",
    "仅依据《施工指南》和《量子计算指南》说明量子比特。",
  ])("one known scoped title cannot hide an unknown title: %s", (query) => {
    const request = input(query, { catalog: [{ ...a, aliases: [] }] })
    for (const paths of [[a.path], []]) {
      expect(parseRetrievalPlan(json(paths), request)).toMatchObject({ sourcePaths: [], retrievalQuery: "", clarification: expect.stringContaining("未匹配") })
    }
  })
  it("accepts every matched title in an explicit multi-source scope, but rejects dropping one", () => {
    const request = input("仅依据《施工指南》和《机器人研究》说明两者的差异。", { catalog: [a, b] })
    expect(parseRetrievalPlan(json([a.path, b.path]), request).sourcePaths).toEqual([a.path, b.path])
    expect(() => parseRetrievalPlan(json([a.path]), request)).toThrow("来源")
    expect(() => parseRetrievalPlan(json([b.path]), request)).toThrow("来源")
  })
  it("retains an explicitly requested comparison object after an unquoted source switch", () => {
    const request = input("从施工指南切换到机器人研究并说明与施工指南的区别", { catalog: [a, b] })
    expect(parseRetrievalPlan(json([a.path, b.path]), request).sourcePaths).toEqual([a.path, b.path])
  })
  it("a repeated numbered assignment replaces its already-resolved alias", () => {
    const request = input("仅依据论文1说明机器人速度。", {
      catalog: [a, b], history: [user("论文1 = 《施工指南》"), user("论文1 = 《机器人研究》")],
    })
    expect(parseRetrievalPlan(json([b.path]), request).sourcePaths).toEqual([b.path])
    expect(() => parseRetrievalPlan(json([a.path]), request)).toThrow("来源")
    expect(() => parseRetrievalPlan(json([a.path, b.path]), request)).toThrow("来源")
    expect(parseRetrievalPlan(json([a.path]), { ...request, query: "施工指南中的要求" }).sourcePaths).toEqual([a.path])
  })
  it("arbitrary user aliases can be reassigned in either definition direction", () => {
    for (const history of [
      [user("蓝皮 = 《施工指南》"), user("蓝皮 = 《机器人研究》")],
      [user("施工指南简称蓝皮"), user("机器人研究简称蓝皮")],
    ]) {
      const request = input("蓝皮中的条件", { catalog: [a, b], history })
      expect(parseRetrievalPlan(json([b.path]), request).sourcePaths).toEqual([b.path])
      expect(() => parseRetrievalPlan(json([a.path]), request)).toThrow("来源")
    }
  })
  it("reassigning a numbered alias to an unknown source does not revive its old mapping", () => {
    const request = input("论文1的条件", { catalog: [a, b], history: [user("论文1 = 《施工指南》"), user("论文1 = 《未收录材料》")] })
    expect(parseRetrievalPlan(json([a.path]), request).clarification).toBeTruthy()
  })
  it("new explicit scope replaces old scope", () => {
    const request = input("机器人论文的速度和位姿", { history: [user("只看指南"), assistant("OLD_GUIDE_ANSWER")] })
    expect(parseRetrievalPlan(json([robot.path]), request).sourcePaths).toEqual([robot.path])
    expect(() => parseRetrievalPlan(json([robot.path, guide.path]), request)).toThrow("来源")
    expect(() => parseRetrievalPlan(json([]), request)).toThrow("来源")
  })
  it("a general new question defaults to the whole library rather than inheriting scope", () => {
    const request = input("有哪些协作方法？", { history: [user("只看指南")] })
    expect(parseRetrievalPlan(json([]), request).sourcePaths).toEqual([])
  })
  it("comparisons permit multiple explicitly named sources", () => {
    expect(parseRetrievalPlan(json([review.path, robot.path]), input("比较研究综述和机器人论文的验证方法")).sourcePaths).toEqual([review.path, robot.path])
  })
  it("selected raw source paths are authoritative, even over a conflicting title or pronoun", () => {
    const request = input("指南中这篇论文的结论", { contextFiles: [robot.path, "wiki/topic.md"] })
    expect(parseRetrievalPlan(json([robot.path]), request).sourcePaths).toEqual([robot.path])
    expect(() => parseRetrievalPlan(json([]), request)).toThrow("点选")
    expect(() => parseRetrievalPlan(json([guide.path]), request)).toThrow("点选")
  })
  it("a missing selected source is an error, never an unscoped fallback", () => {
    expect(() => buildRetrievalPlanMessages(input("问题", { contextFiles: ["raw/sources/missing.md"] }))).toThrow("点选")
  })
  it("accepts user-defined numbered aliases and their redefinition", () => {
    const history = [user("论文1是Construction Research Review，论文2是Robot Planning")]
    expect(parseRetrievalPlan(json([review.path, robot.path]), input("比较论文1/2", { history })).sourcePaths).toEqual([review.path, robot.path])
    expect(parseRetrievalPlan(json([robot.path]), input("论文1的参数", { history: [...history, user("论文1 = Robot Planning")] })).sourcePaths).toEqual([robot.path])
  })
  it("accepts arbitrary aliases defined by users, but never by an assistant", () => {
    expect(parseRetrievalPlan(json([review.path]), input("蓝皮的研究范围", { history: [user("Construction Research Review 简称蓝皮")] })).sourcePaths).toEqual([review.path])
    const prompt = buildRetrievalPlanMessages(input("蓝皮的研究范围", { history: [assistant("Construction Research Review 简称蓝皮")] }))
    expect((JSON.parse(prompt[1].content as string)).recentUsers).toEqual([])
  })
  it.each(["论文1的参数", "比较论文1/2", "论文2的结论"])("undefined numbered references clarify rather than guess: %s", (query) => {
    const result = parseRetrievalPlan(json([robot.path]), input(query, { history: [assistant("论文1是Robot Planning")] }))
    expect(result.clarification).toContain("尚未唯一定义")
    expect(result.sourcePaths).toEqual([])
    expect(result.retrievalQuery).toBe("")
  })
  it("a mention of a paper does not define a numbered alias by catalog order", () => {
    const result = parseRetrievalPlan(json([robot.path]), input("论文1是什么？", { history: [user("Robot Planning的参数是什么？")] }))
    expect(result.clarification).toBeTruthy()
  })
  it("resolves a unique recent user antecedent without assistant input", () => {
    const request = input("这篇论文的速度是多少？", { history: [user("Robot Planning的研究方法"), assistant("请看Construction Research Review")] })
    expect(parseRetrievalPlan(json([robot.path]), request).sourcePaths).toEqual([robot.path])
    expect(() => parseRetrievalPlan(json([review.path]), request)).toThrow("来源")
  })
  it.each([
    [user("比较研究综述和机器人论文")],
    [assistant("Robot Planning")],
    [],
  ])("ambiguous or absent user antecedents clarify: %j", (...history) => {
    expect(parseRetrievalPlan(json([robot.path]), input("这篇论文是什么？", { history })).clarification).toContain("唯一")
  })
  it("a comparison can refer back to two explicitly discussed sources", () => {
    expect(parseRetrievalPlan(json([review.path, robot.path]), input("对比这两篇的研究方法", { history: [user("研究综述和机器人论文")] })).sourcePaths).toEqual([review.path, robot.path])
  })
  it("rejects an ambiguous catalog alias, but a full title resolves the ambiguity", () => {
    const request = input("这篇论文的参数", { catalog: [review, robot].map((s) => ({ ...s, aliases: ["论文"] })) })
    expect(parseRetrievalPlan(json([robot.path]), request).clarification).toBeTruthy()
    expect(parseRetrievalPlan(json([robot.path]), { ...request, query: "Robot Planning 的参数" }).sourcePaths).toEqual([robot.path])
  })
  it.each(["只看《不存在的论文》", "仅从未知报告检索"])("an unmatched explicit source clarifies: %s", (query) => {
    const result = parseRetrievalPlan(json([]), input(query))
    expect(result.clarification).toContain("未匹配")
    expect(result.retrievalQuery).toBe("")
  })
  it("preserves a model clarification without allowing a retrieval query", () => {
    const result = parseRetrievalPlan(json([], { intent: "", englishKeywords: [], clarification: "你指哪篇论文？" }), input("论文1是什么？"))
    expect(result).toMatchObject({ clarification: "你指哪篇论文？", sourcePaths: [], retrievalQuery: "" })
  })
})

describe("strict plan decoding and bilingual retrieval query", () => {
  it("keeps Chinese intent, acronyms, qualifiers, units and English expansions without changing the original query", () => {
    const request = input("SYN 的 X7 条件和 0.7 m/s 速度参数是什么？")
    const result = parseRetrievalPlan(json(), request)
    expect(result.retrievalQuery).toContain("SYN X7")
    expect(result.retrievalQuery).toContain("0.7 m/s")
    expect(result.retrievalQuery).toContain("sample criteria")
    expect(result.retrievalQuery.length).toBeLessThanOrEqual(1600)
    expect(request.query).toBe("SYN 的 X7 条件和 0.7 m/s 速度参数是什么？")
  })
  it.each([
    "raw/sources/missing.md", "raw/sources/../private.md", "raw/sources/robot.md/", "raw/sources/robot.md ",
    "raw\\sources\\robot.md", "/raw/sources/robot.md", "wiki/robot.md", "raw/sources", "raw/sources/robot%2emd",
  ])("rejects unknown or inexact paths: %s", (path) => {
    expect(() => parseRetrievalPlan(json([path]), input("问题"))).toThrow("路径")
  })
  it.each([
    "not json", "{}", "[]", json() + json([], { intent: "different" }), "An answer:\n" + json(),
    '```json\n' + json(), '```json\n' + json() + '\n```\n' + json([], { intent: "different" }), '{"intent":}',
    json([], { answer: "not allowed" }), json([], { englishKeywords: "search" }),
    json([], { englishKeywords: [] }), json([], { clarification: false }),
    json([], { sourcePaths: Array(17).fill(robot.path) }), json([robot.path, robot.path]),
    json([], { intent: "a".repeat(1201) }), json([], { englishKeywords: ["a".repeat(161)] }),
    json([], { englishKeywords: Array(25).fill("test") }), json([], { intent: "a".repeat(1200), englishKeywords: Array(5).fill("k".repeat(100)) }),
  ])("rejects malformed, extra or oversized business content: %s", (response) => {
    expect(() => parseRetrievalPlan(response, input("问题"))).toThrow("CLI 检索计划")
  })
  it.each([
    json(),
    '```json\n' + json() + '\n```',
    json() + "\n\n本次对话归档未完成：Stop hook 找不到指定会话的 transcript，已拒绝保存其他会话，避免串档。上述分析结论不受影响。",
    '```json\n' + json() + '\n```\n\n会话自动保存未完成：Stop 钩子未找到本会话的 transcript。',
    json() + "\n\n" + json(),
    json() + "\n\n会话保存钩子未找到指定会话的记录，因此没有保存其他会话。检索计划已在上一条消息中给出。",
    json() + "\n\n记忆保存被拦截：Stop hook 未找到指定会话的 transcript，因此没有保存其他会话。此前的检索计划不受影响。",
    json() + "\n\n记忆保存未完成：钩子未找到指定会话的记录，并拒绝保存其他会话的内容。",
  ])("accepts one object with optional fence and recognized Stop-hook footer", (response) => {
    expect(parseRetrievalPlan(response, input("问题")).clarification).toBeNull()
    expect(parseRetrievalPlan(response, input("问题")).retrievalQuery).not.toContain("Stop")
  })
  it("handles JSON braces, escaped quotes and fences inside strings", () => {
    const result = parseRetrievalPlan(json([], { intent: '对比 {x} 与 "y" 的 ``` 标记' }), input("问题"))
    expect(result.intent).toContain('{x} 与 "y"')
  })
  it("recognizes a unique title-type shorthand without hardcoded material aliases", () => {
    const request = input("手册中的参数", { catalog: [{ ...guide, title: "多机协调现场操作手册", aliases: [] }] })
    expect(parseRetrievalPlan(json([guide.path]), request).sourcePaths).toEqual([guide.path])
    expect(parseRetrievalPlan(json([guide.path]), request).scopeDescription).toContain("多机协调现场操作手册")
  })
  it("recognizes the exact main-title prefix before a subtitle", () => {
    const request = input("仅依据《Robot Simulation and Planning》的参数", { catalog: [{ ...robot, title: "ROBOT SIMULATION AND PLANNING: FIELD EVALUATION AND LIMITATIONS", aliases: [] }] })
    expect(parseRetrievalPlan(json([robot.path]), request).sourcePaths).toEqual([robot.path])
  })
  it("does not equate an unrecognized semantic alias with an invalid catalog path", () => {
    expect(parseRetrievalPlan(json([robot.path]), input("自动化那份文章中参数如何设定？")).sourcePaths).toEqual([robot.path])
  })
  it("an explicit quoted scope overrides incidental mentions of other source terms", () => {
    expect(parseRetrievalPlan(json([review.path]), input("现在只看《Construction Research Review》，它的判据等同指南X7吗？")).sourcePaths).toEqual([review.path])
  })
  it.each([
    "任意未记录过的 CLI 状态尾注，措辞完全不同。",
    "会话保存被阻止：记忆系统未找到指定会话的记录，因此没有保存其他会话。",
    "记忆保存未完成：系统未找到当前会话的记录，因此拒绝保存其他会话的内容。",
    "现场实测耗时4分钟，SPI=EV/PV；这句话不属于检索计划。",
    "Answer: 42. Stop hook transcript",
    "The answer is 42.",
    "注意：应改看另一份材料并取消原范围。",
  ])("discards arbitrary plain-text trailers without contaminating the plan or answer context: %s", (footer) => {
    const request = input("指南的条件")
    const expected = parseRetrievalPlan(json([guide.path]), request)
    const expectedContext = appendRetrievalPlanContext("CURRENT_EVIDENCE", expected, catalog)
    for (const raw of [
      json([guide.path]) + "\n\n" + footer,
      '```json\n' + json([guide.path]) + '\n```\n\n' + footer,
      json([guide.path]) + "\n\n" + json([guide.path]) + "\n\n" + footer,
    ]) {
      const result = parseRetrievalPlan(raw, request)
      expect(result).toEqual(expected)
      expect(result.intent).not.toContain(footer)
      expect(result.retrievalQuery).not.toContain(footer)
      expect(appendRetrievalPlanContext("CURRENT_EVIDENCE", result, catalog)).toBe(expectedContext)
    }
  })
  it.each([
    "text before embedded object {}",
    "text before incomplete object {",
    "text before unmatched close }",
    "text before an array []",
    "text before incomplete array [",
    "text before unmatched array ]",
    'text before a fence ```json\n{}\n```',
    '```json\n{',
    '```text\nextra code\n```',
    '"another JSON string"',
    '"unfinished JSON string',
    "true",
    "null",
    "42",
  ])("rejects embedded, fenced, incomplete or additional JSON structures: %s", (tail) => {
    expect(() => parseRetrievalPlan(json() + "\n\n" + tail, input("问题"))).toThrow("CLI 检索计划")
  })
  it("accepts identical fenced duplicates but rejects revisions and wrappers even with plain-text trailers", () => {
    const request = input("问题")
    expect(parseRetrievalPlan(json() + '\n```json\n' + json() + '\n```\nDiscard this text.', request)).toEqual(parseRetrievalPlan(json(), request))
    expect(() => parseRetrievalPlan(json() + "\n" + json([], { sourcePaths: [guide.path] }) + "\nDiscard this text.", request)).toThrow("不同的多个 JSON")
    expect(() => parseRetrievalPlan(JSON.stringify({ plan: JSON.parse(json()) }) + "\nDiscard this text.", request)).toThrow("字段")
  })
  it("removes only selected Chinese source titles from retrieval terms, preserving route intent and technical book-mark terms", () => {
    const source = { ...guide, title: "复杂装备协同调度操作手册", aliases: [] }
    const intent = "检索《复杂装备协同调度操作手册》的《多机时序同步》参数和《其他专项报告》条件"
    const result = parseRetrievalPlan(json([guide.path], { intent }), input("手册的同步参数", { catalog: [source] }))
    expect(result.intent).toBe(intent)
    expect(result.retrievalQuery).not.toContain("复杂装备协同调度操作手册")
    expect(result.retrievalQuery).toContain("《多机时序同步》")
    expect(result.retrievalQuery).toContain("《其他专项报告》")
  })
  it("removes a selected English main-title prefix, case insensitively, without deleting quoted terms or partial words", () => {
    const source = { ...robot, title: "AUTONOMOUS ASSEMBLY PLANNING: PARAMETER EXCHANGE AND FIELD VALIDATION", aliases: [] }
    const intent = "从《Autonomous Assembly Planning》查找《initial pose》与《AUTONOMOUS ASSEMBLY PLAN》的值"
    const result = parseRetrievalPlan(json([robot.path], { intent }), input("装配文章的位姿参数", { catalog: [source] }))
    expect(result.intent).toBe(intent)
    expect(result.retrievalQuery).not.toContain("《Autonomous Assembly Planning》")
    expect(result.retrievalQuery).toContain("《initial pose》")
    expect(result.retrievalQuery).toContain("《AUTONOMOUS ASSEMBLY PLAN》")
  })
  it("keeps an unselected title and never removes titles from unscoped queries", () => {
    const intent = "对比《Robot Planning》和《未知材料》"
    expect(parseRetrievalPlan(json([guide.path], { intent }), input("指南的参数")).retrievalQuery).toContain("《Robot Planning》")
    expect(parseRetrievalPlan(json([], { intent }), input("有哪些参数？")).retrievalQuery).toContain("《Robot Planning》")
  })
  it("does not delete a technical term just because it begins a selected Chinese book title", () => {
    const source = { ...guide, title: "多机时序同步操作手册", aliases: [] }
    const intent = "检索《多机时序同步操作手册》的《多机时序同步》方法"
    const result = parseRetrievalPlan(json([guide.path], { intent }), input("手册的参数", { catalog: [source] }))
    expect(result.retrievalQuery).not.toContain("多机时序同步操作手册")
    expect(result.retrievalQuery).toContain("《多机时序同步》")
  })
  it("different plans remain an error even when followed by a valid generalized hook footer", () => {
    expect(() => parseRetrievalPlan(json() + "\n\n" + json([], { intent: "Changed plan" }) + "\n\n记忆保存钩子未找到指定会话的记录，因此未保存。", input("问题"))).toThrow("不同的多个 JSON")
  })
  it("does not redefine a numbered alias when a later question contains 指南 or 是什么", () => {
    const history = [user("论文1指 Robot Planning；论文2指 Construction Research Review。")]
    expect(parseRetrievalPlan(json([robot.path]), input("论文1的系统是什么？", { history })).sourcePaths).toEqual([robot.path])
    expect(parseRetrievalPlan(json([robot.path, guide.path]), input("论文1与指南各自的判据是什么？", { history })).sourcePaths).toEqual([robot.path, guide.path])
  })
  it("shares scope/intent context without turning English keyword guesses into factual evidence", () => {
    const plan = parseRetrievalPlan(json([guide.path], { englishKeywords: ["SPI CPI guessed formulas"] }), input("指南的指标是什么？"))
    const context = appendRetrievalPlanContext("Current raw-source excerpt", plan, catalog)
    expect(context).toContain("Current raw-source excerpt")
    expect(context).toContain("Resolved source scope (routing/navigation only, NOT evidence)")
    expect(context).toContain("Resolved intent (routing only, NOT evidence)")
    expect(context).toContain("Do not infer formulas")
    expect(context).not.toContain("SPI CPI guessed formulas")
  })
})

describe("single completion harness entry", () => {
  const config = { provider: "codex-cli", model: "selected-model" } as LlmConfig
  it("calls the injected stream exactly once with the selected config and ignores reasoning as business content", async () => {
    const stream = vi.fn(async (_config, _messages, callbacks: StreamCallbacks) => {
      callbacks.onReasoningToken?.("not JSON reasoning")
      callbacks.onToken(json().slice(0, 25))
      callbacks.onToken(json().slice(25))
      callbacks.onDone()
    })
    const result = await planCliRetrieval(input("问题"), { llmConfig: config, streamChat: stream })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(stream.mock.calls[0][0]).toBe(config)
    expect(result.clarification).toBeNull()
  })
  it("returns clarification without generating an answer or retrying", async () => {
    const stream = vi.fn(async (_config, _messages, callbacks: StreamCallbacks) => { callbacks.onToken(json()); callbacks.onDone() })
    expect((await planCliRetrieval(input("论文1的条件"), { llmConfig: config, streamChat: stream })).clarification).toBeTruthy()
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it.each(["error", "truncated", "oversized", "bad-json"])("exposes %s failure and never retries or widens scope", async (failure) => {
    const stream = vi.fn(async (_config, _messages, callbacks: StreamCallbacks) => {
      callbacks.onToken(failure === "oversized" ? "x".repeat(RETRIEVAL_PLAN_LIMITS.response + 1) : failure === "bad-json" ? "oops" : json())
      if (failure === "error") callbacks.onError(new Error("service failed"))
      callbacks.onDone({ truncated: failure === "truncated" })
    })
    await expect(planCliRetrieval(input("问题"), { llmConfig: config, streamChat: stream })).rejects.toThrow()
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it("honors cancellation before and after streaming", async () => {
    const controller = new AbortController()
    const stream = vi.fn(async (_config, _messages, callbacks: StreamCallbacks) => { callbacks.onToken(json()); controller.abort() })
    await expect(planCliRetrieval(input("问题"), { llmConfig: config, signal: controller.signal, streamChat: stream })).rejects.toThrow()
    stream.mockClear()
    await expect(planCliRetrieval(input("问题"), { llmConfig: config, signal: controller.signal, streamChat: stream })).rejects.toThrow()
    expect(stream).not.toHaveBeenCalled()
  })
})
