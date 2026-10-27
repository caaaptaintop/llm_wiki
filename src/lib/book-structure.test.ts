import { describe, expect, it } from 'vitest'
import { buildBookStructure, locateQuote } from './book-structure'
import type { BookStructure } from './book-structure'

function build(markdown: string, title?: string): BookStructure {
  return buildBookStructure({
    sourceId: 'source-42',
    sourcePath: 'raw/sources/样书.epub',
    sourceHash: 'unchanged-hash',
    markdown,
    title,
  })
}

// Check retained content independently of how the parser chooses boundaries.
function expectCoverage(markdown: string, structure: BookStructure) {
  let previousEnd = 0
  for (const chapter of structure.chapters) {
    expect(chapter.charStart).toBeGreaterThanOrEqual(previousEnd)
    expect(markdown.slice(previousEnd, chapter.charStart).trim()).toBe('')
    expect(chapter.text).toBe(markdown.slice(chapter.charStart, chapter.charEnd))
    expect(chapter.charEnd).toBeGreaterThan(chapter.charStart)
    expect(chapter.lineStart).toBe(markdown.slice(0, chapter.charStart).split('\n').length)
    expect(chapter.lineEnd).toBe(markdown.slice(0, chapter.charEnd - 1).split('\n').length)
    previousEnd = chapter.charEnd
  }
  expect(markdown.slice(previousEnd).trim()).toBe('')
}

