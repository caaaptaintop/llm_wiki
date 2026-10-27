import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"
import { writeSources } from "./sources-merge"

const { completion } = vi.hoisted(()=>({completion:vi.fn()}))
vi.mock("./llm-client",()=>({streamChat:completion}))
vi.mock("@/commands/fs",()=>({...realFs,writeFileAtomic:realFs.writeFile,writeWikiFileIfUnchanged:async(root:string,relative:string,expected:string|null,contents:string)=>{
  const file=`${root}/${relative}`,current=await realFs.fileExists(file)?await realFs.readFile(file):null
  if(current!==expected)throw new Error("并发编辑冲突")
  await realFs.writeFile(file,contents)
}}))
import { ensureSectionKnowledge, mergeKnowledgePatch, planKnowledgeUnits, safeKnowledgeTarget, validateKnowledgeExtraction, type KnowledgeExtraction } from "./section-knowledge"

const source="raw/sources/book.wiki-source/source.md"
const text="## 第一章 管理\n### 第一节 进度\n<!-- source-location: pdf-page:2/block:1 -->\n每日记录完成情况。\n<!-- source-location: unknown -->\n\n周计划按现场偏差更新。\n\n## 第二章 成本\n\n变更后重算工程量。\n"
const unit=planKnowledgeUnits(text)[0]
const record={id:"r1",title:"计划反馈",kind:"method",body:"每日记录完成情况；周计划按现场偏差更新。",evidence:unit.blocks.map(b=>b.id),target:"wiki/methods/计划反馈.md",disposition:"append"}
afterEach(()=>completion.mockReset())

