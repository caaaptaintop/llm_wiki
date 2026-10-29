//! Bounded lexical passages from existing source text; no index or cache writes.
use super::{
    ensure_project_bound_path, is_hidden_rel, relative_to_project, AgentReference,
    MAX_SOURCE_SEARCH_FILES, MAX_SOURCE_SNIPPET_CHARS,
};
use crate::commands::{fs::read_preprocessed_cache, search::tokenize_query};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

struct Hit {
    reference: AgentReference,
    offset: usize,
    end_offset: usize,
    explicit_table: bool,
}

pub(super) fn search(
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    search_scoped(project_path, query, top_k, &[])
}

pub(super) fn search_scoped(project_path: &str, query: &str, top_k: usize, source_paths: &[String]) -> Result<Vec<AgentReference>, String> {
    validate_scope(project_path, source_paths)?;
    let query = query.trim();
    if query.is_empty() {
        return Err("source.search query is required".to_string());
    }
    // The shared tokenizer also emits CJK single characters for wiki search.
    // They are too weak as standalone source evidence for a natural question.
    let terms = retrieval_terms(query)
        .into_iter()
        .filter(|term| term.chars().count() >= 2)
        .filter(|term| {
            !matches!(
                term.as_str(),
                "raw"
                    | "source"
                    | "sources"
                    | "file"
                    | "files"
                    | "原始资料"
                    | "原始文件"
                    | "源文件"
                    | "怎样"
                    | "如何"
                    | "怎么"
                    | "哪些"
                    | "是否"
                    | "请问"
                    | "通过"
                    | "进行"
                    | "可以"
                    | "以及"
            )
        })
        .collect::<Vec<_>>();
    let root = Path::new(project_path).join("raw/sources");
    if terms.is_empty() || !root.exists() || ensure_project_bound_path(project_path, &root).is_err()
    {
        return Ok(Vec::new());
    }
    let limit = top_k.clamp(1, 10);
    let requested_tables = labeled_numbers(query, &["表", "table"]);
    if source_paths.len() > limit { return Err(format!("选择了{}份来源，但检索预算只有{limit}条；请减少来源或增加 topK。", source_paths.len())); }

    let mut hits = Vec::<Hit>::new();
    let mut packages = BTreeSet::<PathBuf>::new();
    let entries = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if entry.file_type().is_symlink()
                || is_hidden_rel(&relative_to_project(project_path, path))
            {
                return false;
            }
            // A suffix alone is not a package. Ordinary JSON and image notes
            // stay searchable unless source.md and a recognized manifest exist.
            if packages.contains(path.parent().unwrap_or(path))
                && matches!(
                    path.file_name().and_then(|s| s.to_str()),
                    Some("manifest.json" | "images")
                )
            {
                return false;
            }
            if entry.file_type().is_dir() && source_package_manifest(project_path, path).is_some() {
                packages.insert(path.to_path_buf());
            }
            true
        });
    let mut seen_files = 0;
    let phrase = query.to_lowercase();
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        seen_files += 1;
        if seen_files > MAX_SOURCE_SEARCH_FILES {
            eprintln!("[Agent] source.search stopped after {MAX_SOURCE_SEARCH_FILES} files in {project_path}");
            break;
        }
        if ensure_project_bound_path(project_path, entry.path()).is_err() {
            continue;
        }
        let rel = relative_to_project(project_path, entry.path());
        if !source_paths.is_empty() && !source_paths.contains(&rel) { continue; }
        let Some((content, cached)) = read_source(project_path, entry.path()) else {
            continue;
        };
        let title = source_title(project_path, entry.path(), &content);
        let org_headings = entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("org"));
        let passages = passages(&content, org_headings);
        let stats = PassageStats::new(&passages, &terms);
        for (index, passage) in passages.iter().enumerate() {
            for (start, end, score) in passage.windows(&terms, &phrase, cached, &stats) {
                let (snippet, offset, end_offset) =
                    snippet_with_neighbors(&content, &passages, index, start, end, cached);
                let explicit_table = table_after_caption(&passages, index)
                    .filter(|number| requested_tables.contains(number))
                    .is_some_and(|_| end_offset >= passages[index + 1].offset + passages[index + 1].text.len());
                if let Some(hit) = hits.iter_mut().find(|hit| {
                    hit.reference.path == rel
                        && hit.offset == offset
                        && hit.end_offset == end_offset
                }) {
                    // Several matching steps can expand to the same evidence.
                    // Keep its best anchor score without counting it repeatedly.
                    hit.reference.score = Some(hit.reference.score.unwrap_or(0.0).max(score));
                    hit.explicit_table |= explicit_table;
                } else {
                    hits.push(Hit {
                        reference: AgentReference {
                            title: title.clone(),
                            path: rel.clone(),
                            kind: "source".to_string(),
                            snippet: Some(snippet),
                            score: Some(score),
                            knowledge_context: None,
                        },
                        offset,
                        end_offset,
                        explicit_table,
                    });
                }
                // Keep memory bounded while still considering the whole walk.
                hits.sort_by(|a, b| {
                    b.explicit_table.cmp(&a.explicit_table).then_with(|| b.reference
                        .score
                        .partial_cmp(&a.reference.score)
                        .unwrap())
                        .then_with(|| a.reference.path.cmp(&b.reference.path))
                        .then_with(|| a.offset.cmp(&b.offset))
                });
                if source_paths.len() > 1 {
                    let mut per_source = std::collections::BTreeMap::<String, usize>::new();
                    hits.retain(|hit| {
                        let count = per_source.entry(hit.reference.path.clone()).or_default();
                        *count += 1;
                        *count <= limit
                    });
                } else { hits.truncate(limit); }
            }
        }
    }
    let mut selected = Vec::new();
    // Comparisons reserve a slot for each requested source with a match.
    if source_paths.len() > 1 {
        for path in source_paths {
            if let Some(index) = hits.iter().position(|hit| &hit.reference.path == path) {
                selected.push(hits.remove(index).reference);
            }
        }
    }
    selected.extend(hits.into_iter().map(|hit| hit.reference));
    selected.truncate(limit);
    Ok(selected)
}

fn source_package_manifest(project: &str, directory: &Path) -> Option<serde_json::Value> {
    let source = directory.join("source.md");
    let manifest = directory.join("manifest.json");
    if !source.is_file()
        || ensure_project_bound_path(project, &source).is_err()
        || ensure_project_bound_path(project, &manifest).is_err()
        || !fs::metadata(&manifest).is_ok_and(|m| m.is_file() && m.len() <= 1024 * 1024)
    {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&fs::read_to_string(manifest).ok()?)
        .ok()
        .filter(|value| {
            value["version"] == 1
                && value["source"]["filename"] == "source.md"
                && value["images"].is_array()
        })
}

fn source_title(project: &str, path: &Path, content: &str) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let manifest = (name == "source.md")
        .then(|| source_package_manifest(project, path.parent()?))
        .flatten();
    let Some(manifest) = manifest else {
        return name.to_string();
    };
    manifest["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            content.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("# ")
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
            })
        })
        .or_else(|| {
            manifest["original"]["filename"]
                .as_str()
                .filter(|title| !title.trim().is_empty())
        })
        .unwrap_or(&name)
        .chars()
        .take(200)
        .collect()
}

fn read_source(project: &str, path: &Path) -> Option<(String, bool)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" | "org" | "txt" | "json" | "csv" | "tsv" | "yaml" | "yml" | "xml"
        | "html" => fs::read_to_string(path).ok().map(|text| (text, false)),
        "pdf" | "doc" | "docx" | "docm" | "ppt" | "pps" | "pot" | "pptx" | "pptm" | "ppsx"
        | "ppsm" | "xls" | "xlsx" | "xlsm" | "xlsb" | "odt" | "ods" | "odp" | "rtf" | "epub"
        | "mobi" => {
            // The existing reader checks freshness and Office parser versions.
            // Check both text and marker paths before it follows any symlink.
            let cache = path
                .parent()?
                .join(".cache")
                .join(format!("{}.txt", path.file_name()?.to_str()?));
            if ensure_project_bound_path(project, &cache).is_err() {
                return None;
            }
            let marker = cache.with_extension("txt.parser");
            if marker.exists() && ensure_project_bound_path(project, &marker).is_err() {
                return None;
            }
            read_preprocessed_cache(path).map(|text| (text, true))
        }
        _ => None,
    }
}

