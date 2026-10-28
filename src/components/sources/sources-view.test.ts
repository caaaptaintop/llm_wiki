import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import { filterPreparedSourceArtifacts, filterSourceTreeByQuery, summarizeImportOutcome } from "./sources-view"

const TREE: FileNode[] = [
  {
    name: "Books",
    path: "/project/raw/sources/Books",
    is_dir: true,
    children: [
      { name: "BookA.md", path: "/project/raw/sources/Books/BookA.md", is_dir: false },
      { name: "三阶段治疗模型.pdf", path: "/project/raw/sources/Books/三阶段治疗模型.pdf", is_dir: false },
    ],
  },
  { name: "notes.txt", path: "/project/raw/sources/notes.txt", is_dir: false },
]

describe("filterPreparedSourceArtifacts", () => {
  const packagePath = `/project/raw/sources/书籍--${"a".repeat(64)}.wiki-source`
  const file = (path: string): FileNode => ({ name: path.split("/").pop()!, path, is_dir: false })
  const folder = (path: string, children: FileNode[]): FileNode => ({ name: path.split("/").pop()!, path, is_dir: true, children })

  it("keeps the managed package and source.md while hiding its manifest and asset subtrees without mutation", () => {
    const source = file(`${packagePath}/source.md`)
    const tree = [folder("/project/raw/sources/Books", [folder(packagePath, [
      source,
      file(`${packagePath}/manifest.json`),
      folder(`${packagePath}/images`, [file(`${packagePath}/images/cover.jpg`)]),
      folder(`${packagePath}/assets`, [file(`${packagePath}/assets/source.md`)]),
    ])])]
    const original = structuredClone(tree)
    expect(filterPreparedSourceArtifacts(tree)).toEqual([
      folder("/project/raw/sources/Books", [folder(packagePath, [source])]),
    ])
    expect(tree).toEqual(original)
  })

  it("preserves ordinary images, JSON and non-managed folders with similar names", () => {
    const tree = [
      file("/project/raw/sources/cover.jpg"),
      file("/project/raw/sources/manifest.json"),
      folder("/project/raw/sources/draft.wiki-source", [
        file("/project/raw/sources/draft.wiki-source/manifest.json"),
        folder("/project/raw/sources/draft.wiki-source/images", [file("/project/raw/sources/draft.wiki-source/images/cover.jpg")]),
      ]),
    ]
    expect(filterPreparedSourceArtifacts(tree)).toEqual(tree)
  })

  it("prunes managed packages and parent folders left empty after filtering auxiliaries", () => {
    expect(filterPreparedSourceArtifacts([folder("/project/raw/sources/Books", [folder(packagePath, [
      file(`${packagePath}/manifest.json`), folder(`${packagePath}/images`, []),
    ])])])).toEqual([])
    expect(filterPreparedSourceArtifacts([folder(packagePath, [])])).toEqual([])
  })

  it("preserves originally empty ordinary directories, including nested and unspecified children", () => {
    const tree = [
      folder("/project/raw/sources/Empty", []),
      folder("/project/raw/sources/Parent", [folder("/project/raw/sources/Parent/Empty", [])]),
      { name: "Unloaded", path: "/project/raw/sources/Unloaded", is_dir: true },
    ]
    expect(filterPreparedSourceArtifacts(tree)).toEqual(tree)
  })
})

describe("filterSourceTreeByQuery", () => {
  it("keeps parent folders while removing non-matching siblings", () => {
    const result = filterSourceTreeByQuery(TREE, "booka")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("matches Unicode names and normalized path segments", () => {
    expect(filterSourceTreeByQuery(TREE, "治疗模型")[0].children?.[0].name)
      .toBe("三阶段治疗模型.pdf")
    expect(filterSourceTreeByQuery(TREE, "BOOKS")).toEqual([TREE[0]])
  })

  it("returns a new top-level array for an empty query without mutating nodes", () => {
    const result = filterSourceTreeByQuery(TREE, "  ")
    expect(result).toEqual(TREE)
    expect(result).not.toBe(TREE)
  })

  it("returns an empty tree when no source matches", () => {
    expect(filterSourceTreeByQuery(TREE, "missing source")).toEqual([])
  })
})

describe("summarizeImportOutcome", () => {
  it("stays silent when every selected file was imported", () => {
    expect(
      summarizeImportOutcome({ imported: ["/project/raw/sources/a.md"], skipped: [] }, null),
    ).toBeNull()
  })

  it("reports which files were left out of a partial import", () => {
    expect(
      summarizeImportOutcome(
        {
          imported: ["/project/raw/sources/a.md"],
          skipped: [{ name: "審查資料範例.pdf", reason: "too-large", detail: "142.8 MB" }],
        },
        null,
      ),
    ).toEqual({
      importedCount: 1,
      skipped: [{ name: "審查資料範例.pdf", reason: "too-large", detail: "142.8 MB" }],
      error: null,
    })
  })

  it("surfaces a thrown import error that today only reaches the console", () => {
    expect(
      summarizeImportOutcome(null, new Error("Cannot import the project folder")),
    ).toEqual({
      importedCount: 0,
      skipped: [],
      error: "Cannot import the project folder",
    })
  })

  it("reports nothing imported when the picker yielded no usable file", () => {
    expect(
      summarizeImportOutcome({ imported: [], skipped: [{ name: "a.py", reason: "unsupported-type" }] }, null),
    ).toEqual({
      importedCount: 0,
      skipped: [{ name: "a.py", reason: "unsupported-type" }],
      error: null,
    })
  })
})
