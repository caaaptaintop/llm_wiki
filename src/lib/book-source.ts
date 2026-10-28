/** Locations explicitly supplied by the external source preparation step. */
function sourceMarkers(markdown: string) {
  const markers: Array<{ start: number; end: number; location: string }> = []
  let offset = 0, fence = ""
  for (const line of markdown.split(/(?<=\n)/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (fence[0] === delimiter[1][0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
    }
    if (!fence) {
      const match = /^<!-- source-location: ((?:pdf-page|epub-spine):[1-9]\d*\/block:[1-9]\d*|unknown) -->\s*$/.exec(line)
      if (match) markers.push({ start: offset, end: offset + line.length, location: match[1] })
    }
    offset += line.length
  }
  return markers
}

export function hasSourceLocations(markdown: string): boolean {
  return sourceMarkers(markdown).some((marker) => marker.location !== "unknown")
}

export function sourceLocationsForRange(markdown: string, start: number, end: number): string[] {
  const markers = sourceMarkers(markdown)
  if (markdown.slice(start, Math.min(end, markers[0]?.start ?? markdown.length)).trim()) return []
  const locations = new Set<string>()
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]
    const overlap = markdown.slice(Math.max(start, marker.end), Math.min(end, markers[index + 1]?.start ?? markdown.length))
    if (!overlap.trim()) continue
    if (marker.location === "unknown") return []
    locations.add(marker.location)
  }
  return [...locations]
}

/** Portable prepared sources use only images/ paths. Never fetch remote media. */
export function validateBookImagePath(value: string): string {
  if (!/^images\/(?:[^/\\:\u0000-\u001f]+\/)*[^/\\:\u0000-\u001f]+\.(?:png|jpe?g|webp|gif)$/i.test(value)
    || value.split("/").some((part) => part === "." || part === "..")) throw new Error("源文件图片需使用 images/ 下的相对路径；请先整理源文件包")
  return value
}

export function bookImagePaths(markdown: string): string[] {
  const paths = new Set<string>()
  let fence = ""
  const visible = markdown.split(/(?<=\n)/).map((line) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    const hidden = Boolean(fence || delimiter || /^( {4}|\t)/.test(line))
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (fence[0] === delimiter[1][0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = ""
    }
    return hidden ? "\n" : line
  }).join("").replace(/(`+)([\s\S]*?)\1/g, "")
  const escaped = (index: number) => (visible.slice(0, index).match(/\\+$/)?.[0].length ?? 0) % 2 === 1
  if (/<img\b/i.test(visible) || [...visible.matchAll(/!\[[^\]\n]*\](?!\()/g)].some((match) => !escaped(match.index!))) throw new Error("请先用源文件导出工具将图片引用整理为内联 Markdown")
  for (const match of visible.matchAll(/!\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    if (escaped(match.index!)) continue
    let value = match[1].trim()
    if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1)
    try { value = decodeURIComponent(value) } catch { throw new Error("图片路径编码无效") }
    paths.add(validateBookImagePath(value))
  }
  return [...paths].sort()
}
