import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { readSourceProcessingStatus, type SourceProcessingStatus } from "@/lib/source-processing-status"

interface SourceProcessingDialogProps {
  projectPath: string
  sourcePath: string
  sourceName: string
  ingestStatus: string
  enqueueing: boolean
  ingestError: string | null
  queueError: string | null
  onClose: () => void
  onImagesOnly: () => void
  onIngest: () => void
}

export function SourceProcessingDialog({
  projectPath, sourcePath, sourceName, ingestStatus, enqueueing, ingestError, queueError, onClose, onIngest, onImagesOnly,
}: SourceProcessingDialogProps) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const taskModelRouting = useWikiStore((s) => s.taskModelRouting)
  const projectLlmOverride = useWikiStore((s) => s.projectLlmOverride)
  const customLlmPresets = useWikiStore((s) => s.customLlmPresets)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const ingestConfig = useMemo(() => getTaskLlmConfig("ingest", llmConfig),
    [llmConfig, providerConfigs, taskModelRouting, projectLlmOverride, customLlmPresets])
  const [status, setStatus] = useState<SourceProcessingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setStatus(null)
    setReadError(null)
    // Only the selected source is read. Closing, changing project/source,
    // or changing the effective model invalidates any earlier response.
    readSourceProcessingStatus(projectPath, sourcePath, ingestConfig)
      .then((result) => { if (active) setStatus(result) })
      .catch((error: unknown) => {
        if (active) setReadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectPath, sourcePath, ingestConfig, ingestStatus, outputLanguage, revision])

  const queued = ingestStatus === "pending" || ingestStatus === "processing"
  const undescribed = status
    ? Math.max(0, status.images.extracted - status.images.described - status.images.unreadable)
    : 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>{t("sources.processing.details", "处理详情")}</DialogTitle>
          <DialogDescription className="break-words">{status?.title ?? sourceName}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1 text-sm">
          <p className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
            {t("sources.processing.boundary", "继续处理会复用已有入库结果与图片描述；原始资料保持不变。")}
          </p>
          <p className="text-xs text-muted-foreground">仅补充图片需匹配入库缓存并开启图片描述；复用原图片流程，不重写正文，不核验文字覆盖。此前失败的全文任务保留，可单独继续。</p>

          <section className="space-y-2">
            <h3 className="font-medium">{t("sources.processing.models", "当前处理配置")}</h3>
            <p className="break-words text-xs text-muted-foreground">
              {t("sources.processing.ingestModel", "入库模型：")}{ingestConfig.model || t("sources.processing.unset", "未配置")}
            </p>
            <p className="text-xs">
              {t("sources.processing.imageSwitch", "图片描述：")}
              {multimodalConfig.enabled ? t("sources.processing.enabled", "已开启") : t("sources.processing.disabled", "已关闭")}
            </p>
            <p className="break-words text-xs text-muted-foreground">
              {multimodalConfig.useMainLlm
                ? t("sources.processing.mainModel", "使用主模型（入库模型）：")
                : t("sources.processing.separateModel", "使用独立图片模型：")}
              {(multimodalConfig.useMainLlm ? ingestConfig.model : multimodalConfig.model) || t("sources.processing.unset", "未配置")}
            </p>
            {!multimodalConfig.enabled && (
              <div className="space-y-2 rounded-md border p-3 text-xs text-muted-foreground">
                <p>{t("sources.processing.enableHint", "需要图片描述时，请前往原设置 → 图片描述开启，再继续提取。")}</p>
                <Button variant="outline" size="sm" onClick={() => { onClose(); setActiveView("settings") }}>
                  {t("sources.processing.openSettings", "前往设置")}
                </Button>
              </div>
            )}
          </section>

          {loading && <p role="status" className="text-xs text-muted-foreground">{t("sources.processing.loading", "正在读取此来源的处理记录…")}</p>}
          {readError && <p role="alert" className="break-words text-xs text-destructive">{t("sources.processing.readFailed", "处理记录读取失败：")}{readError}</p>}

          {status && <>
            <section className="space-y-2">
              <h3 className="font-medium">{t("sources.processing.cache", "入库缓存")}</h3>
              <p className="text-xs text-muted-foreground">
                {status.ingested === null
                  ? t("sources.processing.cacheUnknown", "未核定；此处不为查看状态重新解析来源。")
                  : status.ingested
                    ? t("sources.processing.cacheFound", "当前来源有匹配的入库缓存。")
                    : t("sources.processing.cacheMissing", "当前来源没有匹配的入库缓存。")}
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="font-medium">{t("sources.processing.images", "图片记录")}</h3>
              <p className="text-xs text-muted-foreground">{t("sources.processing.imageCounts", "已提取：{{extracted}}；有描述缓存：{{described}}；尚无描述：{{missing}}", {
                extracted: status.images.extracted, described: status.images.described, missing: undescribed,
              })}</p>
              <p className="text-xs text-muted-foreground">{t("sources.processing.unreadable", "无法读取、描述状态未知：{{count}}（单列，不计入尚无描述）", { count: status.images.unreadable })}</p>
            </section>

            <details className="space-y-2 rounded-md border p-3">
              <summary className="cursor-pointer font-medium">{status.chapters.length
                ? `${t("sources.processing.chapters", "章节文本记录")} · ${status.chapters.length} 章，${status.chapters.reduce((n, c) => n + c.saved, 0)} / ${status.chapters.reduce((n, c) => n + c.total, 0)} 批次已保存`
                : t("sources.processing.originalTextFlow", "文本记录 · 原版入库流程")}</summary>
              {status.chapters.length === 0
                ? <p className="text-xs text-muted-foreground">{t("sources.processing.noChapters", "暂无匹配的逐节记录，请结合下方统计边界查看。")}</p>
                : <ul className="space-y-2">
                    {status.chapters.map((chapter, index) => <li key={`${index}:${chapter.title}`} className="space-y-1 rounded-md border p-3">
                      <p className="break-words font-medium">{chapter.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("sources.processing.saved", "已保存文本批次：{{saved}} / {{total}}", { saved: chapter.saved, total: chapter.total })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("sources.processing.issues", "待修正：{{pending}}；异常：{{invalid}}", { pending: chapter.pending, invalid: chapter.invalid })}
                      </p>
                    </li>)}
                  </ul>}
            </details>

            <details className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">{t("sources.processing.notes", "范围与核验说明")}</summary>
              <p>已保存记录和图片描述不等于知识覆盖或回答正确性已通过验收。</p>
              {status.notes.map((note, index) => <p key={index} className="break-words">{note}</p>)}
            </details>
          </>}

          {(ingestError || (ingestStatus === "failed" && queueError)) && (
            <p role="alert" className="break-words text-xs text-destructive">{ingestError || queueError}</p>
          )}
          {queued && <p role="status" className="text-xs text-muted-foreground">
            {ingestStatus === "processing" ? t("sources.processing.running", "正在原处理队列中提取。") : t("sources.processing.queued", "已在原处理队列中等待。")}
          </p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)} disabled={loading}>
            {t("sources.processing.refresh", "刷新记录")}
          </Button>
          <Button variant="outline" onClick={onImagesOnly}
            disabled={enqueueing || queued || loading || status?.ingested !== true || !multimodalConfig.enabled}>
            仅补充图片
          </Button>
          <Button onClick={onIngest} disabled={enqueueing || queued}>
            {enqueueing ? t("sources.processing.enqueueing", "正在加入队列…") : t("sources.processing.continue", "继续提取到 Wiki")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