describe('buildBookStructure', () => {
  it('recognizes Chinese chapters and preserves metadata and preface verbatim', () => {
    const markdown = '# 样书\n\n作者：某人\n\n## 序言\n序言正文\n\n## 第一章 起点\n正文一\n### 第一节\n细节\n\n## 第2章 终点\n正文二\n'
    const result = build(markdown)
    expect(result.version).toBe(1)
    expect(result.sourceId).toBe('source-42')
    expect(result.sourcePath).toBe('raw/sources/样书.epub')
    expect(result.sourceHash).toBe('unchanged-hash')
    expect(result.title).toBe('样书')
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter', 'frontmatter', 'chapter', 'chapter'])
    expect(result.chapters.map(c => c.title)).toEqual(['前置内容', '序言', '第一章 起点', '第2章 终点'])
    expect(result.chapters[2].text).toContain('### 第一节\n细节')
    expect(result.chapters.map(c => c.text).join('')).toBe(markdown)
    expect(result.warnings).toEqual([])
    expectCoverage(markdown, result)
  })

  it.each([
    ['# CHAPTER I\nFirst\n## Chapter II: Next\nSecond', ['CHAPTER I', 'Chapter II: Next']],
    ['# I\nFirst\n# II. Next\nSecond', ['I', 'II. Next']],
    ['# Ⅰ 开始\nFirst\n# Ⅱ 继续\nSecond', ['Ⅰ 开始', 'Ⅱ 继续']],
    ['CHAPTER ONE\nFirst\nCHAPTER TWO\nSecond', ['CHAPTER ONE', 'CHAPTER TWO']],
    ['第一章 开始\nFirst\n第二章 继续\nSecond', ['第一章 开始', '第二章 继续']],
  ])('recognizes English/Roman/Chinese labels: %s', (markdown, titles) => {
    const result = build(markdown)
    expect(result.chapters.map(c => c.title)).toEqual(titles)
    expect(result.chapters.every(c => c.kind === 'chapter')).toBe(true)
    expectCoverage(markdown, result)
  })

  it('uses real EPUB titles and nearest spine paths without equating spine and chapter numbers', () => {
    const markdown = '# A Book\n\n## Book metadata\n- Format: EPUB\n- Author: Someone\n'
      + '\n## Chapter 1 · OEBPS/preface.xhtml\n\n# Preface\nBefore the book\n'
      + '\n## Chapter 7 · OEBPS/Text/a.xhtml\n\n# CHAPTER I\nFirst\n'
      + '\n## Chapter 8 · OEBPS/Text/continued.xhtml\n\nContinuation\n'
      + '\n## Chapter 12 · OEBPS/Text/b.xhtml\n\n## CHAPTER II\nSecond\n'
    const result = build(markdown)
    const chapters = result.chapters.filter(c => c.kind === 'chapter')
    expect(chapters.map(c => c.title)).toEqual(['CHAPTER I', 'CHAPTER II'])
    expect(chapters.map(c => c.epubPath)).toEqual(['OEBPS/Text/a.xhtml', 'OEBPS/Text/b.xhtml'])
    expect(chapters[0].text).toContain('OEBPS/Text/continued.xhtml')
    expect(chapters[0].text).toContain('Continuation')
    expect(result.chapters.some(c => c.kind === 'frontmatter' && c.text.includes('Before the book'))).toBe(true)
    expect(result.chapters.some(c => c.kind === 'frontmatter' && c.text.includes('- Author: Someone'))).toBe(true)
    expectCoverage(markdown, result)
  })

  it('falls back to spine sections with a warning when EPUB has no real headings', () => {
    const markdown = '# A Book\n## Book metadata\n- Format: EPUB\n'
      + '## Chapter 3 · OEBPS/a.xhtml\nText\n## Chapter 5 · OEBPS/b.xhtml\nMore'
    const result = build(markdown)
    const sections = result.chapters.filter(c => c.kind === 'section')
    expect(sections.map(c => c.title)).toEqual(['OEBPS/a.xhtml', 'OEBPS/b.xhtml'])
    expect(sections.map(c => c.epubPath)).toEqual(['OEBPS/a.xhtml', 'OEBPS/b.xhtml'])
    expect(result.warnings.join('')).toContain('spine')
    expectCoverage(markdown, result)
  })

  it('merges adjacent chapter label/title for display and separates a trailing license spine', () => {
    const markdown = '# Book\n## Book metadata\n- Author: Someone\n## Contents\n[CHAPTER I.][1]\n'
      + '## Chapter 5 · a.xhtml\n\n## CHAPTER I.\n## Looking-Glass House\n\nFirst\n'
      + '## Chapter 15 · b.xhtml\n\n## CHAPTER XI.\n## Waking\n\nA kitten.\n'
      + '## CHAPTER XII.\n## Which Dreamed it?\n\nLast\nTHE END\n'
      + '## Chapter 16 · license.xhtml\n\n*** END OF THE PROJECT GUTENBERG EBOOK BOOK ***\nNotices\n'
      + '## THE FULL PROJECT GUTENBERG™ LICENSE\nLicense text'
    const result = build(markdown)
    const chapters = result.chapters.filter(c => c.kind === 'chapter')
    expect(chapters.map(c => c.title)).toEqual([
      'CHAPTER I. Looking-Glass House', 'CHAPTER XI. Waking', 'CHAPTER XII. Which Dreamed it?',
    ])
    expect(chapters[1].epubPath).toBe('b.xhtml')
    expect(chapters[2].epubPath).toBe('b.xhtml')
    expect(chapters[2].text).toContain('THE END')
    expect(chapters[2].text).not.toContain('END OF THE PROJECT GUTENBERG')
    expect(chapters[0].text).toContain('## CHAPTER I.\n## Looking-Glass House')
    const appendix = result.chapters[result.chapters.length - 1]
    expect(appendix.kind).toBe('section')
    expect(appendix.title).toBe('THE FULL PROJECT GUTENBERG™ LICENSE')
    expect(appendix.epubPath).toBe('license.xhtml')
    expect(appendix.text.startsWith('## Chapter 16 · license.xhtml')).toBe(true)
    expect(appendix.text).toContain('Notices')
    expect(result.chapters.map(c => c.text).join('')).toBe(markdown)
    expectCoverage(markdown, result)
  })

  it('only combines adjacent peer headings, keeping body subheadings and later appendices separate', () => {
    const markdown = '# CHAPTER I\n### A subheading\nBody\n'
      + '# CHAPTER II\nText before a heading\n# Another heading\nBody\n'
      + '# CHAPTER III\n# CHAPTER IV\nFourth\n'
      + '# Appendix A\nAppendix body\n# References\nReferences body'
    const result = build(markdown)
    expect(result.chapters.map(c => [c.kind, c.title])).toEqual([
      ['chapter', 'CHAPTER I'], ['chapter', 'CHAPTER II'], ['chapter', 'CHAPTER III'],
      ['chapter', 'CHAPTER IV'], ['section', 'Appendix A'], ['section', 'References'],
    ])
    expectCoverage(markdown, result)
  })

  it('keeps EPUB metadata as frontmatter when internal titles have no chapter numbers', () => {
    const markdown = '# Book\n## Book metadata\n- Author: Someone\n'
      + '## Chapter 1 · a.xhtml\n# The Beginning\nOne\n'
      + '## Chapter 2 · b.xhtml\n# The End\nTwo'
    const result = build(markdown)
    expect(result.chapters.filter(c => c.kind === 'section').map(c => c.title))
      .toEqual(['The Beginning', 'The End'])
    expect(result.chapters.find(c => c.text.includes('- Author: Someone'))?.kind).toBe('frontmatter')
    expectCoverage(markdown, result)
  })

  it('maps chapters spanning physical PDF pages and attaches a new page marker to its chapter', () => {
    const markdown = '## Page 1\n\nCHAPTER I\nFirst page\n'
      + '\n## Page 2\n\nContinuation\n![](media/img-1.png)\n'
      + '\n## Page 3\n\nCHAPTER II\nSecond chapter\n'
    const result = build(markdown)
    expect(result.chapters.map(c => c.title)).toEqual(['CHAPTER I', 'CHAPTER II'])
    expect(result.chapters.map(c => [c.pdfPageStart, c.pdfPageEnd])).toEqual([[1, 2], [3, 3]])
    expect(result.chapters[0].text).toContain('![](media/img-1.png)')
    expect(result.chapters[1].text.startsWith('## Page 3')).toBe(true)
    expectCoverage(markdown, result)
  })

  it('allows two chapters on the same PDF page and retains cover material', () => {
    const markdown = '## Page 1\n\nCover and copyright\n\nCHAPTER I\nFirst\n'
      + '## Page 2\nContinuation\nCHAPTER II\nSecond'
    const result = build(markdown)
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter', 'chapter', 'chapter'])
    expect(result.chapters.map(c => [c.pdfPageStart, c.pdfPageEnd])).toEqual([[1, 1], [1, 2], [2, 2]])
    expectCoverage(markdown, result)
  })

  it('falls back to PDF pages with a warning and preserves text before the first page', () => {
    const markdown = 'Import metadata\n## Page 1\nHello\n## Page 2\nWorld'
    const result = build(markdown)
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter', 'page', 'page'])
    expect(result.chapters.map(c => c.pdfPageStart)).toEqual([undefined, 1, 2])
    expect(result.warnings.join('')).toContain('物理页')
    expectCoverage(markdown, result)
  })

  it('retains an identified PDF preface as frontmatter during page fallback', () => {
    const markdown = '## Page 1\n# Preface\nBefore\n## Page 2\nUnstructured body'
    const result = build(markdown)
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter', 'page'])
    expect(result.chapters.map(c => c.pdfPageStart)).toEqual([1, 2])
    expect(result.warnings).toHaveLength(1)
    expectCoverage(markdown, result)
  })

  it('segments ordinary reports by the top content headings', () => {
    const markdown = '# Annual report\nIntro\n## Overview\nBody\n### Detail\nSubsection\n## Conclusion\nEnd'
    const result = build(markdown)
    expect(result.title).toBe('Annual report')
    expect(result.chapters.map(c => c.title)).toEqual(['前置内容', 'Overview', 'Conclusion'])
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter', 'section', 'section'])
    expect(result.chapters[1].text).toContain('### Detail')
    expectCoverage(markdown, result)
  })

  it('keeps all peer H1 sections rather than dropping the first as a book title', () => {
    const markdown = '# Overview\nOne\n# Methods\nTwo\n# Results\nThree'
    const result = build(markdown)
    expect(result.chapters.map(c => c.title)).toEqual(['Overview', 'Methods', 'Results'])
    expectCoverage(markdown, result)
  })

  it('falls back to a document, uses the supplied title, and tolerates empty input', () => {
    const markdown = '😀 无标题正文\r\n第二行\r\n'
    const result = build(markdown, ' 明确书名 ')
    expect(result.title).toBe('明确书名')
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].kind).toBe('document')
    expect(result.warnings).toHaveLength(1)
    expectCoverage(markdown, result)
    expect(build('').chapters).toEqual([])
    expect(build(' \n\t').chapters).toEqual([])
    expect(build('').warnings.length).toBeGreaterThan(0)
  })

  it('gives repeated/renamed titles distinct stable source-and-sequence IDs', () => {
    const markdown = '# 第一章 ../标题\nA\n# 第一章 ../标题\nB'
    const result = build(markdown)
    expect(result.chapters.map(c => c.index)).toEqual([1, 2])
    expect(result.chapters.map(c => c.id)).toEqual(['source-42-chapter-1', 'source-42-chapter-2'])
    expect(result.chapters.every(c => !/[<>:"/\\|?*\[\]]/.test(c.id))).toBe(true)
    expect(build(markdown.split('../标题').join('新标题')).chapters.map(c => c.id))
      .toEqual(result.chapters.map(c => c.id))
    expectCoverage(markdown, result)
  })

  it('keeps a preface-only source as frontmatter with a missing-body warning', () => {
    const markdown = '# 前言\n只有序言正文'
    const result = build(markdown)
    expect(result.chapters.map(c => c.kind)).toEqual(['frontmatter'])
    expect(result.warnings.join('')).toContain('未识别到正文章节')
    expectCoverage(markdown, result)
  })

  it('ignores fenced/indented fake headings, wrapper/page markers, and YAML headings', () => {
    const markdown = '---\n# CHAPTER 90\ntitle: Hidden\n---\n# Book\n'
      + '```md\n# CHAPTER 91\n## Page 92\n## Chapter 93 · fake.xhtml\n```\n'
      + '~~~\n# 第九十四章\n~~~\n    # CHAPTER 95\n\tCHAPTER 96\n'
      + '# CHAPTER I\nReal\n````text\n# CHAPTER 97\n```\n# CHAPTER 98\n````\n'
      + '# CHAPTER II\nEnd'
    const result = build(markdown)
    expect(result.chapters.filter(c => c.kind === 'chapter').map(c => c.title)).toEqual(['CHAPTER I', 'CHAPTER II'])
    expect(result.chapters.every(c => c.pdfPageStart === undefined && c.epubPath === undefined)).toBe(true)
    expectCoverage(markdown, result)
  })
})

describe('locateQuote', () => {
  const markdown = '# 第一本\n前言\n# 第一章\n😀 café\t中文\r\n下一行\nRepeated\twords\nRepeated words\n'
  const chapter = build(markdown).chapters.find(c => c.kind === 'chapter')!

  it('locates exact Unicode text using original full-document UTF-16 offsets', () => {
    const quote = '😀 café\t中文\r\n下一行'
    const found = locateQuote(chapter, quote)!
    expect(found).toEqual({
      charStart: markdown.indexOf(quote),
      charEnd: markdown.indexOf(quote) + quote.length,
      lineStart: 4,
      lineEnd: 5,
    })
    expect(markdown.slice(found.charStart, found.charEnd)).toBe(quote)
  })

  it('maps collapsed whitespace back through CRLF/tabs without shifting Unicode offsets', () => {
    const found = locateQuote(chapter, '  😀 café 中文 下一行  ')!
    expect(markdown.slice(found.charStart, found.charEnd)).toBe('😀 café\t中文\r\n下一行')
    expect(found.lineStart).toBe(4)
    expect(found.lineEnd).toBe(5)
    const nbsp = build('A\u00a0\u2003B\nC').chapters[0]
    const range = locateQuote(nbsp, 'A B C')!
    expect(nbsp.text.slice(range.charStart, range.charEnd)).toBe(nbsp.text)
  })

  it('prefers an exact occurrence over an earlier whitespace-equivalent occurrence', () => {
    const found = locateQuote(chapter, 'Repeated words')!
    expect(found.charStart).toBe(markdown.indexOf('Repeated words'))
    expect(found.lineStart).toBe(7)
    expect(found.lineEnd).toBe(7)
  })

  it.each(['', ' \r\n\t\u00a0', '不存在', 'CAFÉ', 'cafe\u0301', '第一本'])('rejects empty/absent/altered/out-of-chapter quotes: %s', quote => {
    expect(locateQuote(chapter, quote)).toBeNull()
  })

  it('returns the first exact occurrence when quotes repeat', () => {
    const local = build('😀 quoted\nquoted').chapters[0]
    expect(locateQuote(local, 'quoted')).toEqual({ charStart: 3, charEnd: 9, lineStart: 1, lineEnd: 1 })
  })
})
