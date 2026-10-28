#!/usr/bin/env python3
"""Package existing Markdown and referenced images; Python standard library only.

No OCR, model calls, title rewriting, document-ID inference, or binary import.
source.md only adds verified location comments and normalizes actual image
references to inline Markdown with URL-encoded paths (alt preserved, title
removed). Code examples are unchanged. Location matching precedes normalization.

A positive source-location comment starts one exactly matched block. The
standalone unknown comment immediately after its end resets the location.
Content before the first positive marker and after each reset has no verified
location. Consumers must start in the unknown state and respect every reset.
"""

import argparse
from bisect import bisect_left, bisect_right
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
from urllib.parse import quote, unquote, urlsplit


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_metadata(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return {'filename': path.name, 'sha256': checksum.hexdigest()}


def mask_code(text, inline=True):
    """Keep offsets while excluding fenced/indented/inline code from images."""
    lines = []
    fence = None
    for line in text.splitlines(keepends=True):
        delimiter = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)', line)
        hidden = fence is not None or delimiter is not None or re.match(r'^( {4}|\t)', line)
        if fence:
            if delimiter and delimiter[1][0] == fence[0] and len(delimiter[1]) >= len(fence) and not delimiter[2].strip():
                fence = None
        elif delimiter:
            fence = delimiter[1]
        lines.append(re.sub(r'[^\r\n]', ' ', line) if hidden else line)
    masked = ''.join(lines)
    if inline:
        masked = re.sub(r'(`+)([^`]|(?!\1)`)*?\1', lambda m: re.sub(r'[^\r\n]', ' ', m[0]), masked)
    return masked


