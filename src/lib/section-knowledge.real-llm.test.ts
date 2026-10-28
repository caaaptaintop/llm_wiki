import { it, expect, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { realFs } from "@/test-helpers/fs-temp"
import { buildPrompt, parseCodexCliLine } from "./codex-cli-transport"
import type { StreamCallbacks, ChatMessage } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => ({ ...realFs, readFileAsBase64:async(file:string)=>({base64:(await fs.readFile(file)).toString("base64"),mime_type:"application/octet-stream"}), writeWikiFileIfUnchanged:async(root:string,relative:string,expected:string|null,contents:string)=>{
  const file=path.join(root,relative)
  let current:string|null=null
  try {current=await fs.readFile(file,"utf8")}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e}
  if(current!==expected)throw new Error("Validation copy changed concurrently")
  // Node adapter is used only on the marked isolated copy with no active editor.
  // Native mutex/CAS behavior is covered by the Rust command tests separately.
  await fs.mkdir(path.dirname(file),{recursive:true})
  const tmp=`${file}.validation-tmp`;await fs.writeFile(tmp,contents);await fs.rename(tmp,file)
}, writeFileAtomic: async (p: string, text: string) => {
  await fs.mkdir(path.dirname(p), {recursive:true})
  const temp = `${p}.validation-tmp`
  await fs.writeFile(temp,text); await fs.rename(temp,p)
} }))
vi.mock("./llm-client", () => ({streamChat: realCompletion}))
// Image extraction was validated in the original ingestion. This opt-in test
// exercises the unchanged-source coverage upgrade, not image re-import.
vi.mock("./extract-source-images",()=>({extractAndSaveSourceImages:async()=>[],extractAndSaveMarkdownImages:async()=>[],buildImageMarkdownSection:()=>""}))

let calls=0
const runId=Date.now()
async function realCompletion(config:LlmConfig,messages:ChatMessage[],callbacks:StreamCallbacks,signal?:AbortSignal) {
  const out=process.env.SECTION_OUTPUT!, root=process.env.SECTION_COPY!
  // Reuse arguments exported from the actual Rust launcher, including its Mem
  // isolation. No independent approximation of the user's safety configuration.
  const args: string[]=JSON.parse(await fs.readFile(process.env.SECTION_CLI_ARGS!,"utf8"))
  expect(args[args.indexOf("--model")+1]).toBe("gpt-6.1-terra")
  expect(config.model).toBe("gpt-6.1-terra")
  expect(args).toContain("--ephemeral")
  expect(args[args.indexOf("--sandbox")+1]).toBe("read-only")
  expect(args.some(a=>a.includes("ignore-"))).toBe(false)
  expect(args.some(a=>a.includes("hooks.state="))).toBe(true)
  const n=++calls, prefix=path.join(out,`calls/${runId}-${String(n).padStart(3,"0")}`)
  await fs.mkdir(path.dirname(prefix),{recursive:true})
  const prompt=buildPrompt(messages)+"\n只使用上述提供的材料，不调用任何工具、读取文件或记忆。按上述要求的格式输出。"
  await fs.writeFile(`${prefix}-prompt.txt`,prompt)
  console.log(`Terra call ${n} started (${prompt.length} chars)`)
  const began=Date.now()
  const result=await new Promise<{text:string;itemTypes:string[]}>((resolve,reject)=>{
    const child=spawn("codex",args,{cwd:root,stdio:["pipe","pipe","pipe"]})
    let stdout=""; child.stderr.resume(); child.stdout.on("data",b=>{stdout+=b.toString()})
    const stop=()=>child.kill("SIGTERM")
    const timer=setTimeout(stop,20*60_000);signal?.addEventListener("abort",stop,{once:true})
    child.on("error",reject)
    child.on("close",code=>{
      clearTimeout(timer);signal?.removeEventListener("abort",stop)
      if(code!==0) return reject(new Error(`CLI completion exit ${code}`))
      const lines=stdout.split(/\r?\n/),itemTypes=lines.flatMap(line=>{try{const e=JSON.parse(line);return e.type==="item.completed"?[e.item.type]:[]}catch{return []}})
      if(itemTypes.some(t=>t!=="agent_message"&&t!=="reasoning")) return reject(new Error(`Unexpected tool use: ${itemTypes.join(",")}`))
      resolve({text:lines.flatMap(line=>{const t=parseCodexCliLine(line);return t?[t]:[]}).join("\n\n"),itemTypes})
    })
    child.stdin.end(prompt)
  })
  await fs.writeFile(`${prefix}.json`,JSON.stringify({...result,model:config.model,elapsedMs:Date.now()-began},null,2))
  console.log(`Terra call ${n} completed (${result.text.length} chars; ${Math.round((Date.now()-began)/1000)}s)`)
  callbacks.onToken(result.text);callbacks.onDone()
}

import { ensureSectionKnowledge, planKnowledgeUnits } from "./section-knowledge"
import { useWikiStore } from "@/stores/wiki-store"
import { withProjectLock } from "./project-mutex"
import { buildCliChatEvidence } from "./cli-chat-evidence"