pub(super) fn validate_scope(project: &str, paths: &[String]) -> Result<(), String> {
    if paths.len() > 20 { return Err("最多选择20份来源".into()); }
    if paths.iter().collect::<BTreeSet<_>>().len() != paths.len() { return Err("来源范围不能包含重复路径".into()); }
    for path in paths {
        if !path.starts_with("raw/sources/") || path.contains('\\')
            || Path::new(path).components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err("来源范围必须是项目 raw/sources 内的文件".into());
        }
        let full = Path::new(project).join(path);
        ensure_project_bound_path(project, &full)?;
        if !full.is_file() { return Err(format!("来源不存在: {path}")); }
        if let Some(parent) = full.parent() {
            if source_package_manifest(project, parent).is_some()
                && full.file_name().and_then(|s| s.to_str()) != Some("source.md") {
                return Err("来源清单不属于可问答正文".into());
            }
        }
    }
    Ok(())
}

pub(super) fn catalog(project: &str) -> Vec<serde_json::Value> {
    let root = Path::new(project).join("raw/sources");
    if ensure_project_bound_path(project, &root).is_err() { return Vec::new(); }
    let mut packages = BTreeSet::<PathBuf>::new();
    let mut result = Vec::new();
    for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|e| {
        let path = e.path();
        if e.file_type().is_symlink() || is_hidden_rel(&relative_to_project(project, path)) { return false; }
        if packages.contains(path.parent().unwrap_or(path)) && matches!(path.file_name().and_then(|s| s.to_str()), Some("manifest.json" | "images")) { return false; }
        if e.file_type().is_dir() && source_package_manifest(project, path).is_some() { packages.insert(path.to_path_buf()); }
        true
    }).filter_map(Result::ok).filter(|e| e.file_type().is_file()).take(MAX_SOURCE_SEARCH_FILES) {
        if ensure_project_bound_path(project, entry.path()).is_err() { continue; }
        let Some((text, _)) = read_source(project, entry.path()) else { continue; };
        let mut aliases = vec![entry.file_name().to_string_lossy().to_string()];
        if let Some(manifest) = entry.path().parent().and_then(|p| source_package_manifest(project, p)) {
            if let Some(name) = manifest["original"]["filename"].as_str() { aliases.push(name.to_string()); }
        }
        result.push(serde_json::json!({"path":relative_to_project(project, entry.path()), "title":source_title(project, entry.path(), &text), "aliases":aliases}));
    }
    result.sort_by(|a,b| a["path"].as_str().cmp(&b["path"].as_str()));
    result
}

/// Select actual passages anywhere in a long Wiki page, with original line
/// numbers. Metadata is blanked (not removed), so offsets remain attributable.
pub(super) fn relevant_excerpt(content: &str, query: &str, budget: usize) -> String {
    let normalized = content.replace("\r\n", "\n");
    let body = crate::commands::page_embedding::strip_frontmatter(&normalized);
    let prefix = normalized.len() - body.len();
    let text = format!("{}{}", "\n".repeat(normalized[..prefix].bytes().filter(|c| *c == b'\n').count()), body);
    let terms = retrieval_terms(query);
    let ps = passages(&text, false);
    let stats = PassageStats::new(&ps, &terms);
    let mut candidates = Vec::new();
    let mut neighborhoods = std::collections::BTreeMap::new();
    for (index, p) in ps.iter().enumerate() {
        for (start, end, score) in p.windows(&terms, &query.to_lowercase(), false, &stats) {
            // A section supplies the subject omitted by its follow-up paragraphs.
            // Rank table rows independently so unrelated rows do not dilute a
            // requested value, while returning the unchanged table with its scope.
            let window = &p.text[start..end];
            let score = if p.is_navigation(window) { score } else {
                let quality = p.quality(window);
                let section_score = stats.score(&prose_for_ranking(p.section).to_lowercase(), &terms) * 0.5 * quality;
                let row_score = window.lines()
                    .filter(|line| line.trim_start().starts_with('|'))
                    .map(|line| stats.score(&prose_for_ranking(line).to_lowercase(), &terms) * quality)
                    .fold(score, f64::max);
                row_score + section_score
            };
            let (offset, end_offset) = (p.offset + start, p.offset + end);
            neighborhoods.insert((offset, end_offset), snippet_with_neighbors(&text, &ps, index, start, end, false));
            if let Some(existing) = candidates.iter_mut().find(|c: &&mut (String, usize, usize, f64)| c.1 == offset && c.2 == end_offset) {
                existing.3 = existing.3.max(score);
            } else {
                candidates.push((p.snippet(start, end, false), offset, end_offset, score));
            }
        }
    }
    if candidates.is_empty() {
        let first = ps.iter().find(|p| !p.heading).or_else(|| ps.first());
        return first.map(|p| {
            let end = p.text.char_indices().nth(budget.saturating_sub(250).min(1000)).map(|x| x.0).unwrap_or(p.text.len());
            format!("[未找到问题关键词；以下仅为页面开头]\n{}", p.snippet(0, end, false))
        }).unwrap_or_default();
    }
    let mut selected = Vec::<(String,usize,usize,f64)>::new();
    let mut used = BTreeSet::new();
    let mut remaining = budget;
    while !candidates.is_empty() {
        // Reward previously uncovered query terms, rather than filling all
        // slots with repeated mentions of one field in a long document.
        candidates.sort_by(|a,b| {
            let score = |c: &(String,usize,usize,f64)| {
                let lower = prose_for_ranking(&c.0).to_lowercase();
                c.3 + terms.iter().filter(|t| !used.contains(*t) && term_matches(&lower, t).next().is_some()).map(|t| stats.weights.get(t).copied().unwrap_or(0.0)).sum::<f64>()
            };
            score(b).total_cmp(&score(a)).then(a.1.cmp(&b.1))
        });
        let candidate = candidates.remove(0);
        let size = candidate.0.chars().count() + 2;
        let lower = prose_for_ranking(&candidate.0).to_lowercase();
        let adds_term = terms.iter().any(|term| !used.contains(term) && term_matches(&lower, term).next().is_some());
        if size > remaining || (!adds_term && selected.iter().any(|s| candidate.1 < s.2 && s.1 < candidate.2)) { continue; }
        for term in &terms { if term_matches(&lower, term).next().is_some() { used.insert(term.clone()); } }
        remaining -= size;
        selected.push(candidate);
    }
    // Select relevant paragraphs before spending budget on neighboring context.
    // Otherwise three large neighborhoods can crowd out a fourth relevant fact.
    for i in 0..selected.len() {
        let Some((snippet, start, end)) = neighborhoods.get(&(selected[i].1, selected[i].2)) else { continue };
        let extra = snippet.chars().count().saturating_sub(selected[i].0.chars().count());
        if extra <= remaining && !selected.iter().enumerate().any(|(j, s)| j != i && *start < s.2 && s.1 < *end) {
            selected[i] = (snippet.clone(), *start, *end, selected[i].3);
            remaining -= extra;
        }
    }
    selected.sort_by_key(|s| s.1);
    selected.into_iter().map(|s| s.0).collect::<Vec<_>>().join("\n\n")
}

struct Passage<'a> {
    text: &'a str,
    offset: usize,
    line: usize,
    section: &'a str,
    location: &'a str,
    heading: bool,
}

