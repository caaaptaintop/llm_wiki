import { buildBookStructure } from "./book-structure"

export interface PreparedBookPart {
  chapterId: string
  chapterTitle: string
  chapterKind: string
  sectionTitles: string[]
  part: number
  parts: number
  main: string
  overlapBefore: string
}

/** Read chapter headings already supplied by the external preparation stage.
 * Keep original text and source-location pairs intact; never overlap chapters.
 */
export function planPreparedBook(
  markdown: string,
  targetChars: number,
  overlapChars: number,
  sourceBudget: number,
): PreparedBookPart[] | null {
  const structure = buildBookStructure({ sourceId: "prepared", sourcePath: "source.md", sourceHash: "", markdown, explicitHeadingsOnly: true })
  if (structure.chapters.filter(chapter => chapter.kind === "chapter").length < 2) return null
  const starts = structure.chapters.map(chapter => {
    const prefix = markdown.slice(0, chapter.charStart)
    // The location immediately before a chapter heading belongs to that heading.
    const location = /<!-- source-location: (?:pdf-page:\d+\/block:\d+|epub-spine:\d+\/block:\d+) -->\s*$/.exec(prefix)
    return location ? location.index : chapter.charStart
  })
  return structure.chapters.flatMap((chapter, index) => {
    const text = markdown.slice(starts[index], starts[index + 1] ?? markdown.length)
    const atoms = preparedAtoms(text)
    const headings = atoms.map(atom => /^ {0,3}(?:`{3,}|~{3,})/m.test(atom)
      ? null : /^(#{1,6})\s+(.+)$/m.exec(atom))
    const parentDepth = headings.find(Boolean)?.[1].length ?? 1
    const childDepth = Math.min(...headings.filter(heading => heading && heading[1].length > parentDepth).map(heading => heading![1].length))
    const sections: Array<{ title: string; atoms: string[] }> = []
    let section = { title: chapter.title, atoms: [] as string[] }
    atoms.forEach((atom, n) => {
      if (headings[n]?.[1].length === childDepth) {
        if (section.atoms.length) sections.push(section)
        section = { title: headings[n]![2], atoms: [] }
      }
      section.atoms.push(atom)
    })
    if (section.atoms.length) sections.push(section)
    // Prefer complete subsections. Only an oversized subsection is divided
    // further into intact paragraphs/tables/location units.
    const units = sections.flatMap(item => item.atoms.join("").length <= targetChars
      ? [item] : item.atoms.map(atom => ({ title: item.title, atoms: [atom] })))
    const groups: Array<typeof units> = []
    let current: typeof units = []
    let length = 0
    for (const unit of units) {
      const size = unit.atoms.join("").length
      if (size > sourceBudget) throw new Error(`章节“${chapter.title}”中的完整段落、表格或定位块超过单次正文预算；已保留原文，请在预处理阶段细分该结构。`)
      if (current.length && length + size > targetChars) {
        groups.push(current)
        current = []
        length = 0
      }
      current.push(unit)
      length += size
    }
    if (current.length) groups.push(current)
    return groups.map((group, part) => {
      const overlap: string[] = []
      if (part > 0) {
        for (const atom of groups[part - 1].flatMap(unit => unit.atoms).reverse()) {
          if (overlap.join("").length + atom.length > overlapChars) break
          overlap.unshift(atom)
        }
      }
      return { chapterId: chapter.id, chapterTitle: chapter.title, chapterKind: chapter.kind, sectionTitles: [...new Set(group.map(unit => unit.title))], part: part + 1, parts: groups.length, main: group.flatMap(unit => unit.atoms).join(""), overlapBefore: overlap.join("") }
    })
  })
}

/** Atomic Markdown/source units. A budget may not cut a table, fenced block,
 * or a verified location's text away from its opening/reset markers. */
function preparedAtoms(text: string): string[] {
  const atoms: string[] = []
  let start = 0
  let offset = 0
  let located = false
  let fence = ""
  let table = false
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    offset += line.length
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
      continue
    }
    if (delimiter) { fence = delimiter[1]; continue }
    if (/^<!-- source-location: (?!unknown\b)/.test(line)) located = true
    const reset = /^<!-- source-location: unknown -->\s*$/.test(line)
    if (reset) located = false
    if (/<table\b/i.test(line)) table = true
    if (/<\/table\s*>/i.test(line)) table = false
    if (!located && !table && (reset || !line.trim())) {
      atoms.push(text.slice(start, offset))
      start = offset
    }
  }
  if (start < text.length) atoms.push(text.slice(start))
  return atoms
}
