import { describe, expect, it } from "vitest"
import { planPreparedBook } from "./prepared-book-plan"

const located = (page: number, block: number, text: string) =>
  `<!-- source-location: pdf-page:${page}/block:${block} -->\n${text}\n<!-- source-location: unknown -->\n\n`

describe("prepared book chapter boundaries", () => {
  it("keeps complete short chapters separate and retains every original character", () => {
    const source = "# 测试书\n\n" + located(2, 1, "## 第一章 概述") + located(2, 2, "第一章证据")
      + located(3, 1, "## 第二章 方法") + located(3, 2, "第二章证据")
    const parts = planPreparedBook(source, 60_000, 3_000, 100_000)!
    expect(parts.map(part => part.main).join("")).toBe(source)
    expect(parts.filter(part => part.chapterKind === "chapter")).toHaveLength(2)
    expect(parts.find(part => part.chapterTitle === "第一章 概述")!.main).not.toContain("第二章")
    expect(parts.find(part => part.chapterTitle === "第二章 方法")!.main.startsWith("<!-- source-location: pdf-page:3/block:1 -->")).toBe(true)
    expect(parts.every(part => !part.overlapBefore)).toBe(true)
  })

  it("subdivides a long chapter without borrowing text from the next chapter", () => {
    const source = located(1, 1, "## 第一章 长章")
      + Array.from({ length: 7 }, (_, n) => located(n + 1, 2, `本章证据${n}：${"甲".repeat(350)}`)).join("")
      + located(9, 1, "## 第二章 另章") + located(9, 2, "另章专属证据")
    const parts = planPreparedBook(source, 900, 500, 10_000)!
    expect(parts.map(part => part.main).join("")).toBe(source)
    const first = parts.filter(part => part.chapterTitle === "第一章 长章")
    const second = parts.filter(part => part.chapterTitle === "第二章 另章")
    expect(first.length).toBeGreaterThan(1)
    expect(first.every(part => part.parts === first.length && !part.main.includes("另章专属证据"))).toBe(true)
    expect(first.some(part => part.overlapBefore.includes("本章证据"))).toBe(true)
    expect(second[0].overlapBefore).toBe("")
    for (const part of parts) {
      expect((part.main.match(/source-location: pdf-page:/g) ?? []).length).toBe((part.main.match(/source-location: unknown/g) ?? []).length)
      expect((part.overlapBefore.match(/source-location: pdf-page:/g) ?? []).length).toBe((part.overlapBefore.match(/source-location: unknown/g) ?? []).length)
    }
  })

  it("does not split located tables, unlocated HTML tables, or fenced examples", () => {
    const table = `<table>\n<tr><td>${"数据".repeat(180)}</td></tr>\n\n<tr><td>末行</td></tr>\n</table>\n\n`
    const code = "```md\n## 第三章 只是代码\n\n" + "示例\n".repeat(100) + "```\n\n"
    const source = located(1, 1, "## 第一章 数据") + located(1, 2, table) + table + code + located(2, 1, "## 第二章 结语")
    const parts = planPreparedBook(source, 500, 300, 20_000)!
    expect(parts.map(part => part.main).join("")).toBe(source)
    expect(parts.some(part => part.main.includes(located(1, 2, table)))).toBe(true)
    expect(parts.some(part => part.main.includes(code))).toBe(true)
    expect(new Set(parts.map(part => part.chapterTitle))).toEqual(new Set(["第一章 数据", "第二章 结语"]))
    for (const part of parts) expect((part.main.match(/<table>/g) ?? []).length).toBe((part.main.match(/<\/table>/g) ?? []).length)
  })

  it("does not infer chapters in ordinary papers or heading-free material", () => {
    expect(planPreparedBook("# Paper\n\n## 1 Introduction\nText\n## 2 Method\nText", 500, 50, 2_000)).toBeNull()
    expect(planPreparedBook("plain text", 500, 50, 2_000)).toBeNull()
  })

  it("prefers complete subsections when they fit, and labels their parent chapter", () => {
    const one = located(1, 2, "### 第一节 设计") + located(1, 3, "设计证据".repeat(120))
    const two = located(2, 2, "### 第二节 施工") + located(2, 3, "施工证据".repeat(120))
    const source = located(1, 1, "## 第一章 业务") + one + two + located(3, 1, "## 第二章 结语")
    const parts = planPreparedBook(source, 1_000, 100, 5_000)!
    expect(parts.map(part => part.main).join("")).toBe(source)
    expect(parts.some(part => part.main.includes(one) && part.sectionTitles.includes("第一节 设计"))).toBe(true)
    expect(parts.some(part => part.main.includes(two) && part.sectionTitles.includes("第二节 施工"))).toBe(true)
  })

  it("rejects an indivisible block beyond the request budget without silently cutting it", () => {
    const source = "## 第一章 数据\n\n" + located(1, 1, "证据".repeat(800)) + "## 第二章 结语\n\n结束"
    expect(() => planPreparedBook(source, 500, 100, 1_000)).toThrow("超过单次正文预算")
  })
})