fn passages(content: &str, org_headings: bool) -> Vec<Passage<'_>> {
    let mut out = Vec::new();
    let mut section = "unknown";
    let mut location = "unknown";
    let mut pending = None;
    let mut offset = 0;
    for (index, line) in content.split_inclusive('\n').enumerate() {
        let last_line = index + 1;
        let trimmed = line.trim();
        let marker = trimmed
            .strip_prefix("<!-- source-location:")
            .and_then(|s| s.strip_suffix("-->"))
            .map(str::trim);
        // Markdown stars introduce list items; only Org uses them as headings.
        let heading = trimmed.trim_start_matches(if org_headings { '*' } else { '#' });
        let heading = (heading.len() < trimmed.len() && heading.starts_with(char::is_whitespace))
            .then(|| heading.trim());
        // Score each ordered step on its own. Adjacent steps can still be
        // returned together, but a relevant final step must not be diluted by
        // the length and citation links of the entire workflow.
        let ordered_step = [". ", ") ", "、"].iter().any(|separator| {
            trimmed.split_once(separator).is_some_and(|(number, _)|
                !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
        });
        if trimmed.is_empty() || marker.is_some() || heading.is_some() || ordered_step {
            if let Some((start, line)) = pending.take() {
                out.push(Passage {
                    text: content[start..offset].trim_end_matches(['\r', '\n']),
                    offset: start,
                    line,
                    section,
                    location,
                    heading: false,
                });
            }
            if let Some(value) = marker {
                location = if value.is_empty() { "unknown" } else { value };
            }
            if let Some(value) = heading {
                section = value;
                out.push(Passage {
                    text: line.trim_end_matches(['\r', '\n']),
                    offset,
                    line: last_line,
                    section,
                    location,
                    heading: true,
                });
            }
            if ordered_step { pending = Some((offset, last_line)); }
        } else if pending.is_none() {
            pending = Some((offset, last_line));
        }
        offset += line.len();
    }
    if let Some((start, line)) = pending {
        out.push(Passage {
            text: content[start..].trim_end_matches(['\r', '\n']),
            offset: start,
            line,
            section,
            location,
            heading: false,
        });
    }
    out
}

fn snippet_with_neighbors(
    content: &str,
    passages: &[Passage<'_>],
    index: usize,
    start: usize,
    end: usize,
    cached: bool,
) -> (String, usize, usize) {
    let anchor = &passages[index];
    if anchor.heading || start != 0 || end != anchor.text.len() {
        return (
            anchor.snippet(start, end, cached),
            anchor.offset + start,
            anchor.offset + end,
        );
    }
    let range = |first: usize, last: usize| {
        let first = &passages[first];
        let last = &passages[last];
        Passage {
            // Use one original substring, including blank lines and every
            // locator/reset between paragraphs. Never spread one block's
            // locator over a neighbor or manufacture connecting text.
            text: &content[first.offset..last.offset + last.text.len()],
            offset: first.offset,
            line: first.line,
            section: first.section,
            location: first.location,
            heading: false,
        }
    };
    let fits = |passage: &Passage<'_>| {
        let chars = passage
            .text
            .chars()
            .take(MAX_SOURCE_SNIPPET_CHARS + 1)
            .count();
        chars <= MAX_SOURCE_SNIPPET_CHARS
            && chars
                + passage
                    .header(0, passage.text.len(), cached)
                    .chars()
                    .count()
                <= MAX_SOURCE_SNIPPET_CHARS
    };
    let (mut first, mut last) = (index, index);
    // A continued-table caption belongs to the following rows. Expanding
    // backward first can consume the budget with the previous page's table.
    if table_after_caption(passages, index).is_some() && fits(&range(index, index + 1)) {
        last += 1;
    }
    loop {
        let mut expanded = false;
        if first > 0 && !passages[first - 1].heading && fits(&range(first - 1, last)) {
            first -= 1;
            expanded = true;
        }
        if last + 1 < passages.len() && !passages[last + 1].heading && fits(&range(first, last + 1))
        {
            last += 1;
            expanded = true;
        }
        if !expanded {
            break;
        }
    }
    let passage = range(first, last);
    (
        passage.snippet(0, passage.text.len(), cached),
        passage.offset,
        passage.offset + passage.text.len(),
    )
}

fn is_identifier(term: &str) -> bool {
    term.chars().all(|c| c.is_ascii_alphanumeric())
        && term.chars().any(|c| c.is_ascii_alphabetic())
        && term.chars().any(|c| c.is_ascii_digit())
}

fn is_compound_figure_number(term: &str) -> bool {
    term.contains('-') && term.split('-').all(|part|
        !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
}

fn table_after_caption(passages: &[Passage<'_>], index: usize) -> Option<String> {
    let caption = passages.get(index)?.text.trim().strip_prefix('续').unwrap_or(passages[index].text.trim());
    let lower_caption = caption.to_ascii_lowercase();
    let tail = caption.strip_prefix('表').or_else(|| lower_caption.strip_prefix("table"))?.trim_start();
    let len = tail.bytes().take_while(|c| c.is_ascii_digit() || *c == b'-').count();
    let number = &tail[..len];
    if !is_compound_figure_number(number) || tail.as_bytes().get(len).is_some_and(|c| c.is_ascii_alphanumeric()) { return None; }
    let body = passages.get(index + 1)?.text.trim_start();
    let lower_body = body.to_ascii_lowercase();
    let html_rows = lower_body.starts_with("<table") && lower_body.contains("</tr>")
        && (lower_body.contains("<td") || lower_body.contains("<th"));
    let markdown_rows = body.starts_with('|') && body.lines().nth(1).is_some_and(|line| line.contains("---"))
        && body.lines().skip(2).any(|line| line.trim_start().starts_with('|'));
    if !(html_rows || markdown_rows) { return None; }
    Some(number.to_string())
}

fn labeled_numbers(query: &str, labels: &[&str]) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut figures = Vec::new();
    for &label in labels {
        for (start, _) in lower.match_indices(label) {
            if label.is_ascii() && start > 0 && lower.as_bytes()[start - 1].is_ascii_alphabetic() { continue; }
            let tail = &lower[start + label.len()..];
            let tail = if label == "fig" { tail.strip_prefix('.').unwrap_or(tail) } else { tail };
            let tail = tail.trim_start();
            let len = tail.bytes().take_while(|c| c.is_ascii_digit() || *c == b'-').count();
            let number = &tail[..len];
            if is_compound_figure_number(number)
                && tail.as_bytes().get(len).is_none_or(|c| !c.is_ascii_alphanumeric()) {
                figures.push(number.to_string());
            }
        }
    }
    figures
}

fn retrieval_terms(query: &str) -> Vec<String> {
    // The shared CJK bigram tokenizer is useful for prose, but UR5负载 must
    // retain UR5 rather than treating its R5 suffix as a separate identifier.
    let identifiers: BTreeSet<String> = query.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| is_identifier(s)).map(str::to_ascii_lowercase).collect();
    // The general tokenizer drops the single digits in “图7-9” or “表5-21”.
    // Preserve explicit figure/table numbers without boosting arbitrary dates.
    let figures = labeled_numbers(query, &["图", "figure", "fig", "表", "table"]);
    tokenize_query(query).into_iter()
        .filter(|s| s.chars().count() >= 2 && (!is_identifier(s) || identifiers.contains(s)))
        .chain(identifiers.iter().cloned()).chain(figures).collect::<BTreeSet<_>>().into_iter().collect()
}

fn term_matches<'a>(text: &'a str, term: &'a str) -> impl Iterator<Item = (usize, &'a str)> {
    text.match_indices(term).filter(move |(at, found)| {
        let compound = is_compound_figure_number(term);
        let continuation = |c: u8| c.is_ascii_alphanumeric() || (compound && c == b'-');
        !(is_identifier(term) || compound) || (
            (*at == 0 || !continuation(text.as_bytes()[at - 1]))
            && text.as_bytes().get(at + found.len()).is_none_or(|c| !continuation(*c)))
    })
}

