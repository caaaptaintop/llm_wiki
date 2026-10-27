---
author: admin
last_modified_by: admin
---
# 检索对照验收

该验收调用应用实际的 Rust 建库、Wiki 检索、原文检索和 CLI 检索准备函数。默认测试跳过它；显式执行需要一个含 `.retrieval-validation-copy` 标记的隔离知识库，避免误在日常资料上建索引。

先复制 `wiki/`、`raw/` 及项目用途/结构文件到独立目录，并在副本写入上述标记。测试只在副本建立 `.llm-wiki/lancedb`，不修改应用全局模型或向量设置。页面数包括聚合页，索引排除 index/log/overview/purpose/schema。

准备 JSON 问题集：根可以是数组或含 `questions` 数组的对象，每题至少有 `id`、`query`。质量判读另保留原文逐字引文、行号、预期事实及候选 Wiki 路径。题目中的文献别名需有明确映射；没有映射的“论文1/2”不能用于单独归因跨语言能力。

在 `src-tauri/` 执行，绝对路径由执行者换成隔离实验路径：

```bash
export WIKI_VALIDATION_COPY='/absolute/path/to/isolated-copy'
export WIKI_VALIDATION_OUTPUT='/absolute/path/to/results'
export WIKI_VALIDATION_QUESTIONS='/absolute/path/to/questions.json'
WIKI_VALIDATION_ACTION=index cargo test --lib retrieval_validation::real_retrieval_validation -- --ignored --nocapture
WIKI_VALIDATION_ACTION=runtime cargo test --lib retrieval_validation::real_retrieval_validation -- --ignored --nocapture
```

`index` 使用本机已有 Ollama `qwen3-embedding:8b`、`http://127.0.0.1:11434/v1/embeddings`，按内容/模型指纹跳过已完成页，记录每页结果及向量数。没有该模型时不要自动下载或改用收费服务。批量建库请求允许120秒，整页模型阶段仍限制300秒；交互查询仍为8秒，超时降级。不同硬件需要另测，不能把本机通过推广为所有部署通过。

`runtime` 分别记录关键词＋图谱、关键词＋向量＋图谱、原文片段，以及 Codex CLI 的标准/智能/只读原文三种检索准备输出。它**不会调用生成模型**，模型配置仅用于选择真实 CLI 准备路径。真实回答必须另行通过既有 CLI 传输验证，并分别记录请求模型、实际可见元数据、输入证据、回答和额外工具调用。

`scale` 可用于带同样标记的合成 Wiki 库，记录三查询各四次关键词＋图谱后端耗时；它不证明向量规模、UI性能或知识质量。

判读时区分：找到相关页面、取得足够原文、回答正确且有依据。前五项命中预期页不能叫“正确率”；找到任意原文片段不能叫“覆盖率”。保留缺证据、否定例、跨材料要求、草稿身份与仿真边界。源库哈希应在实验前后逐一核对。

## 长文、范围和跨语种增量（2026-10-27）

沿用已有隔离副本与题集。已完成的向量建库和规模测试不必重做；`WIKI_VALIDATION_SKIP_COMPARISON=1` 只运行当前 CLI 检索准备，不查询向量。`catalog` 动作输出与界面相同的来源目录。每题可带 `history`（用户定义的别名）、`sourcePaths`（精确 raw 文件路径）和 `retrievalQuery`（规划后的检索串）；原始 `query` 始终是最终问题，规划文本不算证据。

```bash
WIKI_VALIDATION_ACTION=catalog cargo test --lib retrieval_validation::real_retrieval_validation -- --ignored --nocapture
WIKI_VALIDATION_SKIP_COMPARISON=1 WIKI_VALIDATION_ACTION=runtime cargo test --lib retrieval_validation::real_retrieval_validation -- --ignored --nocapture
```

真实规划与回答使用 `src/lib/cli-retrieval.real-llm.test.ts`，默认跳过。先在结果目录准备 `questions.json`、`source-catalog.json`；从源码根目录执行：

```bash
export WIKI_CLI_VALIDATION_OUTPUT='/absolute/path/to/results'
export WIKI_VALIDATION_COPY='/absolute/path/to/isolated-copy'
export WIKI_CLI_VALIDATION_MODEL='gpt-6.1-terra'
WIKI_CLI_VALIDATION_ACTION=plan npx vitest run src/lib/cli-retrieval.real-llm.test.ts
# 把 plan 中的 retrievalQuery/sourcePaths 合入问题集，运行上面的 Rust runtime 动作。
# 最终检索结果应放在结果目录的 runtime/runtime.json。
WIKI_CLI_VALIDATION_ACTION=answer WIKI_CLI_VALIDATION_MODES=smart,faithful npx vitest run src/lib/cli-retrieval.real-llm.test.ts
```

`WIKI_CLI_VALIDATION_IDS=Q01,Q14` 可做增量；已有答案模式会复用，缺少的模式才调用模型。解析器变更时 `WIKI_CLI_VALIDATION_REPARSE=1` 重解析已保存的规划响应，不再请求模型。每次调用保留请求模型/推理档位、返回内容、耗时、用量和 item 类型；响应未暴露实际模型身份时明确记 `not exposed`。非回答的额外工具/动作会使验收失败。

规划复用当前应用模型，解析当前问题、近期用户消息与来源目录；未定义或歧义指代请求澄清。范围在排序前过滤：Wiki 页全部声明来源都须在所选范围内，无来源页排除；原文限定精确文件。当前限定来源搜索禁用向量与全库反链上下文，以避免旧向量身份和范围外邻接信息混入。没有来源范围的旧检索继续沿用原路径。新 `retrievalQuery/sourcePaths` 请求字段目前只接入 CLI，HTTP 路径会明确报未接入，不能声称所有 provider 等效。

长 Wiki 页按问题选择分散的相关段落，保留原始行号；原文按段落词频和区分度排序，对完整字母数字标识符保留精确边界。两个模式仍各只有一次有界检索，不保证全部问题证据完整。

判读分开记录：证据 `full/partial/missing/refusal_sufficient/clarification_expected`；回答正确性；出处可核验性。出处可用精确文件路径与正文行号，或该片段已有且经原文核对的页/区块定位；不能把摘录附近的定位猜为印刷页。模型追加的会话保存状态不是答案证据，应单独记录为输出噪声。
