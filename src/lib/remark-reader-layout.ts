interface Node {
  type: string
  value?: string
  depth?: number
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

function text(node: Node): string {
  return node.value ?? node.children?.map(text).join("") ?? ""
}

const boundary = /^<!-- section-knowledge:([a-f0-9]{64}):start -->$/
const isMetadata = (node: Node) => node.type === "paragraph" && /^类型：[^。]+。来源章节：/.test(text(node))
const isEvidence = (node: Node) => node.type === "paragraph"
  && /^出处：.+，行 \d+[–-]\d+；(?:unknown|(?:pdf-page|epub-spine):\d+\/block:\d+)。$/.test(text(node))

/** Reading-only AST layout. Original Markdown, evidence and source positions
 * remain available to editing, retrieval, indexing and selection mapping. */
export function remarkReaderLayout(options: { evidenceLabel: string }) {
  return (tree: Node) => {
    if (tree.type !== "root" || !tree.children) return

    function fold(nodes: Node[], metadata?: Node): Node[] {
      const result: Node[] = []
      for (let i = 0; i < nodes.length; i++) {
        if (!isEvidence(nodes[i])) { result.push(nodes[i]); continue }
        const citations = [nodes[i]]
        while (i + 1 < nodes.length && isEvidence(nodes[i + 1])) citations.push(nodes[++i])
        result.push({ type: "readerEvidence", data: { hName: "details", hProperties: { "data-reader-evidence": "true" } }, children: [
          { type: "readerEvidenceSummary", data: { hName: "summary" }, children: [{ type: "text", value: `${options.evidenceLabel} · ${citations.length}` }] },
          ...(metadata ? [metadata] : []), ...citations,
        ] })
        metadata = undefined
      }
      return result
    }

    const result: Node[] = []
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i]
      const start = node.type === "html" && boundary.exec(node.value?.trim() ?? "")
      const end = start ? tree.children.findIndex((candidate, index) => index > i && candidate.type === "html"
        && candidate.value?.trim() === `<!-- section-knowledge:${start[1]}:end -->`) : -1
      if (!start || end < 0) { result.push(node); continue }
      result.push(node)
      const contents = tree.children.slice(i + 1, end)
      let section: Node[] = []
      function flush() {
        const metadata = section.find(isMetadata)
        const canFold = metadata && section.some(isEvidence)
        result.push(...fold(canFold ? section.filter(n => n !== metadata) : section, canFold ? metadata : undefined))
        section = []
      }
      for (let j = 0; j < contents.length; j++) {
        const current = contents[j]
        // Only generated record headings become peers of the original h2s.
        if (current.type === "heading" && current.depth === 3 && contents[j + 1] && isMetadata(contents[j + 1])) {
          flush()
          section.push({ ...current, depth: 2 })
        } else section.push(current)
      }
      flush()
      result.push(tree.children[end])
      i = end
    }
    tree.children = fold(result)
  }
}