fn has_exact_phrase(text: &str, phrase: &str) -> bool {
    !phrase.is_empty() && text.match_indices(phrase).any(|(at, found)| {
        (!phrase.as_bytes()[0].is_ascii_alphanumeric() || at == 0 || !text.as_bytes()[at - 1].is_ascii_alphanumeric())
            && (!phrase.as_bytes()[phrase.len() - 1].is_ascii_alphanumeric()
                || text.as_bytes().get(at + found.len()).is_none_or(|c| !c.is_ascii_alphanumeric()))
    })
}

// Passage-level BM25-style weighting prevents common book-title/query words
// from outranking a short paragraph containing the requested rare parameter.
// Citation paths and generated navigation repeat the book title in nearly
// every record. Rank the prose, while returning the untouched source slice.
fn prose_for_ranking(text: &str) -> String {
    let mut prose = text.to_string();
    while let Some(start) = prose.find("<!--") {
        let Some(end) = prose[start + 4..].find("-->").map(|i| start + 4 + i + 3) else { break };
        prose.replace_range(start..end, " ");
    }
    let mut prose = prose.lines().filter(|line| {
        let line = line.trim();
        !line.starts_with("出处：")
            && !line.starts_with("[章节:")
            && !(line.starts_with("类型：") && line.contains("来源章节："))
    }).collect::<Vec<_>>().join("\n");
    let mut cursor = 0;
    while let Some(start) = prose[cursor..].find("[[").map(|i| cursor + i) {
        let Some(end) = prose[start + 2..].find("]]").map(|i| start + 2 + i) else { break };
        let inner = &prose[start + 2..end];
        let label = inner.split_once('|').map(|(_, label)| label)
            .unwrap_or_else(|| if inner.starts_with("raw/") || inner.contains(".wiki-source/") { "" } else { inner });
        let label = label.to_string();
        prose.replace_range(start..end + 2, &label);
        cursor = start + label.len();
    }
    cursor = 0;
    while let Some(start) = prose[cursor..].find("](").map(|i| cursor + i + 1) {
        let Some(end) = prose[start + 1..].find(')').map(|i| start + 1 + i) else { break };
        prose.replace_range(start..end + 1, "");
        cursor = start;
    }
    prose
}

struct PassageStats {
    weights: std::collections::BTreeMap<String, f64>,
    average_chars: f64,
}

impl PassageStats {
    fn new(passages: &[Passage<'_>], terms: &[String]) -> Self {
        let bodies: Vec<_> = passages.iter().filter(|p| !p.heading).map(|p| prose_for_ranking(p.text).to_lowercase()).filter(|p| !p.trim().is_empty()).collect();
        let n = bodies.len().max(1) as f64;
        let title = passages.iter().find(|p| p.heading).map(|p| p.text.to_lowercase()).unwrap_or_default();
        let weights = terms.iter().map(|term| {
            let df = bodies.iter().filter(|body| term_matches(body, term).next().is_some()).count() as f64;
            // Mixed letter/number identifiers (L3, UR5, D455) carry an
            // explicit question constraint; generic prose must not drown them.
            // A code in the document title identifies the source (e.g. 4D BIM),
            // so it receives normal IDF weight rather than a parameter boost.
            let identifier = (is_identifier(term) || is_compound_figure_number(term)) && term_matches(&title, term).next().is_none();
            (term.clone(), (1.0 + (n - df + 0.5) / (df + 0.5)).ln() * if identifier { 4.0 } else { 1.0 })
        }).collect();
        Self { weights, average_chars:(bodies.iter().map(|b| b.chars().count().min(MAX_SOURCE_SNIPPET_CHARS)).sum::<usize>() as f64 / n).max(1.0) }
    }

    fn score(&self, lower: &str, terms: &[String]) -> f64 {
        let norm = 1.2 * (0.25 + 0.75 * lower.chars().count() as f64 / self.average_chars);
        terms.iter().map(|term| {
            let frequency = term_matches(lower, term).count().min(3) as f64;
            self.weights.get(term).copied().unwrap_or(0.0) * frequency * 2.2 / (frequency + norm)
        }).sum()
    }
}

impl Passage<'_> {
    fn is_navigation(&self, text: &str) -> bool {
        self.heading || text.lines().all(|line| {
            let line = line.trim();
            line.contains("](#")
                || ((line.contains("..") || line.contains('…'))
                    && line.split_whitespace().last().is_some_and(|s| s.parse::<usize>().is_ok()))
        })
    }

    fn quality(&self, text: &str) -> f64 {
        if self.is_navigation(text) { 0.05 }
        else if text.chars().any(|c| matches!(c, '.' | '。' | '；' | ';' | '！' | '!' | '？' | '?')) || text.chars().count() >= 120 { 1.0 }
        else { 0.5 }
    }

    fn header(&self, start: usize, end: usize, cached: bool) -> String {
        let first = self.line + self.text[..start].bytes().filter(|b| *b == b'\n').count();
        let last = first
            + self.text[start..end]
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
        format!(
            "[章节: {}; 行: {first}-{last}{}; source-location: {}]\n",
            self.section.chars().take(120).collect::<String>(),
            if cached { "（抽取缓存）" } else { "" },
            self.location.chars().take(120).collect::<String>()
        )
    }

    fn snippet(&self, start: usize, end: usize, cached: bool) -> String {
        format!(
            "{}{}{}{}",
            self.header(start, end, cached),
            if start > 0 { "…" } else { "" },
            &self.text[start..end],
            if end < self.text.len() { "…" } else { "" }
        )
    }

    fn windows(&self, terms: &[String], phrase: &str, cached: bool, stats: &PassageStats) -> Vec<(usize, usize, f64)> {
        let lower = self.text.to_lowercase();
        if !terms.iter().any(|term| term_matches(&lower, term).next().is_some()) {
            return Vec::new();
        }
        let bounds = self
            .text
            .char_indices()
            .map(|(byte, _)| byte)
            .chain(std::iter::once(self.text.len()))
            .collect::<Vec<_>>();
        // A lowercased scalar can expand (İ -> i + combining dot). Map its
        // boundaries back to original character indices, never slice original
        // text using offsets returned by searching the lowercased string.
        let mut lower_bounds = Vec::new();
        let mut lower_byte = 0;
        for (index, ch) in self.text.chars().enumerate() {
            for folded in ch.to_lowercase() {
                lower_bounds.push((lower_byte, index));
                lower_byte += folded.len_utf8();
            }
        }
        lower_bounds.push((lower_byte, bounds.len() - 1));
        let budget =
            MAX_SOURCE_SNIPPET_CHARS - self.header(0, self.text.len(), cached).chars().count() - 2;
        let mut anchors = BTreeSet::new();
        for term in terms {
            for (byte, _) in term_matches(&lower, term) {
                let i = lower_bounds.partition_point(|(position, _)| *position < byte);
                let j = lower_bounds.partition_point(|(position, _)| *position < byte + term.len());
                let start = lower_bounds[i].1;
                let end = lower_bounds[j].1.max(start + 1);
                anchors.insert((start, end));
            }
        }
        let mut windows = Vec::new();
        let mut covered_until = 0;
        for (anchor, match_end) in anchors {
            if match_end <= covered_until {
                continue;
            }
            let start = anchor
                .saturating_sub(budget / 3)
                .min((bounds.len() - 1).saturating_sub(budget));
            let end = (start + budget).min(bounds.len() - 1);
            // Oversized query terms cannot become partial-word evidence.
            if match_end > end {
                continue;
            }
            let text = &self.text[bounds[start]..bounds[end]];
            let lower = prose_for_ranking(text).to_lowercase();
            let coverage: usize = terms
                .iter()
                .filter(|term| term_matches(&lower, term).next().is_some())
                .map(|term| term.chars().count().min(8))
                .sum();
            if coverage == 0 {
                continue;
            }
            // Unique term coverage dominates. Repeating a chapter title in a
            // TOC does not accumulate frequency points over an actual paragraph.
            let quality = self.quality(text);
            let score =
                (stats.score(&lower, terms) + if has_exact_phrase(&lower, phrase) { 2.0 } else { 0.0 }) * quality;
            windows.push((bounds[start], bounds[end], score));
            covered_until = end;
        }
        windows
    }
}

