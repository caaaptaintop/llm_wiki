export interface BookChapter {
  id: string
  index: number
  title: string
  kind: 'chapter' | 'section' | 'page' | 'frontmatter' | 'document'
  /** UTF-16 offsets into the original Markdown, end exclusive. */
  charStart: number
  charEnd: number
  /** Inclusive, 1-based lines in the original Markdown. */
  lineStart: number
  lineEnd: number
  /** Physical PDF page ordinals only; never inferred printed page numbers. */
  pdfPageStart?: number
  pdfPageEnd?: number
  epubPath?: string
  text: string
}

export interface BookStructure {
  version: 1
  sourceId: string
  sourcePath: string
  sourceHash: string
  title: string
  chapters: BookChapter[]
  warnings: string[]
}

interface Heading {
  start: number
  end: number
  level: number
  title: string
}

interface Marker {
  start: number
  end: number
  page?: number
  path?: string
}

interface Boundary {
  start: number
  title: string
  kind: BookChapter['kind']
}

const frontTitle = /^(?:book metadata|preface|foreword|prologue|introduction|acknowledg(?:e)?ments|contents|table of contents|序言|前言|序章|引言|导言|序|目录|版权(?:页)?|致谢)(?:$|[\s:：—–-])/i
const chapterTitle = /^(?:chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b|第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+[章回卷部])/i
const romanTitle = /^(?:[IVXLCDM]+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+)(?:$|[.、:：)\s])/u
const backTitle = /^(?:appendix|appendices|afterword|epilogue|bibliography|references|glossary|index|附录|后记|参考文献|索引|尾声|THE FULL PROJECT GUTENBERG.* LICENSE)(?:$|[\s:：—–-])/i

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const mid = (low + high) >>> 1
    if (starts[mid] <= offset) low = mid
    else high = mid
  }
  return low + 1
}

function scan(markdown: string, starts: number[], explicitHeadingsOnly = false) {
  const headings: Heading[] = []
  const pages: Marker[] = []
  const wrappers: Marker[] = []
  let fence = ''
  let fenceLength = 0
  let yaml = false
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = starts[i + 1] ?? markdown.length
    const line = markdown.slice(start, end).replace(/\r?\n$/, '')
    if (i === 0 && line.replace(/^\uFEFF/, '') === '---') {
      yaml = true
      continue
    }
    if (yaml) {
      if (/^(?:---|\.\.\.)\s*$/.test(line)) yaml = false
      continue
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence
        && delimiter[1].length >= fenceLength && !delimiter[2].trim()) fence = ''
      continue
    }
    if (delimiter) {
      fence = delimiter[1][0]
      fenceLength = delimiter[1].length
      continue
    }
    // Four-space/tab indentation is Markdown code, not a book heading.
    if (/^(?: {4}|\t)/.test(line)) continue
    const page = /^ {0,3}## Page ([1-9]\d*)\s*$/.exec(line)
    if (page) {
      pages.push({ start, end, page: Number(page[1]) })
      continue
    }
    const wrapper = /^ {0,3}## Chapter \d+ · (.+?)\s*$/.exec(line)
    if (wrapper) {
      wrappers.push({ start, end, path: wrapper[1] })
      continue
    }
    const atx = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/.exec(line)
    if (atx) {
      headings.push({ start, end, level: atx[1].length, title: atx[2].replace(/\s+#+\s*$/, '') })
    } else if (!explicitHeadingsOnly && chapterTitle.test(line.trim())) {
      // PDF extraction and html2text can emit unadorned chapter labels.
      headings.push({ start, end, level: 1, title: line.trim() })
    }
  }
  return { headings, pages, wrappers }
}

function isChapter(heading: Heading): boolean {
  return chapterTitle.test(heading.title) || romanTitle.test(heading.title)
}

function markerIndexAt(markers: Marker[], offset: number): number {
  let low = 0
  let high = markers.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (markers[mid].start <= offset) low = mid + 1
    else high = mid
  }
  return low - 1
}