it.skipIf(process.env.RUN_SECTION_KNOWLEDGE!=="1")("supplements prepared book knowledge on the existing isolated copy",async()=>{
  const action=process.env.SECTION_ACTION
  if(action && !["answer","ingest"].includes(action)) throw new Error("Unsupported SECTION_ACTION; one-off data repairs are maintained outside the source repository")
  const root=path.resolve(process.env.SECTION_COPY!),out=path.resolve(process.env.SECTION_OUTPUT!)
  await fs.access(path.join(root,".retrieval-validation-copy"))
  const config={...useWikiStore.getState().llmConfig,provider:"codex-cli" as const,model:"gpt-6.1-terra",maxContextSize:524288,reasoning:{mode:"auto" as const}}
  if(process.env.SECTION_ACTION==="answer") {
    const selectedIds=process.env.SECTION_IDS?.split(",")
    const runtime=JSON.parse(await fs.readFile(path.join(out,"runtime/runtime.json"),"utf8")).filter((r:{id:string})=>!selectedIds||selectedIds.includes(r.id))
    const answerDir=process.env.SECTION_ANSWERS_DIR??"answers"
    if(!/^[a-zA-Z0-9_-]+$/.test(answerDir))throw new Error("Invalid validation output directory")
    await fs.mkdir(path.join(out,answerDir),{recursive:true})
    let next=0
    await Promise.all([0,1].map(async()=>{
      while(next<runtime.length){
        const row=runtime[next++],file=path.join(out,`${answerDir}/${row.id}.json`)
        try {await fs.access(file);continue}catch { /* resume missing answers */ }
        const result=row.smart
        const evidence=buildCliChatEvidence("smart",row.query,result.message,result.references,process.env.SECTION_SCOPE_LABEL??"仅所选来源")
        let answer=""
        await realCompletion(config,[{role:"system",content:evidence.system},{role:"user",content:evidence.context}],{onToken:t=>{answer+=t},onDone:()=>{},onError:e=>{throw e}})
        await fs.writeFile(file,JSON.stringify({id:row.id,query:row.query,answer,references:result.references,context:evidence.context,system:evidence.system,requestedModel:config.model},null,2))
      }
    }))
    return
  }
  const sourceIdentity=process.env.SECTION_SOURCE
  if(!sourceIdentity || !sourceIdentity.startsWith("raw/sources/") || sourceIdentity.split("/").some(p=>!p || p==="." || p==="..") || sourceIdentity.includes("\\")) {
    throw new Error("SECTION_SOURCE must name a relative source file inside raw/sources/")
  }
  const sourceContent=await fs.readFile(path.join(root,sourceIdentity),"utf8")
  const plan=planKnowledgeUnits(sourceContent)
  await fs.mkdir(out,{recursive:true})
  await fs.writeFile(path.join(out,"unit-plan.json"),JSON.stringify(plan,null,2))
  console.log(JSON.stringify(plan.map(u=>({id:u.id,chapter:u.chapter,sections:u.section,blocks:u.blocks.length,chars:u.blocks.reduce((n,b)=>n+b.text.length,0)}))))
  if(process.env.SECTION_PLAN_ONLY==="1")return
  const chapters=process.env.SECTION_CHAPTERS?.split("|")
  const fsSchema=await fs.readFile(path.join(root,"schema.md"),"utf8")
  if(process.env.SECTION_ACTION==="ingest") {
    const {autoIngest}=await import("./ingest")
    useWikiStore.setState({project:{id:"section-validation",name:"隔离补全验证",path:root},llmConfig:config,embeddingConfig:{...useWikiStore.getState().embeddingConfig,enabled:false},sourceWatchConfig:{...useWikiStore.getState().sourceWatchConfig,persistExtractedMarkdown:false}})
    const paths=await autoIngest(root,path.join(root,sourceIdentity),config)
    expect(calls).toBe(0)
    await fs.writeFile(path.join(out,"original-ingest-resume.json"),JSON.stringify({paths,calls,scope:"Real original autoIngest cache-hit and coverage check; Node FS adapter; image extraction reused, no repeated model generation"},null,2))
    return
  }
  const coverageFeedback=process.env.SECTION_FEEDBACK?JSON.parse(await fs.readFile(process.env.SECTION_FEEDBACK,"utf8")):undefined
  const paths=await withProjectLock(root,()=>ensureSectionKnowledge({projectPath:root,sourceIdentity,sourceContent,schema:fsSchema,config,chapters,coverageFeedback,onProgress:console.log}))
  await fs.writeFile(path.join(out,`result-${chapters?"selected":"all"}.json`),JSON.stringify({paths,calls,chapters:chapters??"all",model:config.model,finishedAt:new Date().toISOString()},null,2))
  expect(await fs.readFile(path.join(root,sourceIdentity),"utf8")).toBe(sourceContent)
}, 180*60_000)
