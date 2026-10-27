//! Opt-in experiment against a marked, disposable copy of a knowledge base.
//! Uses the production index, search and CLI preflight runtime without changing app settings.
use std::{fs, path::PathBuf, time::Instant};
use serde_json::{json, Value};
use crate::{agent::{AgentRuntime, AgentChatRequest, provider::LlmConfig}, commands::{page_embedding, search, vectorstore}};

#[tokio::test]
#[ignore = "requires a marked knowledge-base copy and local Ollama; see docs/retrieval-validation.md"]
async fn real_retrieval_validation() {
    let root = PathBuf::from(std::env::var("WIKI_VALIDATION_COPY").expect("WIKI_VALIDATION_COPY required"));
    assert!(root.join(".retrieval-validation-copy").is_file(), "Refusing an unmarked project");
    let project = root.to_str().unwrap();
    let out = PathBuf::from(std::env::var("WIKI_VALIDATION_OUTPUT").expect("WIKI_VALIDATION_OUTPUT required"));
    fs::create_dir_all(&out).unwrap();
    let config: search::SearchEmbeddingConfig = serde_json::from_value(json!({
        "enabled": true, "endpoint":"http://127.0.0.1:11434/v1/embeddings",
        "apiKey":"", "model":"qwen3-embedding:8b", "maxChunkChars":1000, "overlapChunkChars":200
    })).unwrap();
    let action = std::env::var("WIKI_VALIDATION_ACTION").unwrap_or_else(|_| "queries".into());
    if action == "catalog" {
        fs::write(out.join("source-catalog.json"), serde_json::to_vec_pretty(&crate::agent::tools::source_catalog(project)).unwrap()).unwrap();
        return;
    }
    if action == "scale" {
        let mut measurements = Vec::new();
        for query in ["工期拖延怎么办", "BIM robot planning", "材料数据治理"] {
            for run in 0..4 {
                let start = Instant::now();
                let result = search::search_project_inner(project.into(), query.into(), 20, false, None).await.unwrap();
                measurements.push(json!({"query":query,"run":run,"elapsedMs":start.elapsed().as_millis(),"results":result.results.len(),"tokenHits":result.token_hits,"graphHits":result.graph_hits}));
            }
        }
        fs::write(out.join("scale.json"), serde_json::to_vec_pretty(&measurements).unwrap()).unwrap();
        return;
    }
    if action == "index" {
        let mut pages: Vec<_> = walkdir::WalkDir::new(root.join("wiki")).into_iter().filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md"))
            .filter(|e| !matches!(e.path().file_stem().and_then(|s| s.to_str()), Some("index"|"log"|"overview"|"purpose"|"schema")))
            .map(|e| e.path().strip_prefix(&root).unwrap().to_string_lossy().to_string()).collect();
        pages.sort();
        let total = pages.len();
        let mut results = Vec::new();
        for path in pages {
            let start = Instant::now();
            let result = match page_embedding::embed_wiki_page(project, &path, config.clone(), false).await {
                Ok(result) => json!({"result": result}),
                Err(error) => json!({"error": error.message}),
            };
            results.push(json!({"path":path,"elapsedMs":start.elapsed().as_millis(),"outcome":result}));
            fs::write(out.join("index.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            println!("indexed {}/{}", results.len(), total);
        }
        let count = vectorstore::vector_count_chunks(project.into()).await.unwrap();
        fs::write(out.join("index-count.json"), json!({"chunks":count}).to_string()).unwrap();
        assert!(results.iter().all(|r| r["outcome"]["error"].is_null()), "See index.json for provider/index errors");
        return;
    }
    let input: Value = serde_json::from_slice(&fs::read(std::env::var("WIKI_VALIDATION_QUESTIONS").unwrap()).unwrap()).unwrap();
    let questions = input.as_array().or_else(|| input["questions"].as_array()).expect("array or {questions: [...]} required");
    let cli_config: LlmConfig = serde_json::from_value(json!({"provider":"codex-cli","model":"gpt-6.1-terra"})).unwrap();
    let mut results = Vec::new();
    for question in questions {
        let query = question["query"].as_str().unwrap();
        let mut row = json!({"id": question["id"], "query":query});
        for hybrid in [false, true].into_iter().filter(|_| std::env::var("WIKI_VALIDATION_SKIP_COMPARISON").is_err()) {
            let label = if hybrid { "hybrid" } else { "keyword" };
            let start = Instant::now();
            let result = search::search_project(project.into(), query.into(), Some(20), Some(true), None, hybrid.then(|| config.clone())).await.unwrap();
            row[label] = json!({"elapsedMs":start.elapsed().as_millis(),"response":result});
        }
        row["source"] = json!(crate::agent::tools::search_sources(project, query, 8).unwrap());
        if action == "runtime" {
            for mode in ["standard", "smart", "faithful"] {
                let runtime = AgentRuntime::new("validation", project, if std::env::var("WIKI_VALIDATION_SKIP_COMPARISON").is_ok() { None } else { Some(config.clone()) }, Some(cli_config.clone()), None, None);
                let request: AgentChatRequest = serde_json::from_value(json!({"message":query,"retrievalQuery":question["retrievalQuery"],"sourcePaths":question.get("sourcePaths").cloned().unwrap_or(json!([])),"history":question.get("history").cloned().unwrap_or(json!([])),"mode":"standard","retrievalMode":mode,"persistSession":false,"allowEmptyRetrieval":true,"historyExplicit":true,"topK":5})).unwrap();
                let result = runtime.run_once(request).await.unwrap();
                row[mode] = json!(result);
            }
        }
        results.push(row);
        fs::write(out.join(format!("{action}.json")), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        println!("validated question {}", results.len());
    }
}