describe("section knowledge",()=>{
  it("keeps original line locations and unknown resets without merging chapters",()=>{
    const units=planKnowledgeUnits(text)
    expect(units).toHaveLength(2)
    expect(units[0].blocks.map(b=>[b.lineStart,b.lineEnd,b.location])).toEqual([[4,4,"pdf-page:2/block:1"],[7,7,"unknown"]])
    expect(units[1].blocks[0].lineStart).toBe(11)
    expect(planKnowledgeUnits("# Short note\nNo book")).toEqual([])
  })
  it("does not parse code examples as source headings or location markers",()=>{
    const units=planKnowledgeUnits(text.replace("每日记录完成情况。","```md\n## 假章\n<!-- source-location: pdf-page:999/block:1 -->\n```"))
    expect(units[0].blocks[0].text).toContain("## 假章")
    expect(units[0].blocks[0].location).toBe("pdf-page:2/block:1")
  })
  it("keeps substantive paragraphs beginning with a figure number for coverage audit",()=>{
    const prose="图7-1所示的控制流程要求先校准，再试运行，验收合格后投入运行。"
    const units=planKnowledgeUnits(text.replace("每日记录完成情况。",prose))
    expect(units.flatMap(u=>u.blocks).some(b=>b.text===prose&&b.location==="pdf-page:2/block:1")).toBe(true)
  })
  it.each(["../raw/source.md","wiki/../raw/x.md","wiki/sources/x.md","wiki/index.md","/tmp/x.md","wiki/.hidden/x.md"])("rejects non-knowledge destination %s",path=>expect(safeKnowledgeTarget(path)).toBe(false))
  it("requires every source block to have a destination or concrete reason",()=>{
    expect(()=>validateKnowledgeExtraction({records:[{...record,evidence:[unit.blocks[0].id]}],context:[]},unit,[],source)).toThrow("尚无")
    expect(()=>validateKnowledgeExtraction({records:[{...record,evidence:["L999"]}],context:[]},unit,[],source)).toThrow("未知证据")
  })
  it("repairs only named records and preserves the other evidence and context",()=>{
    const draft={records:[record,{...record,id:"r2",title:"既有正确知识"}],context:[]} as KnowledgeExtraction
    const result=mergeKnowledgePatch(draft,{records:[{...record,body:"补齐反馈步骤"}]})
    expect(result.records.find(r=>r.id==="r2")).toEqual(draft.records[1])
    expect(result.records.find(r=>r.id==="r1")?.body).toBe("补齐反馈步骤")
    expect(()=>mergeKnowledgePatch(draft,{records:[record,record]})).toThrow("重复")
    expect(validateKnowledgeExtraction(result,unit,[],source).records).toHaveLength(2)
  })
  it("does not accept covered-by-existing based only on a keyword or a different source",()=>{
    const quote="每日记录完成情况；周计划按现场偏差更新。"
    const covered={...record,disposition:"covered",existingQuote:quote}
    const pages=[{path:record.target,title:"计划反馈",content:`---\nsources: [other]\n---\n${quote}`}]
    expect(()=>validateKnowledgeExtraction({records:[covered],context:[]},unit,pages,source)).toThrow("同源")
    pages[0].content=pages[0].content.replace("other",source)
    expect(validateKnowledgeExtraction({records:[covered],context:[]},unit,pages,source).records).toHaveLength(1)
  })
  it("replays verified records without a second model call or duplicate page body, and protects edits",async()=>{
    const temp=await createTempProject("section-knowledge")
    try {
      await fs.mkdir(`${temp.path}/wiki`)
      await realFs.writeFile(`${temp.path}/${source}`,text)
      completion.mockImplementation(async(_c,m,cb)=>{cb.onToken(completion.mock.calls.length===1?JSON.stringify({records:[record],context:[]}):m[0].content.includes("成页后的反向")?'{"records":[]}':'{"issues":[]}');cb.onDone()})
      const options={projectPath:temp.path,sourceIdentity:source,sourceContent:text,schema:"",config:useWikiStore.getState().llmConfig,chapters:["第一章 管理"]}
      await ensureSectionKnowledge(options)
      const first=await fs.readFile(`${temp.path}/${record.target}`,"utf8")
      expect(first).toContain("行 4–4；pdf-page:2/block:1")
      expect(first).toContain("行 7–7；unknown")
      expect(completion).toHaveBeenCalledTimes(4)
      await ensureSectionKnowledge(options)
      expect(completion).toHaveBeenCalledTimes(4)
      expect(await fs.readFile(`${temp.path}/${record.target}`,"utf8")).toBe(first)
      await ensureSectionKnowledge({...options,coverageFeedback:{"第一章 管理":"复核明确要求再次核对反馈闭环。"}})
      expect(completion).toHaveBeenCalledTimes(6)
      await ensureSectionKnowledge(options)
      expect(completion).toHaveBeenCalledTimes(6)
      await fs.writeFile(`${temp.path}/${record.target}`,writeSources(first,[]))
      await expect(ensureSectionKnowledge(options)).rejects.toThrow("来源字段")
      await fs.writeFile(`${temp.path}/${record.target}`,first.replace(record.body,"用户修订"))
      await expect(ensureSectionKnowledge(options)).rejects.toThrow("已被修改")
      expect(await fs.readFile(`${temp.path}/${record.target}`,"utf8")).toContain("用户修订")
    } finally {await temp.cleanup()}
  })
  it("does not publish a record when the independent coverage pass finds omissions",async()=>{
    const temp=await createTempProject("section-incomplete")
    try {
      await fs.mkdir(`${temp.path}/wiki`)
      await realFs.writeFile(`${temp.path}/${source}`,text)
      completion.mockImplementation(async(_c,_m,cb)=>{cb.onToken(completion.mock.calls.length%2===1?JSON.stringify({records:[record],context:[]}):'{"issues":["L7缺少计划更新条件"]}');cb.onDone()})
      await expect(ensureSectionKnowledge({projectPath:temp.path,sourceIdentity:source,sourceContent:text,schema:"",config:useWikiStore.getState().llmConfig,chapters:["第一章 管理"]})).rejects.toThrow("计划更新条件")
      expect(await realFs.fileExists(`${temp.path}/${record.target}`)).toBe(false)
    } finally {await temp.cleanup()}
  })
})