class ImageTag(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'img':
            attrs = dict(attrs)
            if 'srcset' in attrs:
                raise ValueError('HTML img srcset is unsupported; use explicit image src paths')
            self.src = attrs.get('src')
            self.alt = attrs.get('alt') or ''


def image_references(markdown):
    """Read common inline, reference-style, and HTML images; never fetch URLs."""
    masked = mask_code(markdown)
    definitions = {}
    for match in re.finditer(r'^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)', masked, re.M):
        definitions.setdefault(' '.join(match[1].split()).casefold(), match[2].strip('<>'))
    pattern = re.compile(
        r'!\[((?:\\.|[^\]\\])*)\]'
        r'(?:\(\s*(<[^>\r\n]*>|(?:\\.|[^()\s]|\([^()\r\n]*\))+)'
        r'(?:[ \t]+(?:"[^"\n]*"|\x27[^\x27\n]*\x27|\([^\)\n]*\)))?\s*\)'
        r'|\[([^\]\r\n]*)\])?'
    )
    references = []
    for match in pattern.finditer(masked):
        preceding = masked[:match.start()]
        if (len(preceding) - len(preceding.rstrip('\\'))) % 2:
            continue  # Escaped ! is literal Markdown, not an image.
        if match[2] is not None:
            target = match[2].strip('<>')
        else:
            if masked[match.end():].startswith('('):
                raise ValueError('Unsupported inline image destination: ' + match[0])
            label = ' '.join((match[3] or match[1]).split()).casefold()
            if label not in definitions:
                raise ValueError('Missing or unsupported Markdown image reference: ' + match[0])
            target = definitions[label]
        target = re.sub(r'\\([\\ ()])', r'\1', target)
        references.append((match.start(), match.end(), target, match[1]))
    for match in re.finditer(r'<img\b[^>]*>', masked, re.I):
        tag = ImageTag()
        tag.src = None
        tag.feed(match[0])
        if not tag.src:
            raise ValueError('HTML image has no src')
        references.append((match.start(), match.end(), tag.src, tag.alt))
    return sorted(references)


def image_path(base, target):
    target = unquote(html.unescape(target))
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or '\\' in target or '\x00' in target:
        raise ValueError('Image must be a relative path inside images/: ' + target)
    path = PurePosixPath(target)
    if path.is_absolute() or '..' in path.parts or len(path.parts) < 2 or path.parts[0] != 'images':
        raise ValueError('Image must stay inside the input images/ directory: ' + target)
    if path.suffix.lower() not in {'.png', '.jpeg', '.jpg', '.webp', '.gif'}:
        raise ValueError('Unsupported image format (use PNG/JPEG/JPG/WebP/GIF): ' + target)
    current = base
    for part in path.parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Image symlinks are not accepted: ' + target)
    if not current.is_file():
        raise ValueError('Referenced image does not exist: ' + target)
    return path.as_posix(), current


def normalize_images(markdown, base):
    parts = []
    cursor = 0
    for start, end, target, alt in image_references(markdown):
        relative, _ = image_path(base, target)
        # Keep visible alt text while avoiding brackets/newlines in the simple
        # inline syntax expected by the importer. Reference definitions stay put.
        alt = re.sub(r'\\([\\\[\]])', r'\1', alt)
        alt = alt.replace('[', '&#91;').replace(']', '&#93;').replace('\r', '&#13;').replace('\n', '&#10;')
        parts.extend((markdown[cursor:start], f'![{alt}]({quote(relative, safe="/")})'))
        cursor = end
    parts.append(markdown[cursor:])
    return ''.join(parts)


def location_kind(structure, warnings):
    metadata = structure.get('metadata') or {}
    if not isinstance(metadata, dict) or not isinstance(metadata.get('document') or {}, dict):
        raise ValueError('Structured metadata and metadata.document must be objects')
    suffix = str(metadata.get('file_suffix', '')).lower().lstrip('.')
    count_kind = (metadata.get('document') or {}).get('page_count_kind')
    if suffix == 'epub' or count_kind == 'spine':
        if suffix == 'pdf':
            warnings.append('Conflicting PDF suffix and spine metadata; no locations inserted.')
            return None
        return 'epub-spine'
    if suffix == 'pdf':
        if structure.get('is_full_document') is False:
            warnings.append('Partial PDF has no supported original-page mapping; no PDF locations inserted.')
            return None
        return 'pdf-page'
    warnings.append('Source format is not explicit in structured metadata; no locations inserted.')
    return None


def unambiguous_alignment(groups):
    """Keep only pairs present in every longest exact, order-preserving alignment.

    A later body can anchor a repeated heading to its proper page. If removing
    blocks makes several alignments equally good, none of their disputed pairs
    are evidence. Scores are computed without consuming a greedy source cursor.
    """
    nodes, grouped_ids = [], []
    for group, matches in enumerate(groups):
        ids = []
        for start, end in matches:
            ids.append(len(nodes))
            nodes.append((group, start, end))
        grouped_ids.append(ids)

    def scores(reverse=False):
        # Prefix maxima indexed by source offset; stage updates per structured
        # block so no alignment can use the same block twice. Reverse coordinates
        # give the corresponding suffix scores in O(candidates * log candidates).
        coordinates = sorted({-start if reverse else end for _, start, end in nodes})
        tree = [0] * (len(coordinates) + 1)
        result = [0] * len(nodes)
        for ids in reversed(grouped_ids) if reverse else grouped_ids:
            updates = []
            for node_id in ids:
                _, start, end = nodes[node_id]
                left, right = (-end, -start) if reverse else (start, end)
                index = bisect_right(coordinates, left)
                best = 0
                while index:
                    best = max(best, tree[index])
                    index -= index & -index
                result[node_id] = best + 1
                updates.append((bisect_left(coordinates, right) + 1, best + 1))
            for index, value in updates:
                while index < len(tree):
                    tree[index] = max(tree[index], value)
                    index += index & -index
        return result

    prefix, suffix = scores(), scores(reverse=True)
    longest = max(prefix, default=0)
    alternatives = {}
    for node_id in range(len(nodes)):
        if prefix[node_id] + suffix[node_id] - 1 == longest:
            alternatives.setdefault(prefix[node_id], []).append(node_id)
    return [nodes[ids[0]] for _, ids in sorted(alternatives.items()) if len(ids) == 1]


def locate_blocks(markdown, structure, references):
    if not isinstance(structure, dict) or not isinstance(structure.get('pages'), list):
        raise ValueError('Expected MinerU 4 structured content with a pages array')
    warnings = []
    kind = location_kind(structure, warnings)
    groups, labels = [], []
    last_page = -1
    outside_code = mask_code(markdown, inline=False)
    for page in structure['pages']:
        if not isinstance(page, dict) or not isinstance(page.get('blocks'), list):
            raise ValueError('Each structured page must have a blocks array')
        page_idx = page.get('page_idx')
        valid_index = type(page_idx) is int and page_idx >= 0 and page_idx > last_page
        if valid_index:
            last_page = page_idx
        for block_idx, block in enumerate(page['blocks'], 1):
            labels.append((page_idx, block_idx))
            matches = []
            groups.append(matches)
            if not valid_index or not kind or not isinstance(block, dict):
                continue
            content = block.get('content')
            if block.get('type') == 'image' and isinstance(block.get('image_source'), str):
                for start, end, target, _ in references:
                    if target == block['image_source']:
                        left = markdown.rfind('\n', 0, start) + 1
                        right = markdown.find('\n', end)
                        if right < 0:
                            right = len(markdown)
                        if not markdown[left:start].strip() and not markdown[end:right].strip():
                            matches.append((left, end))
            elif isinstance(content, str) and content.strip():
                # Only title markers may differ after DeepSeek heading repair.
                content = content.strip('\r\n')
                if block.get('type') in ('paragraph_title', 'doc_title', 'title'):
                    content = re.sub(r'^ {0,3}#{1,6}[ \t]+', '', content)
                    pattern = r'^ {0,3}(?:#{1,6}[ \t]+)?' + re.escape(content) + r'(?=\r?$)'
                else:
                    pattern = r'^' + re.escape(content) + r'(?=\r?$)'
                haystack = markdown if block.get('type') == 'code' else outside_code
                if content.strip():
                    matches.extend((found.start(), found.end()) for found in re.finditer(pattern, haystack, re.M))
    aligned = unambiguous_alignment(groups)
    verified = {group for group, _, _ in aligned}
    for group, (page_idx, block_idx) in enumerate(labels):
        if group not in verified:
            reason = 'Ambiguous or conflicting block alignment' if groups[group] else 'No exact block match'
            warnings.append(f'{reason}: page_idx={page_idx}, block={block_idx}')
    insertions = []
    for group, start, end in aligned:
        page_idx, block_idx = labels[group]
        insertions.append((start, f'<!-- source-location: {kind}:{page_idx + 1}/block:{block_idx} -->\n'))
        # Keep each verified scope bounded, including EOF and CRLF input.
        insertions.append((end, '\n<!-- source-location: unknown -->'))
    parts = []
    cursor = 0
    for offset, marker in insertions:
        parts.extend((markdown[cursor:offset], marker))
        cursor = offset
    parts.append(markdown[cursor:])
    return ''.join(parts), kind, len(aligned), len(labels) - len(aligned), warnings


def prepare(markdown_path, output_path, structured_path=None, original_path=None):
    markdown_path = Path(markdown_path).resolve(strict=True)
    output_path = Path(output_path).absolute()
    if os.path.lexists(output_path):
        raise ValueError('Output already exists; refusing to overwrite: ' + str(output_path))
    original_path = Path(original_path).resolve(strict=True) if original_path else None
    structured_path = Path(structured_path).resolve(strict=True) if structured_path else None
    data = markdown_path.read_bytes()
    markdown = data.decode('utf-8')
    references = image_references(markdown)
    resources = {}
    for _, _, target, _ in references:
        relative, path = image_path(markdown_path.parent, target)
        if relative not in resources:
            resources[relative] = path.read_bytes()
    source = markdown
    kind, matched, unmatched, warnings = None, 0, 0, []
    if structured_path:
        structure = json.loads(structured_path.read_bytes())
        source, kind, matched, unmatched, warnings = locate_blocks(markdown, structure, references)
    source = normalize_images(source, markdown_path.parent)
    source_bytes = source.encode('utf-8')
    manifest = {
        'version': 1,
        'author': 'admin',
        'input': {'filename': markdown_path.name, 'sha256': digest(data)},
        'source': {'filename': 'source.md', 'sha256': digest(source_bytes)},
        'images': [{'path': name, 'sha256': digest(value)} for name, value in sorted(resources.items())],
        'location_kind': kind,
        'matched_blocks': matched,
        'unmatched_blocks': unmatched,
        'warnings': warnings,
        'transformations': {
            'image_references': 'inline-markdown',
            'image_paths': 'percent-encoded',
            'image_alt': 'preserved',
            'image_titles': 'removed',
            'source_locations': 'matched-block-only; initial state unknown; unknown resets scope',
        },
    }
    if structured_path:
        manifest['structured_content'] = file_metadata(structured_path)
    if original_path:
        manifest['original'] = file_metadata(original_path)
    output_path.mkdir()  # Exclusive creation; the parent must already exist.
    try:
        (output_path / 'images').mkdir()
        for relative, value in resources.items():
            destination = output_path / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(value)
        (output_path / 'source.md').write_bytes(source_bytes)
        (output_path / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except BaseException:
        shutil.rmtree(output_path)
        raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--markdown', required=True, type=Path, help='Existing UTF-8 cleaned.md or original Markdown')
    parser.add_argument('--structured-content', type=Path, help='Optional MinerU 4 structured_content.json')
    parser.add_argument('--original', type=Path, help='Optional original file; record filename/SHA-256 only')
    parser.add_argument('--output', required=True, type=Path, help='New output directory; its parent must exist')
    args = parser.parse_args()
    try:
        manifest = prepare(args.markdown, args.output, args.structured_content, args.original)
    except (OSError, ValueError) as error:
        parser.exit(1, 'Error: ' + str(error) + '\n')
    print(json.dumps({'output': str(args.output.absolute()), 'images': len(manifest['images']),
                      'matched_blocks': manifest['matched_blocks'], 'unmatched_blocks': manifest['unmatched_blocks'],
                      'warnings': len(manifest['warnings'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