/** Pure parser: no file I/O, normalization, hashing, or dependency on Tauri. */
export function buildBookStructure(input: {
  sourceId: string
  sourcePath: string
  sourceHash: string
  markdown: string
  title?: string
  /** Prepared Markdown already has repaired headings; prose is not a heading. */
  explicitHeadingsOnly?: boolean
}): BookStructure {
  const { markdown } = input
  const starts = lineStarts(markdown)
  const { headings, pages, wrappers } = scan(markdown, starts, input.explicitHeadingsOnly)
  const warnings: string[] = []
  const realChapters = headings.filter(isChapter)
  const firstContent = wrappers[0]?.start ?? realChapters[0]?.start ?? markdown.length
  const titleHeading = headings.find(h => h.level === 1 && h.start < firstContent
    && !isChapter(h) && !frontTitle.test(h.title))
  const filename = input.sourcePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '')
  const title = input.title?.trim() || titleHeading?.title || filename || input.sourceId
  const boundaries: Boundary[] = []
  const markers = [...pages, ...wrappers].sort((a, b) => a.start - b.start)

  // When a label immediately follows a physical page/spine marker, include that
  // marker with the new section instead of attributing it to the previous one.
  function addHeading(heading: Heading, kind: BookChapter['kind']) {
    let start = heading.start
    const marker = markers[markerIndexAt(markers, start)]
    if (marker && !markdown.slice(marker.end, start).trim()) start = marker.start
    boundaries.push({ start, title: heading.title, kind })
  }

  if (realChapters.length) {
    const first = realChapters[0].start
    const last = realChapters[realChapters.length - 1]
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]
      if (isChapter(heading)) {
        const label = heading.title.replace(/[.:：]\s*$/, '')
        const bareLabel = chapterTitle.exec(label)?.[0] === label
          || /^[IVXLCDMⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+$/.test(label)
        const next = headings[i + 1]
        const adjacentTitle = bareLabel && next && next.level === heading.level
          && !isChapter(next) && !frontTitle.test(next.title) && !backTitle.test(next.title)
          && !markdown.slice(heading.end, next.start).trim()
        addHeading({ ...heading, title: adjacentTitle ? `${heading.title} ${next.title}` : heading.title }, 'chapter')
      }
      else if (heading.start < first && frontTitle.test(heading.title)) addHeading(heading, 'frontmatter')
      else if (heading.start > last.start && heading.level <= last.level && backTitle.test(heading.title)) {
        const wrapper = wrappers[markerIndexAt(wrappers, heading.start)]
        // An appendix in its own spine file owns its opening notices as well as
        // its heading. Unlabelled continuation files still belong to the chapter.
        const ownsWrapper = wrapper && wrapper.start > last.start
          && !boundaries.some(b => b.start >= wrapper.start)
        if (ownsWrapper) boundaries.push({ start: wrapper.start, title: heading.title, kind: 'section' })
        else addHeading(heading, 'section')
      }
    }
  } else {
    // A single H1 followed by shallower content headings is the document title.
    const documentTitle = wrappers.length || headings.filter(h => h.level === 1).length === 1
      ? titleHeading : undefined
    const ordinary = headings.filter(h => h !== documentTitle && !frontTitle.test(h.title))
    const pool = ordinary.length || wrappers.length ? ordinary : headings.filter(h => !frontTitle.test(h.title))
    if (pool.length) {
      const level = pool.reduce((min, h) => Math.min(min, h.level), 6)
      const selected = new Set(pool)
      for (const heading of headings) {
        if (selected.has(heading) && heading.level === level) addHeading(heading, 'section')
        else if (frontTitle.test(heading.title) && heading.level <= level) addHeading(heading, 'frontmatter')
      }
    } else {
      for (const heading of headings.filter(h => frontTitle.test(h.title))) addHeading(heading, 'frontmatter')
    }
  }

  if (!boundaries.some(b => b.kind === 'chapter' || b.kind === 'section')) {
    const existingStarts = new Set(boundaries.map(b => b.start))
    if (wrappers.length) {
      // The spine is a source-file order, not an assertion about printed chapters.
      for (const wrapper of wrappers) {
        if (!existingStarts.has(wrapper.start)) {
          boundaries.push({ start: wrapper.start, title: wrapper.path!, kind: 'section' })
        }
      }
      warnings.push('EPUB 未识别到真实章节标题，按 spine 文件分段；序号不代表印刷章号。')
    } else if (pages.length) {
      for (const page of pages) {
        if (!existingStarts.has(page.start)) {
          boundaries.push({ start: page.start, title: `Page ${page.page}`, kind: 'page' })
        }
      }
      warnings.push('未识别到章节标题，按 PDF 物理页序分段；未推断印刷页码。')
    } else if (!boundaries.length) {
      boundaries.push({ start: 0, title, kind: 'document' })
      warnings.push('未识别到可用章节结构，保留为完整文档。')
    } else {
      warnings.push('仅识别到前置内容，未识别到正文章节。')
    }
  }
  boundaries.sort((a, b) => a.start - b.start)
  if (boundaries[0]?.start > 0) {
    if (markdown.slice(0, boundaries[0].start).trim()) {
      boundaries.unshift({ start: 0, title: '前置内容', kind: 'frontmatter' })
    } else boundaries[0].start = 0
  }

  const chapters: BookChapter[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]
    const end = boundaries[i + 1]?.start ?? markdown.length
    const text = markdown.slice(boundary.start, end)
    if (!text.trim()) continue
    const index = chapters.length + 1
    const chapter: BookChapter = {
      id: `${input.sourceId}-chapter-${index}`,
      index,
      title: boundary.title,
      kind: boundary.kind,
      charStart: boundary.start,
      charEnd: end,
      lineStart: lineAt(starts, boundary.start),
      lineEnd: lineAt(starts, Math.max(boundary.start, end - 1)),
      text,
    }
    // Intersect physical page intervals with the exact retained slice.
    const lastPage = markerIndexAt(pages, end - 1)
    if (lastPage >= 0) {
      chapter.pdfPageStart = pages[Math.max(0, markerIndexAt(pages, boundary.start))].page
      chapter.pdfPageEnd = pages[lastPage].page
    }
    const wrapper = wrappers[markerIndexAt(wrappers, boundary.start)]
      ?? wrappers.find(w => w.start < end && !markdown.slice(boundary.start, w.start).trim())
    if (wrapper) chapter.epubPath = wrapper.path
    chapters.push(chapter)
  }
  return {
    version: 1,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    title,
    chapters,
    warnings,
  }
}

