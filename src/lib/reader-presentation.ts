interface Node {
  type: string
  value?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

export const LOCATOR_PATTERN = /(?:epub-spine|pdf-page):[1-9]\d*\/block:[1-9]\d*/g
export const PREPARED_REFERENCE_PATTERN = /(?:raw\/sources\/)?[^\s`<>"/]+--[a-f0-9]{64}\.wiki-source\/source\.md/g

/** A display fallback only. Navigation always retains the original reference. */
export function referenceLabel(reference: string, title?: string): string {
  if (title?.trim()) return title.trim()
  const path = reference.split("#", 1)[0]
  const prepared = path.match(/(?:^|\/)([^/]+)--[a-f0-9]{64}\.wiki-source\/source\.md$/)
  if (prepared) return prepared[1]
  return path.split("/").pop()?.replace(/\.md$/i, "").replace(/[-_]/g, " ") || reference
}

/** Display metadata on parsed inline nodes; never rewrite saved Markdown. */
export function remarkReaderReferences() {
  return (tree: Node) => {
    const numbers = new Map<string, number>()
    const locator = (value: string): Node => {
      return { type: "text", value, data: {
        hName: "span", hProperties: { "data-reader-locator": value },
      } }
    }
    function visit(parent: Node) {
      if (!parent.children || ["code", "html", "link", "linkReference", "image", "imageReference"].includes(parent.type)) return
      parent.children = parent.children.flatMap((node): Node[] => {
        if (node.type === "inlineCode") {
          const value = node.value ?? ""
          if (/^(?:epub-spine|pdf-page):[1-9]\d*\/block:[1-9]\d*$/.test(value)) return [locator(value)]
          if (new RegExp(`^(?:${PREPARED_REFERENCE_PATTERN.source})$`).test(value)) {
            return [{ type: "text", value, data: { hName: "span", hProperties: { "data-reader-source": value } } }]
          }
        }
        if (node.type === "text") {
          const value = node.value ?? ""
          const parts: Node[] = []
          let end = 0
          for (const match of value.matchAll(LOCATOR_PATTERN)) {
            // Do not reinterpret a locator embedded in an identifier or URL.
            if (match.index > 0 && /[\w/:]/.test(value[match.index - 1])) continue
            if (/[\w/]/.test(value[match.index + match[0].length] ?? "")) continue
            parts.push({ type: "text", value: value.slice(end, match.index) }, locator(match[0]))
            end = match.index + match[0].length
          }
          if (end) return [...parts, { type: "text", value: value.slice(end) }]
        }
        visit(node)
        return [node]
      })
      // One range is one citation, not a numeric range of unrelated footnotes.
      const grouped: Node[] = []
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index]
        const first = node.data?.hProperties?.["data-reader-locator"]
        const separator = parent.children[index + 1]
        const last = parent.children[index + 2]?.data?.hProperties?.["data-reader-locator"]
        if (first && last && separator?.type === "text" && /^\s*[—–-]\s*$/.test(separator.value ?? "")
          && first.split(":", 1)[0] === last.split(":", 1)[0]) {
          grouped.push(locator(`${first} — ${last}`))
          index += 2
        } else grouped.push(node)
      }
      parent.children = grouped
    }
    visit(tree)
    function numberReferences(node: Node) {
      const value = node.data?.hProperties?.["data-reader-locator"]
      if (value) {
        if (!numbers.has(value)) numbers.set(value, numbers.size + 1)
        node.value = `[${numbers.get(value)}]`
      }
      node.children?.forEach(numberReferences)
    }
    numberReferences(tree)
  }
}
