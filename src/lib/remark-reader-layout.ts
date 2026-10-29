interface Node {
  type: string
  value?: string
  depth?: number
  url?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

function text(node: Node): string {
  return node.value ?? node.children?.map(text).join("") ?? ""
}

const boundary = /^<!-- section-knowledge:([a-f0-9]{64}):start -->$/
const isMetadata = (node: Node) => node.type === "paragraph" && /^类型：[^。]+。来源章节：/.test(text(node))
const legacyLocation = /(?:pdf-page|epub-spine):\d+\/block:\d+(?:[—–-]\d+)?|PDF物理页\s*\d+(?:[—–-]\d+)?|(?:页|区块|图|表)\s*\d+(?:[—–-]\d+)?|§\d+(?:\.\d+)*/g
function isEvidence(node: Node, sourceReferences: Record<string, string>): boolean {
  if (node.type !== "paragraph") return false
  if (!/^(?:定位|来源|证据|出处)：/.test(text(node)) || !node.children) return false
  // Legacy citations may contain source links and literal page/block tokens.
  // Any explanatory prose, image or other inline structure keeps the paragraph visible.
  if (node.children.some(n => !["text", "inlineCode", "link"].includes(n.type))) return false
  // Only unaliased links resolved to actual source files are known provenance.
  // Arbitrary links (including factual sentences used as labels) stay visible.
  if (node.children.some(n => n.type === "link" && (!n.url || !n.children?.length
    || n.children.some(child => child.type !== "text") || sourceReferences[n.url] !== text(n)))) return false
  const nonLinkText = node.children.filter(n => n.type !== "link").map(text).join("")
  if (node.children.filter(n => n.type === "link").length === 1
    && /^出处：\s*，行 \d+[–-]\d+；(?:unknown|(?:pdf-page|epub-spine):\d+\/block:\d+)。$/.test(nonLinkText)) return true
  let hasReference = node.children.some(n => n.type === "link" && Boolean(n.url))
  const residual = nonLinkText
    .replace(/^(?:定位|来源|证据|出处)：/, "")
    .replace(legacyLocation, () => { hasReference = true; return "" })
  return hasReference && /^[\s，,；;、。／/及和—–-]*$/.test(residual)
}

/** Reading-only AST layout. Original Markdown, evidence and source positions
 * remain available to editing, retrieval, indexing and selection mapping. */
export function remarkReaderLayout(options: { evidenceLabel: string; sourceReferences?: Record<string, string> }) {
  return (tree: Node) => {
    if (tree.type !== "root" || !tree.children) return
    const isCitation = (node: Node) => isEvidence(node, options.sourceReferences ?? {})

    function details(citations: Node[], count: number, metadata?: Node): Node {
      return { type: "readerEvidence", data: { hName: "details", hProperties: { "data-reader-evidence": "true" } }, children: [
        { type: "readerEvidenceSummary", data: { hName: "summary" }, children: [{ type: "text", value: `${options.evidenceLabel} · ${count}` }] },
        ...(metadata ? [metadata] : []), ...citations,
      ] }
    }

    // Free-form bibliography has no reliable sentence-level heuristic. Writers
    // explicitly separate it from knowledge; malformed spans remain visible.
    const evidenceStart = "<!-- wiki-evidence:start -->"
    const evidenceEnd = "<!-- wiki-evidence:end -->"
    const marker = (node: Node, value: string) => node.type === "html" && node.value?.trim() === value
    const safeEvidenceNode = (node: Node): boolean => node.type === "html"
      ? /^<!--\s*source-location:\s*(?:unknown|(?:pdf-page|epub-spine):\d+\/block:\d+(?:[–-]\d+)?)\s*-->$/.test(node.value?.trim() ?? "")
      : !["heading", "image", "imageReference", "code"].includes(node.type)
        && (node.children?.every(safeEvidenceNode) ?? true)
    const separated: Node[] = []
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i]
      if (!marker(node, evidenceStart)) { separated.push(node); continue }
      let level = 1, nested = false, end = i + 1
      for (; end < tree.children.length; end++) {
        if (marker(tree.children[end], evidenceStart)) { level++; nested = true }
        if (marker(tree.children[end], evidenceEnd) && --level === 0) break
      }
      if (end === tree.children.length) { separated.push(...tree.children.slice(i)); break }
      const content = tree.children.slice(i + 1, end)
      separated.push(...(!nested && content.length && content.every(safeEvidenceNode)
        ? [details(content, content.length)] : tree.children.slice(i, end + 1)))
      i = end
    }
    tree.children = separated

    const isInlineCitation = (node: Node) => node.type === "link"
      && /^(?:#)?raw(?:\/|%2f)sources(?:\/|%2f)/i.test(node.url ?? "")
      && /^(?:来源[:：]\s*)?L\d+(?:[–-]\d+)?(?:[，,]\s*(?:pdf-page|epub-spine):\d+\/block:\d+(?:[–-]\d+)?)?$/.test(text(node))
    const isSeparator = (node: Node) => node.type === "text" && /^[\s；;，,。]*$/.test(node.value ?? "")
    function foldInline(nodes: Node[]): Node[] {
      return nodes.flatMap(node => {
        if (node.type === "blockquote" || node.type === "readerEvidence") return [node]
        if (node.type !== "paragraph" || !node.children) {
          return [{ ...node, ...(node.children ? { children: foldInline(node.children) } : {}) }]
        }
        const start = node.children.findIndex(isInlineCitation)
        if (start < 0) return [node]
        const suffix = node.children.slice(start)
        // Only a pure citation suffix can move. A factual condition after a
        // citation, ordinary link, inline code or quoted example stays visible.
        if (!suffix.every(n => isInlineCitation(n) || isSeparator(n))) return [node]
        const prefix = node.children.slice(0, start)
        const onlyLabel = prefix.every(n => n.type === "text") && /^(?:出处|来源|定位|证据)[:：]\s*$/.test(prefix.map(text).join(""))
        return [
          ...(!onlyLabel && prefix.some(n => n.type !== "text" || n.value?.trim()) ? [{ ...node, children: prefix }] : []),
          details([{ ...node, children: onlyLabel ? node.children : suffix }], suffix.filter(isInlineCitation).length),
        ]
      })
    }
    tree.children = foldInline(tree.children)

    function fold(nodes: Node[], metadata?: Node): Node[] {
      const result: Node[] = []
      for (let i = 0; i < nodes.length; i++) {
        if (metadata && nodes[i].type === "readerEvidence" && nodes[i].children) {
          const [summary, ...content] = nodes[i].children!
          result.push({ ...nodes[i], children: [summary, metadata, ...content] })
          metadata = undefined
          continue
        }
        if (!isCitation(nodes[i])) { result.push(nodes[i]); continue }
        const citations = [nodes[i]]
        while (i + 1 < nodes.length && isCitation(nodes[i + 1])) citations.push(nodes[++i])
        result.push(details(citations, citations.length, metadata))
        metadata = undefined
      }
      return result
    }

    const result: Node[] = []
    let groupedRecords = false
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i]
      if (node.type === "heading" && (node.depth ?? 0) <= 2) groupedRecords = false
      const start = node.type === "html" && boundary.exec(node.value?.trim() ?? "")
      const end = start ? tree.children.findIndex((candidate, index) => index > i && candidate.type === "html"
        && candidate.value?.trim() === `<!-- section-knowledge:${start[1]}:end -->`) : -1
      if (!start || end < 0) { result.push(node); continue }
      // A heading immediately introducing managed blocks is an explicit group.
      // Keep its records nested, including consecutive blocks in the same group.
      const previous = result[result.length - 1]
      if (previous?.type === "heading" && previous.depth === 2) groupedRecords = true
      result.push(node)
      const contents = tree.children.slice(i + 1, end)
      let section: Node[] = []
      function flush() {
        const metadata = section.find(isMetadata)
        const canFold = metadata && section.some(n => isCitation(n) || n.type === "readerEvidence")
        result.push(...fold(canFold ? section.filter(n => n !== metadata) : section, canFold ? metadata : undefined))
        section = []
      }
      for (let j = 0; j < contents.length; j++) {
        const current = contents[j]
        // Only generated record headings become peers of the original h2s.
        const next = contents[j + 1]
        const startsRecord = next && (isMetadata(next)
          || (next.type === "readerEvidence" && next.children?.some(isMetadata)))
        if (current.type === "heading" && current.depth === 3 && startsRecord) {
          flush()
          section.push({ ...current, depth: groupedRecords ? 3 : 2 })
        } else section.push(current)
      }
      flush()
      result.push(tree.children[end])
      i = end
    }
    tree.children = fold(result)
  }
}