function foldWhitespace(text: string) {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const offset = match.index!
    if (/^\s/.test(match[0])) {
      folded += ' '
      starts.push(offset)
      ends.push(offset + match[0].length)
    } else {
      folded += match[0]
      for (let i = 0; i < match[0].length; i++) {
        starts.push(offset + i)
        ends.push(offset + i + 1)
      }
    }
  }
  return { folded, starts, ends }
}

/** Return the first occurrence, preferring exact text over whitespace folding.
 * All returned offsets/lines refer to the original complete Markdown.
 * Unicode is preserved verbatim (including UTF-16 surrogate pairs); no fuzzy
 * matching, case folding, punctuation changes, or Unicode normalization.
 */
export function locateQuote(chapter: BookChapter, quote: string): {
  charStart: number
  charEnd: number
  lineStart: number
  lineEnd: number
} | null {
  if (!quote.trim()) return null
  let start = chapter.text.indexOf(quote)
  let end = start + quote.length
  if (start < 0) {
    const folded = foldWhitespace(chapter.text)
    const needle = quote.replace(/\s+/g, ' ').trim()
    const found = folded.folded.indexOf(needle)
    if (found < 0) return null
    start = folded.starts[found]
    end = folded.ends[found + needle.length - 1]
  }
  const lines = lineStarts(chapter.text)
  return {
    charStart: chapter.charStart + start,
    charEnd: chapter.charStart + end,
    lineStart: chapter.lineStart + lineAt(lines, start) - 1,
    lineEnd: chapter.lineStart + lineAt(lines, end - 1) - 1,
  }
}