#[cfg(test)]
mod tests {
    use super::super::search_sources;
    use std::{fs, path::PathBuf};

    #[test]
    fn relevant_facts_take_budget_before_neighboring_background() {
        let text = ["A7", "B8", "C9", "D6"].iter().map(|code| format!("## Topic\n\nProbe {code} requires review before execution.\n\n{}\n\n", "Unrelated background detail. ".repeat(16))).collect::<String>();
        let excerpt = super::relevant_excerpt(&text, "A7 B8 C9 D6", 700);
        for code in ["A7", "B8", "C9", "D6"] { assert!(excerpt.contains(&format!("Probe {code}")), "{excerpt}"); }
        assert!(excerpt.chars().count() <= 700);
    }

    #[test]
    fn section_subject_keeps_parameter_handoff_under_a_shared_budget() {
        let mut text = String::from("# Operations\n\n");
        for i in 0..6 {
            text.push_str(&format!("## Background {i}\n\nPlanning and deployment require resources, trial review and records.\n\n"));
        }
        text.push_str("## Coating robot parameters\n\nQuantify parameters before operation and map the recorded fields to project codes.\n");
        let excerpt = super::relevant_excerpt(&text, "planning deployment trial coating robot parameters records", 360);
        assert!(excerpt.contains("map the recorded fields to project codes"), "{excerpt}");
        assert!(excerpt.chars().count() <= 360);
    }

    #[test]
    fn relevant_table_value_is_not_diluted_by_other_rows() {
        let mut text = String::from("# Delivery\n\n");
        for i in 0..5 {
            text.push_str(&format!("## Overview {i}\n\nDelivery models are reviewed against contract requirements before handover.\n\n"));
        }
        text.push_str("## Model precision\n\n| Item | Requirement |\n| --- | --- |\n| Delivery model | Precision grade AQ or as contracted. |\n");
        for item in ["Photo", "Video", "Archive", "Inventory", "Training", "Report"] {
            text.push_str(&format!("| {item} | Record the date and responsible person. |\n"));
        }
        let excerpt = super::relevant_excerpt(&text, "delivery model precision grade contract requirements", 680);
        assert!(excerpt.contains("Precision grade AQ or as contracted."), "{excerpt}");
        assert!(excerpt.contains("| Item | Requirement |"));
        assert!(excerpt.chars().count() <= 680);
    }

    #[test]
    fn table_shaped_navigation_cannot_displace_parameter_evidence() {
        let text = "# Page\n\n## Robot speed pressure\n\n| [robot speed pressure](#nav) |\n\n## Procedure\n\nRobot speed must be limited to 7 m/s. Check pressure before starting the operation.\n";
        let excerpt = super::relevant_excerpt(text, "robot speed pressure", 160);
        assert!(excerpt.contains("7 m/s"), "{excerpt}");
        assert!(!excerpt.contains("](#nav)"));
        assert!(excerpt.chars().count() <= 160);
    }

    #[test]
    fn inline_comment_does_not_hide_adjacent_evidence() {
        let text = "# Test\n\nUnrelated introduction.\n\n## Approval\n\n<!-- note -->Critical approval requires qualified review.\n";
        let excerpt = super::relevant_excerpt(text, "approval qualified", 300);
        assert!(excerpt.contains("Critical approval requires qualified review."), "{excerpt}");
        assert!(excerpt.contains("行: 7-7"), "{excerpt}");
    }

    #[test]
    fn compound_figure_reference_retrieves_its_image_description() {
        let text = "# Manual\n\nUnrelated introduction.\n\n![图 17-9 Other diagram.](media/other.jpg)\n\n## Progress\n\n<!-- source-location: pdf-page:148/block:4 -->\n![图 7-9 进度跟踪。Image description: pc_slab and people labels; no feedback arrows.](media/figure.jpg)\n";
        for query in ["请解释图7-9", "Explain Figure 7-9", "Explain Fig. 7-9"] {
            let excerpt = super::relevant_excerpt(text, query, 300);
            assert!(excerpt.contains("pc_slab and people"), "{query}: {excerpt}");
            assert!(!excerpt.contains("Other diagram"), "{query}: {excerpt}");
            assert!(excerpt.chars().count() <= 300);
        }
    }

    #[test]
    fn figure_numbers_keep_boundaries_and_require_an_explicit_label() {
        assert!(super::retrieval_terms("图7-9与Fig. 7-11").contains(&"7-9".to_string()));
        assert!(!super::retrieval_terms("years 2009-2020").contains(&"2009-2020".to_string()));
        assert_eq!(super::term_matches("17-9 7-90 7-9-2 x7-9 7-9a 图 7-9。", "7-9").count(), 1);
    }

    #[test]
    fn explicit_table_numbers_retrieve_the_requested_tables() {
        let text = "# Sample catalogue\n\n表15-21 Unrelated long catalogue.\n\n## Inputs\n\n表5-21 Sample inputs: material and dimensions.\n\n## Outputs\n\n表5-22 Sample outputs: report and checklist.\n";
        for query in ["表5-21 表5-22", "Table 5-21 Table 5-22"] {
            assert!(super::retrieval_terms(query).contains(&"5-21".to_string()));
            assert!(super::retrieval_terms(query).contains(&"5-22".to_string()));
            let excerpt = super::relevant_excerpt(text, query, 210);
            assert!(excerpt.contains("Sample inputs"), "{query}: {excerpt}");
            assert!(excerpt.contains("Sample outputs"), "{query}: {excerpt}");
            assert!(!excerpt.contains("Unrelated long catalogue"), "{query}: {excerpt}");
            assert!(excerpt.chars().count() <= 210);
        }
        assert!(!super::retrieval_terms("timetable 5-21 years 2009-2020").contains(&"5-21".to_string()));
    }

    #[test]
    fn requested_table_keeps_continuation_rows_before_generic_matches() {
        let sources = Sources::new();
        let text = format!("# Manual\n\n## Background\n\ninput output model report interface input output model report interface.\n\n## Results\n\n表5-21 output model report\n\n<!-- source-location: pdf-page:2/block:1 -->\n<table><tr><td>Main deliverable</td><td>{}</td></tr></table>\n<!-- source-location: unknown -->\n\n续表5-21\n\n<!-- source-location: pdf-page:3/block:1 -->\n<table><tr><td>Interface package</td><td>{}</td></tr></table>\n\n## Another table\n\n表6-21 output model report\n\n| Other | Rows |\n| --- | --- |\n| Irrelevant | Example |\n", "Payload. ".repeat(140), "Interface detail. ".repeat(30));
        sources.write("tables.md", &text);
        for query in ["表5-21 input output model report interface", "Table 5-21 input output model report interface"] {
            let refs = super::search_scoped(sources.0.to_str().unwrap(), query, 2, &[]).unwrap();
            assert_eq!(refs.len(), 2);
            let snippets = refs.iter().map(|r| r.snippet.as_deref().unwrap()).collect::<Vec<_>>();
            assert!(snippets.iter().any(|s| s.contains("Main deliverable")), "{snippets:?}");
            let continuation = snippets.iter().find(|s| s.contains("Interface package")).expect("continued rows must be retrieved");
            assert!(continuation.contains("续表5-21"));
            assert!(continuation.contains("pdf-page:3/block:1"));
            for snippet in snippets {
                assert!(snippet.chars().count() <= super::MAX_SOURCE_SNIPPET_CHARS);
                assert!(!snippet.contains("Irrelevant"));
            }
        }
    }

