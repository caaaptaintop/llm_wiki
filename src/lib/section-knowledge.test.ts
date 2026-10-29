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
import { applyKnowledgeEdits, ensureSectionKnowledge, mergeKnowledgePatch, planKnowledgeUnits, safeKnowledgeTarget, validateKnowledgeEdits, validateKnowledgeExtraction, withTableContext, renderKnowledgeRecord, type KnowledgeExtraction } from "./section-knowledge"
import { assertKnowledgeProse } from "./wiki-prose"

const source="raw/sources/book.wiki-source/source.md"
const text="## 第一章 管理\n### 第一节 进度\n<!-- source-location: pdf-page:2/block:1 -->\n每日记录完成情况。\n<!-- source-location: unknown -->\n\n周计划按现场偏差更新。\n\n## 第二章 成本\n\n变更后重算工程量。\n"
const unit=planKnowledgeUnits(text)[0]
const record={id:"r1",title:"计划反馈",kind:"method",body:"每日记录完成情况；周计划按现场偏差更新。",evidence:unit.blocks.map(b=>b.id),target:"wiki/methods/计划反馈.md",disposition:"append"}
afterEach(()=>completion.mockReset())

describe("section knowledge",()=>{
  it.each(["表1-1 示例清单", "表1-1示例清单", "续表1-1", "Table 1-1 (continued)"])("carries adjacent rows for %s without invalidating legacy unit identities",(title)=>{
    const source="## 第一章 示例\n\n"+"准备。".repeat(12)+`\n\n${title}\n\n<!-- source-location: pdf-page:3/block:2 -->\n<table><tr><td>甲</td><td>乙</td></tr></table>\n\n## 第二章 后续\n\n说明。`
    const plan=planKnowledgeUnits(source,60), legacy=JSON.stringify(plan)
    const caption=plan.find(u=>u.blocks.some(b=>b.text===title))!
    expect(caption.blocks.some(b=>b.text.includes("<table>"))).toBe(false)
    const enriched=withTableContext(caption,plan)
    expect(enriched.blocks.some(b=>b.text.includes("<table>")&&b.location==="pdf-page:3/block:2")).toBe(true)
    expect(JSON.stringify(plan)).toBe(legacy)
  })
  it("rejects revision chatter without rejecting real business processes or author limitations",()=>{
    expect(()=>assertKnowledgeProse("此前本页只有表题，本次材料已有表行。")).toThrow("处理")
    expect(()=>assertKnowledgeProse("原文未给出统一周期，按合同确定。研究仅纳入公开样本，验收后完成移交。")).not.toThrow()
    expect(()=>assertKnowledgeProse("ID冲突时，当前批次的导出中止，并保留日志供重试。")).not.toThrow()
    expect(()=>assertKnowledgeProse("当前批次的材料检验合格后方可入库。")).not.toThrow()
    expect(()=>assertKnowledgeProse("当前批次材料应逐件扫码并核对生产批号。")).not.toThrow()
    expect(()=>assertKnowledgeProse("本次材料进场后，质检员应逐件扫码并核对生产批号。")).not.toThrow()
    expect(()=>assertKnowledgeProse("For this batch of concrete, test the slump before pouring.")).not.toThrow()
    expect(()=>assertKnowledgeProse("当前批次未读到表体，暂时无法补全。")).toThrow("处理")
    expect(()=>assertKnowledgeProse("出处：[[study.md]]。资料定位：PDF物理页3／区块2；表格定位未知。")).toThrow("定位")
    expect(()=>assertKnowledgeProse("定位状态未知时，由操作员复核。\n\n<!-- wiki-evidence:start -->\n\n出处：[[study.md]]。资料定位：PDF物理页3／区块2；表格定位未知。\n\n<!-- wiki-evidence:end -->")).not.toThrow()
  })
  it("revises only exact managed prose, journals recovery and preserves external text and citations",async()=>{
    const temp=await createTempProject("knowledge-revision")
    try {
      const key="a".repeat(64), old="该流程只包含输入步骤，后续处理与输出尚无资料。", fixed="该流程包括输入、处理和输出，处理完成后核对结果。"
      const page=`用户手写内容不能改变。\n<!-- section-knowledge:${key}:start -->\n\n${renderKnowledgeRecord({...record,kind:"method",disposition:"append",body:old},unit,source)}\n\n<!-- section-knowledge:${key}:end -->`
      const edit={target:record.target,before:old,after:fixed,evidence:[unit.blocks[0].id]}
      const pages=[{path:record.target,title:"流程",content:page}]
      const accepted=validateKnowledgeEdits([edit],unit,pages,source)
      expect(()=>validateKnowledgeEdits([{...edit,before:"用户手写内容不能改变。".repeat(3)}],unit,pages,source)).toThrow()
      expect(()=>validateKnowledgeEdits([{...edit,after:"此前本页有误，本次材料已经纠正。"}],unit,pages,source)).toThrow("处理")
      await realFs.writeFile(`${temp.path}/${record.target}`,page)
      await fs.mkdir(`${temp.path}/state`)
      await realFs.writeFile(`${temp.path}/state/${key}.json`,JSON.stringify({version:1,key,unit,extraction:{records:[{...record,body:old}],context:[]},audit:{issues:[]}}))
      await applyKnowledgeEdits(temp.path,`${temp.path}/state`,accepted,unit,source)
      const after=await realFs.readFile(`${temp.path}/${record.target}`)
      expect(after).toBe(page.replace(old,fixed))
      await applyKnowledgeEdits(temp.path,`${temp.path}/state`,accepted,unit,source)
      expect(await realFs.readFile(`${temp.path}/${record.target}`)).toBe(after)
      await realFs.writeFile(`${temp.path}/${record.target}`,page.replace(old,"用户改写的完整正文，需要保留。"))
      await expect(applyKnowledgeEdits(temp.path,`${temp.path}/state`,accepted,unit,source)).rejects.toThrow("已变化")
    } finally {await temp.cleanup()}
  })
  it("binds replacements to the reviewed source block and preserves literal dollar text",async()=>{
    const temp=await createTempProject("knowledge-bound-revisions")
    try {
      const dir=`${temp.path}/state`;await fs.mkdir(dir)
      const old="该记录的完整公式和条件仍需根据给定资料说明。", fixed="公式为 $$x + y$$，标记 $& 保持字面值及其适用条件。"
      const make=async(key:string)=>{
        const r={...record,body:old} as KnowledgeExtraction["records"][number]
        const cp={version:1,key,unit,extraction:{records:[r],context:[]},audit:{issues:[]}}
        await realFs.writeFile(`${dir}/${key}.json`,JSON.stringify(cp))
        return `<!-- section-knowledge:${key}:start -->\n\n${renderKnowledgeRecord(r,unit,source)}\n\n<!-- section-knowledge:${key}:end -->`
      }
      const a=await make("a".repeat(64)), b=await make("b".repeat(64))
      const edit={target:record.target,before:old,after:fixed,evidence:[unit.blocks[0].id]}
      await realFs.writeFile(`${temp.path}/${record.target}`,a)
      const approved=validateKnowledgeEdits([edit],unit,[{path:record.target,title:"",content:a}],source)
      // A change after review must fail before it can pollute the journal.
      await realFs.writeFile(`${temp.path}/${record.target}`,a.replace("### 计划反馈","### 手工标题"))
      await expect(applyKnowledgeEdits(temp.path,dir,approved,unit,source)).rejects.toThrow("已变化")
      expect((await fs.readdir(dir)).some(p=>p.startsWith("revisions-"))).toBe(false)
      // A block owned by another source cannot be adopted into this journal.
      await expect(applyKnowledgeEdits(temp.path,`${temp.path}/foreign`,approved,unit,source)).rejects.toThrow("当前来源")
      await realFs.writeFile(`${temp.path}/${record.target}`,a)
      await applyKnowledgeEdits(temp.path,dir,approved,unit,source)
      const first=await realFs.readFile(`${temp.path}/${record.target}`)
      expect(first).toBe(a.replace(old,()=>fixed))
      const both=first+"\n"+b
      await realFs.writeFile(`${temp.path}/${record.target}`,both)
      const approvedB=validateKnowledgeEdits([edit],unit,[{path:record.target,title:"",content:both}],source)
      await applyKnowledgeEdits(temp.path,dir,approvedB,unit,source)
      const last=await realFs.readFile(`${temp.path}/${record.target}`)
      expect(last).toBe(both.replace(old,()=>fixed))
      expect(last.split(fixed)).toHaveLength(3)
      await applyKnowledgeEdits(temp.path,dir,approvedB,unit,source)
      expect(await realFs.readFile(`${temp.path}/${record.target}`)).toBe(last)
    } finally {await temp.cleanup()}
  })
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
  it("replays audited replacements through the original checkpoint without resurrecting stale prose",async()=>{
    const temp=await createTempProject("knowledge-edited-replay")
    try {
      await fs.mkdir(`${temp.path}/wiki`)
      await realFs.writeFile(`${temp.path}/${source}`,text)
      const revised="每日记录完成情况，核对现场偏差并更新周计划。"
      const second="每日记录完成情况，结合现场偏差调整下一周期计划。"
      completion.mockImplementation(async(_c,m,cb)=>{
        const system=m[0].content
        cb.onToken(system.includes("成页后的反向") ? JSON.stringify({records:[],edits:[{target:record.target,before:record.body,after:revised,evidence:[unit.blocks[0].id]}]}) : system.includes("逐节知识") ? JSON.stringify({records:[record],context:[]}) : '{"issues":[]}')
        cb.onDone()
      })
      const options={projectPath:temp.path,sourceIdentity:source,sourceContent:text,schema:"",config:useWikiStore.getState().llmConfig,chapters:["第一章 管理"]}
      await ensureSectionKnowledge(options)
      const first=await realFs.readFile(`${temp.path}/${record.target}`)
      expect(first).toContain(revised)
      expect(first).not.toContain(record.body)
      const calls=completion.mock.calls.length
      await ensureSectionKnowledge(options)
      expect(completion).toHaveBeenCalledTimes(calls)
      const walk=async(dir:string):Promise<string[]>=>{const entries=await fs.readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]))).flat()}
      const journal=(await walk(`${temp.path}/.llm-wiki`)).find(p=>p.includes("revisions-"))!
      const dir=journal.slice(0,journal.lastIndexOf("/"))
      const saved=(await fs.readdir(dir)).filter(p=>/^[a-f0-9]{64}\.json$/.test(p))
      for (const name of saved) {
        const cp=JSON.parse(await realFs.readFile(`${dir}/${name}`))
        if (cp.unit.id.startsWith("links-")) continue
        cp.extraction.records.push({...record,id:"r2",disposition:"covered",existingQuote:record.body})
        await realFs.writeFile(`${dir}/${name}`,JSON.stringify(cp))
      }
      const nextEdits=validateKnowledgeEdits([{target:record.target,before:revised,after:second,evidence:[unit.blocks[1].id]}],unit,[{path:record.target,title:"",content:first}],source)
      await applyKnowledgeEdits(temp.path,dir,nextEdits,unit,source)
      await ensureSectionKnowledge(options)
      expect(completion).toHaveBeenCalledTimes(calls)
      expect(await realFs.readFile(`${temp.path}/${record.target}`)).toContain(second)
      // Simulate intent persisted but publication interrupted: replay from the
      // known before-image, without asking the model again.
      const revisions=JSON.parse(await realFs.readFile(journal))
      await realFs.writeFile(`${temp.path}/${record.target}`,first.replace(revisions[0].after,revisions[0].before))
      await ensureSectionKnowledge(options)
      expect(await realFs.readFile(`${temp.path}/${record.target}`)).toContain(second)
      expect(completion).toHaveBeenCalledTimes(calls)
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
