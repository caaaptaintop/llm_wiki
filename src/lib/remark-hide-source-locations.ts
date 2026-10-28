interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
}

const sourceLocation = /^<!-- source-location: (?:(?:pdf-page|epub-spine):[1-9]\d*\/block:[1-9]\d*|unknown) -->$/
const knowledgeBoundary = /^<!-- section-knowledge:[a-f0-9]{64}:(?:start|end) -->$/
const blockParents = new Set(["root", "blockquote", "listItem", "footnoteDefinition"])

/** Preview only: hide standalone location/recovery metadata, keeping source positions. */
export function remarkHideSourceLocations() {
  return (tree: MarkdownNode) => {
    function visit(parent: MarkdownNode) {
      if (!parent.children) return
      parent.children = parent.children.filter((node) => !(blockParents.has(parent.type)
        && node.type === "html" && (sourceLocation.test(node.value?.trim() ?? "")
          || knowledgeBoundary.test(node.value?.trim() ?? ""))))
      parent.children.forEach(visit)
    }
    visit(tree)
  }
}