    #[test]
    fn table_priority_requires_a_caption_and_actual_rows() {
        let mixed = "Table 5-210 (compare 表5-21)\n\n<table><tr><td>Another table</td></tr></table>";
        assert_eq!(super::table_after_caption(&super::passages(mixed, false), 0).as_deref(), Some("5-210"));
        let sources = Sources::new();
        let text = format!("# Manual\n\n## Discussion\n\n表明上述方法优于表5-21的方案；下面是另一实验。\n\n<table><tr><td>Unrelated experiment</td></tr></table>\n\n## Broken markup\n\n续表5-21\n\n<table>\n\n<tr><td>{}</td></tr>\n\n</table>\n\n## Actual table\n\nTable 5-21\n\n| Deliverable | Detail |\n| --- | --- |\n| Genuine result | Verified row |\n", "Long row. ".repeat(200));
        sources.write("tables.md", &text);
        let refs = super::search_scoped(sources.0.to_str().unwrap(), "表5-21", 1, &[]).unwrap();
        assert_eq!(refs.len(), 1);
        let snippet = refs[0].snippet.as_deref().unwrap();
        assert!(snippet.contains("Genuine result"), "{snippet}");
        assert!(!snippet.contains("Unrelated experiment"));
        assert!(snippet.chars().count() <= super::MAX_SOURCE_SNIPPET_CHARS);
    }

    #[test]
    fn long_workflow_keeps_the_relevant_ordered_step() {
        let text = format!("# Procedure\n\n1. {}\n2. {}\n3. Trial validation may precede rollout; reject the method if targets are not met.\n", "Identify background and resources. ".repeat(15), "Allocate people and document the plan. ".repeat(15));
        let excerpt = super::relevant_excerpt(&text, "trial validation rollout", 220);
        assert!(excerpt.contains("Trial validation may precede rollout; reject the method if targets are not met."), "{excerpt}");
        assert!(excerpt.contains("行: 5-5"));
        assert!(excerpt.chars().count() <= 220);
    }

    #[test]
    fn matching_paragraph_survives_when_neighbors_exceed_page_budget() {
        let text = format!("# Test\n\n{}\n\nCritical approval requires an independent reviewer.\n\n{}", "Unrelated detail. ".repeat(25), "Other background. ".repeat(25));
        let excerpt = super::relevant_excerpt(&text, "approval reviewer", 160);
        assert!(excerpt.contains("Critical approval requires an independent reviewer."), "{excerpt}");
        assert!(excerpt.contains("行: 5-5"));
        assert!(excerpt.chars().count() <= 160);
    }

    #[test]
    fn citation_paths_do_not_displace_prose_under_a_tight_budget() {
        let text = "# Test\n\n## Citation noise\n\nNothing relevant.\n\n出处：[[raw/sources/robot-execution-robot-execution.wiki-source/source.md]]，行 1–1；unknown。\n\n## Execution\n\nRobot execution requires a qualified operator to confirm site conditions.\n\n出处：[[raw/sources/manual.wiki-source/source.md]]，行 42–42；unknown。\n";
        let excerpt = super::relevant_excerpt(text, "robot execution", 300);
        assert!(excerpt.contains("qualified operator"), "{excerpt}");
        assert!(excerpt.contains("行: 11-13"), "{excerpt}");
        assert!(excerpt.contains("raw/sources/manual.wiki-source/source.md"));
        assert!(!excerpt.contains("Nothing relevant"));
        assert!(excerpt.chars().count() <= 300);
    }

    #[test]
    fn ranking_keeps_link_labels_and_does_not_score_generated_navigation() {
        let text = "类型：方法。来源章节：robot chapter。\n<!-- section-knowledge:robot:start -->\nSee [[raw/sources/robot.wiki-source/source.md|the manual]] and [manual](raw/sources/robot.md).\nActual robot needs review.";
        let prose = super::prose_for_ranking(text);
        assert_eq!(prose.matches("robot").count(), 1);
        assert!(prose.contains("the manual"));
        assert!(prose.contains("[manual]"));
        assert!(prose.contains("Actual robot needs review."));
    }

    #[test]
    fn identifiers_keep_complete_codes_and_require_ascii_boundaries() {
        let terms = super::retrieval_terms("UR5负载 D455深度 L7要求");
        for term in ["ur5", "d455", "l7"] { assert!(terms.iter().any(|s| s == term)); }
        for term in ["r5", "d4"] { assert!(!terms.iter().any(|s| s == term)); }
        assert_eq!(super::term_matches("l7要求 (l7) l70 xl7", "l7").count(), 2);
        assert_eq!(super::term_matches("cr5 ur50 ur5", "ur5").count(), 1);
        assert_eq!(super::term_matches("d435 d455", "d455").count(), 1);
        assert!(!super::has_exact_phrase("alpha l70", "alpha l7"));
        assert!(!super::has_exact_phrase("xl7 alpha", "l7 alpha"));
        assert!(super::has_exact_phrase("(alpha l7)要求", "alpha l7"));
        let text = format!("l7 alpha {}.\n\nl70.", "x".repeat(191));
        let result = super::relevant_excerpt(&text, "alpha l7", 340);
        assert!(result.contains("l7 alpha"), "{result}");
        assert!(super::relevant_excerpt("l70.\n\nxl7.", "l7", 300).contains("未找到问题关键词"));
    }

    #[test]
    fn title_identifiers_do_not_receive_parameter_boost() {
        let ps = super::passages("# C8 Platform\n\nC8 uses the R7 sensor.\n\nOther description.", false);
        let terms = super::retrieval_terms("c8 r7");
        let stats = super::PassageStats::new(&ps, &terms);
        assert!((stats.weights["r7"] / stats.weights["c8"] - 4.0).abs() < 0.001);
    }

    #[test]
    fn explicit_level_identifier_is_not_drowned_by_generic_comparison_terms() {
        let text = "# Standard\n\n企业应用项目实施的判据需要经验与能力。\n\n## Classification\n\nL7要求至少九个子项达到部分自动化，其中三项达到高度自动化。\n\n## Generic\n\n企业应用项目实施判据、能力、经验与评价要求的一般比较。\n";
        let result = super::relevant_excerpt(text, "比较企业应用项目实施判据能力经验与L7要求", 200);
        assert!(result.contains("九个子项"), "{result}");
    }

    #[test]
    fn long_wiki_reads_distant_fields_and_preserves_lines() {
        let preface = "无关介绍。\n\n".repeat(2000);
        let text = format!("---\ntitle: hiddenmetadata\n---\n# Test\n\n{preface}## Robot\n\nThe speed is 0.5 m/s and pickup pose is (2, 3, 4).\n\n{}\n\n## Level\n\nSynthetic level X7 requires eleven sample items across three demo groups, with three in each group.\n", "Other unrelated paragraph.\n\n".repeat(200));
        let excerpt = super::relevant_excerpt(&text, "speed pickup pose X7 demo groups sample items", 4000);
        assert!(excerpt.contains("0.5 m/s"));
        assert!(excerpt.contains("(2, 3, 4)"));
        assert!(excerpt.contains("eleven sample items"));
        assert!(!excerpt.contains("hiddenmetadata"));
        assert!(excerpt.chars().count() <= 4000);
        let position = text.find("The speed").unwrap();
        let line = text[..position].bytes().filter(|b| *b == b'\n').count()+1;
        assert!(excerpt.contains(&format!("行: {line}-")));
    }

    #[test]
    fn overlapping_windows_keep_uncovered_fields_within_budget() {
        let text = format!("{}alpha{}beta{}", "x".repeat(100), "x".repeat(1695), "x".repeat(1200));
        let excerpt = super::relevant_excerpt(&text, "alpha beta", 4000);
        assert!(excerpt.contains("alpha"));
        assert!(excerpt.contains("beta"));
        assert!(excerpt.chars().count() <= 4000);
    }

    #[test]
    fn scoped_comparison_retains_low_scoring_second_source() {
        let sources = Sources::new();
        let many = (0..30).map(|i| format!("# Section {i}\n\nschedule budget speed robot condition evidence.\n\n")).collect::<String>();
        sources.write("a.md", &many);
        sources.write("b.md", "# Evidence\n\nrobot observation only.");
        let scope = vec!["raw/sources/a.md".to_string(), "raw/sources/b.md".to_string()];
        let refs = super::search_scoped(sources.0.to_str().unwrap(), "schedule budget speed robot condition evidence", 5, &scope).unwrap();
        assert!(refs.iter().any(|r| r.path == scope[0]));
        assert!(refs.iter().any(|r| r.path == scope[1]));
        assert_eq!(refs.len(),5);
        assert!(super::search_scoped(sources.0.to_str().unwrap(), "robot", 1, &scope).unwrap_err().contains("预算"));
    }

    #[test]
    fn explicit_scope_filters_before_ranking_and_never_falls_back() {
        let sources = Sources::new();
        sources.write("guide.md", "# Guide\n\nrobot speed speed speed speed unrelated.");
        sources.write("paper.md", "# Paper\n\nrobot speed is 0.5 m/s.");
        let scope = vec!["raw/sources/paper.md".to_string()];
        let refs = super::search_scoped(sources.0.to_str().unwrap(), "robot speed", 5, &scope).unwrap();
        assert!(!refs.is_empty());
        assert!(refs.iter().all(|r| r.path == scope[0]));
        assert!(super::search_scoped(sources.0.to_str().unwrap(), "unrelated", 5, &scope).unwrap().is_empty());
        for path in ["../paper.md", "raw/sources/../../outside.md", "raw/sources/missing.md", "wiki/paper.md"] {
            assert!(super::search_scoped(sources.0.to_str().unwrap(), "robot", 5, &[path.into()]).is_err());
        }
        let catalog = super::catalog(sources.0.to_str().unwrap());
        assert_eq!(catalog.len(), 2);
    }

    struct Sources(PathBuf);

    impl Sources {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("source-search-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("raw/sources")).unwrap();
            Self(root)
        }

        fn write(&self, name: &str, text: &str) {
            let path = self.0.join("raw/sources").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn search(&self, query: &str, limit: usize) -> Vec<super::super::AgentReference> {
            search_sources(self.0.to_str().unwrap(), query, limit).unwrap()
        }
    }

    impl Drop for Sources {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn search_sources_chinese_question_finds_verbatim_body() {
        let sources = Sources::new();
        let evidence =
            "合成仓储流程按区域整理货架，每日检查清单分配给值班员，盘点记录用于核对实际数量与登记数量。";
        sources.write("book.md", &format!("# 仓储示例\n\n{evidence}\n"));
        let refs = sources.search("示例怎样通过货架整理、每日检查清单和盘点记录核对库存？", 10);
        assert!(!refs.is_empty());
        assert!(refs[0].snippet.as_deref().unwrap().contains(evidence));
    }

    #[test]
    fn search_sources_markdown_star_list_keeps_parameters_but_org_star_is_heading() {
        let sources = Sources::new();
        let list = "* surveyneedle 操作步骤：完成演示零件摆放。";
        let parameter = "合成案例允许偏差为 7 mm，独立抽检比例为 31%。";
        sources.write(
            "list.md",
            &format!("# 作业流程\n\n{list}\n\n{parameter}\n\n# 后续章节\n\nothersection evidence."),
        );
        let refs = sources.search("surveyneedle", 5);
        let snippet = refs[0].snippet.as_deref().unwrap();
        assert!(snippet.contains(&format!("{list}\n\n{parameter}")));
        assert!(snippet.contains("章节: 作业流程"));
        assert!(!snippet.contains("othersection"));
        assert!(snippet.chars().count() <= 1500);

        sources.write(
            "procedure.ORG",
            &format!("* 准备\n\norgneedle 作业步骤。\n\n** 后续参数\n\n{parameter}"),
        );
        let refs = sources.search("orgneedle", 5);
        let snippet = refs[0].snippet.as_deref().unwrap();
        assert!(snippet.contains("orgneedle 作业步骤。"));
        assert!(snippet.contains("章节: 准备"));
        assert!(!snippet.contains(parameter));
        assert!(sources
            .search("允许偏差", 10)
            .iter()
            .any(|r| r.path.ends_with("procedure.ORG")
                && r.snippet.as_deref().unwrap().contains(parameter)));
    }

    #[test]
    fn search_sources_numbered_steps_keep_adjacent_parameters_and_locators() {
        let sources = Sources::new();
        let steps = [
            "（1）数据准备：演示装置载入样品格位的坐标。",
            "（2）摆放：完成样品格位的定位并记录演示结果。",
            "（3）复核：由另一名演示操作员独立复核，不得自行复核。",
            "（4）允许偏差：合成演示的偏差不得超过 7 mm。",
            "（5）抽检比例：合成演示的抽检数量不得低于 31%。",
        ];
        let excerpt = format!("{}\n<!-- source-location: unknown -->\n\n{}\n\n{}\n\n<!-- source-location: pdf-physical:21/block:4 -->\n{}\n<!-- source-location: unknown -->\n\n{}", steps[0], steps[1], steps[2], steps[3], steps[4]);
        // The long neighbor must stay whole or stay out; even a repeated
        // heading text starts a different section and must stop expansion.
        let body = format!("# 作业流程\n\n<!-- source-location: pdf-physical:20/block:1 -->\n{excerpt}\n\nlongneighbor{}\n\n# 作业流程\n\nboundaryneedle next section.\n", "无关材料。".repeat(400));
        sources.write("steps.md", &body);
        let refs = sources.search(
            "演示装置完成样品格位摆放后，允许偏差和独立抽检比例分别是多少，复核由谁进行？",
            10,
        );
        assert_eq!(
            refs.len(),
            1,
            "the same expanded range must not occupy multiple result slots"
        );
        let snippet = refs[0].snippet.as_deref().unwrap();
        for step in steps {
            assert!(snippet.contains(step), "missing adjacent step: {step}");
        }
        assert!(snippet.ends_with(&excerpt));
        assert!(snippet.contains("source-location: pdf-physical:20/block:1"));
        assert!(snippet.contains("<!-- source-location: pdf-physical:21/block:4 -->"));
        assert!(snippet.contains("<!-- source-location: unknown -->"));
        let start = body.find(steps[0]).unwrap();
        let end = body.find(steps[4]).unwrap() + steps[4].len();
        let first_line = 1 + body[..start].bytes().filter(|b| *b == b'\n').count();
        let last_line = 1 + body[..end].bytes().filter(|b| *b == b'\n').count();
        assert!(snippet.contains(&format!("行: {first_line}-{last_line}")));
        assert!(snippet.chars().count() <= 1500);
        assert!(!snippet.contains("longneighbor"));
        assert!(!snippet.contains("boundaryneedle"));
        let boundary = sources.search("boundaryneedle", 10);
        assert!(boundary[0]
            .snippet
            .as_deref()
            .unwrap()
            .contains("boundaryneedle next section."));
        assert!(!boundary[0].snippet.as_deref().unwrap().contains(steps[4]));
    }

    #[test]
    fn search_sources_multiple_distant_paragraphs_keep_locations_and_full_text() {
        let sources = Sources::new();
        let first = format!(
            "整理清单用于登记样品。{}关键结论仍在本段末尾。",
            "逐项核实任务。".repeat(100)
        );
        let second = "盘点记录用于核实数量。\n原文的换行和  双空格必须保留。";
        let text = format!("# 第一章\n\n<!-- source-location: pdf-physical:12/block:3 -->\n{first}\n<!-- source-location: unknown -->\n\n{}\n\n# 第二章\n\n{second}\n", "无关说明。".repeat(1000));
        sources.write("book.md", &text);
        let refs = sources.search("整理清单 盘点记录", 10);
        let a = refs
            .iter()
            .find(|r| r.snippet.as_deref().unwrap().contains(&first))
            .unwrap();
        assert!(a
            .snippet
            .as_deref()
            .unwrap()
            .contains("pdf-physical:12/block:3"));
        assert!(a.snippet.as_deref().unwrap().contains("第一章"));
        assert!(a.snippet.as_deref().unwrap().contains("行: 4-4"));
        let b = refs
            .iter()
            .find(|r| r.snippet.as_deref().unwrap().contains(second))
            .unwrap();
        assert_eq!(a.path, b.path);
        assert!(b
            .snippet
            .as_deref()
            .unwrap()
            .contains("source-location: unknown"));
        assert!(b.snippet.as_deref().unwrap().contains("第二章"));
        for reference in refs {
            assert!(reference.snippet.unwrap().chars().count() <= 1500);
        }
    }

    #[test]
    fn search_sources_ranks_all_files_and_body_above_repeated_headings() {
        let sources = Sources::new();
        for i in 0..12 {
            sources.write(
                &format!("a{i:02}.md"),
                "# schedule\n\nAn unrelated introduction.",
            );
        }
        sources.write("contents.md", &"## schedule budget\n\n".repeat(30));
        sources.write("z-body.md", "# Execution\n\nCompare the schedule and budget against completed work to act on deviations.");
        let refs = sources.search("schedule budget", 99);
        assert_eq!(refs.len(), 10);
        assert_eq!(refs[0].path, "raw/sources/z-body.md");
        assert!(refs[0].score.unwrap() > refs.last().unwrap().score.unwrap());
    }

    #[test]
    fn search_sources_unicode_lowercase_offsets_and_original_case() {
        let sources = Sources::new();
        let evidence = "İİİİİİİİİİİİİİİİİİİİ 🧰 原文 EVIDENCE 尾部。";
        sources.write(
            "unicode.txt",
            &format!(
                "{}\n\n{evidence}\n\n{}",
                "İ前文。".repeat(500),
                "后文。".repeat(1000)
            ),
        );
        let refs = sources.search("evidence", 5);
        assert_eq!(refs.len(), 1);
        assert!(refs[0].snippet.as_deref().unwrap().contains(evidence));
        sources.write("expanded.txt", "İX retains its exact spelling.");
        assert!(!sources.search("i\u{307}x", 5).is_empty());
    }

    #[test]
    fn search_sources_only_recognized_source_packages_hide_auxiliaries() {
        let sources = Sources::new();
        sources.write("normal.json", r#"{"text":"ordinaryjson"}"#);
        sources.write("ordinary/manifest.json", r#"{"text":"ordinaryjson"}"#);
        sources.write("ordinary/source.md", "ordinaryjson text");
        sources.write("ordinary/images/caption.txt", "ordinaryjson image notes");
        sources.write("unrecognized.wiki-source/source.md", "ordinaryjson text");
        sources.write(
            "unrecognized.wiki-source/manifest.json",
            r#"{"text":"ordinaryjson"}"#,
        );
        sources.write(
            "missing.wiki-source/manifest.json",
            r#"{"version":1,"source":{"filename":"source.md"},"images":[],"text":"ordinaryjson"}"#,
        );
        sources.write("managed.wiki-source/source.md", "bodyneedle exact source");
        sources.write(
            "managed.wiki-source/manifest.json",
            r#"{"version":1,"source":{"filename":"source.md"},"images":[],"text":"auxneedle"}"#,
        );
        sources.write("managed.wiki-source/images/caption.txt", "auxneedle");
        let refs = sources.search("ordinaryjson", 10);
        assert_eq!(refs.len(), 7);
        assert!(sources.search("auxneedle", 10).is_empty());
        assert_eq!(sources.search("bodyneedle", 10).len(), 1);
    }

    #[test]
    fn search_sources_no_answer_single_cjk_character_and_hidden_paths() {
        let sources = Sources::new();
        sources.write("plain.txt", "计划管理只有一段说明。");
        sources.write(".hidden.txt", "missingneedle");
        sources.write(".cache/plain.txt", "missingneedle");
        assert_eq!(sources.search("计划", 10).len(), 1);
        assert!(sources.search("missingneedle", 10).is_empty());
        assert!(sources.search("怎样进行量子纠缠实验？", 10).is_empty());
        assert!(sources.search("划", 10).is_empty());
    }

    #[test]
    fn search_sources_package_titles_reuse_existing_metadata_without_changing_paths() {
        let sources = Sources::new();
        for (directory, title, body, original, expected) in [
            (
                "a.wiki-source",
                "清单书名",
                "# 正文书名\n\ntitleneedle evidence.",
                "original.pdf",
                "清单书名",
            ),
            (
                "b.wiki-source",
                "",
                "# 第二本书\n\ntitleneedle evidence.",
                "original.pdf",
                "第二本书",
            ),
            (
                "c.wiki-source",
                "",
                "titleneedle evidence.",
                "第三本书.pdf",
                "第三本书.pdf",
            ),
        ] {
            sources.write(&format!("{directory}/source.md"), body);
            sources.write(
                &format!("{directory}/manifest.json"),
                &serde_json::json!({
                    "version": 1, "title": title, "source": {"filename": "source.md"},
                    "images": [], "original": {"filename": original}
                })
                .to_string(),
            );
            let path = format!("raw/sources/{directory}/source.md");
            let refs = sources.search("titleneedle", 10);
            let reference = refs.iter().find(|r| r.path == path).unwrap();
            assert_eq!(reference.title, expected);
            assert_eq!(reference.kind, "source");
        }
    }

    #[test]
    fn search_sources_oversized_paragraph_keeps_each_distant_match_bounded() {
        let sources = Sources::new();
        sources.write(
            "long.txt",
            &format!(
                "{}firstneedle{}secondneedle{}",
                "头".repeat(3000),
                "中".repeat(4000),
                "尾".repeat(3000)
            ),
        );
        let refs = sources.search("firstneedle secondneedle", 10);
        assert!(refs
            .iter()
            .any(|r| r.snippet.as_deref().unwrap().contains("firstneedle")));
        assert!(refs
            .iter()
            .any(|r| r.snippet.as_deref().unwrap().contains("secondneedle")));
        assert!(refs
            .iter()
            .all(|r| r.snippet.as_deref().unwrap().chars().count() <= 1500));
        assert!(refs
            .iter()
            .all(|r| r.snippet.as_deref().unwrap().contains("…")));
    }

    #[cfg(unix)]
    #[test]
    fn search_sources_symlinks_and_binary_cache_cannot_escape_project() {
        use std::os::unix::fs::symlink;
        let sources = Sources::new();
        let outside = Sources::new();
        outside.write("outside.txt", "outsideneedle");
        sources.write("inside.txt", "insideneedle");
        let raw = sources.0.join("raw/sources");
        symlink(outside.0.join("raw/sources"), raw.join("linked-dir")).unwrap();
        symlink(
            outside.0.join("raw/sources/outside.txt"),
            raw.join("linked.txt"),
        )
        .unwrap();
        sources.write("document.pdf", "%PDF placeholder");
        symlink(outside.0.join("raw/sources"), raw.join(".cache")).unwrap();
        outside.write("document.pdf.txt", "outsideneedle");
        assert_eq!(sources.search("insideneedle", 5).len(), 1);
        assert!(sources.search("outsideneedle", 5).is_empty());
        let escape = Sources::new();
        fs::remove_dir(escape.0.join("raw/sources")).unwrap();
        symlink(outside.0.join("raw/sources"), escape.0.join("raw/sources")).unwrap();
        assert!(escape.search("outsideneedle", 5).is_empty());
    }
}
