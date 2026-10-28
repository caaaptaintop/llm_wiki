"""Run with python3 -B -m unittest discover -s scripts -p test_prepare_book_source.py."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('prepare-book-source.py')
SPEC = importlib.util.spec_from_file_location('prepare_book_source', SCRIPT)
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)


def without_markers(source):
    return re.sub(r'<!-- source-location: (?:pdf-page|epub-spine):\d+/block:\d+ -->\n'
                  r'|\n<!-- source-location: unknown -->', '', source)


def location_spans(source):
    """Independent consumer: location persists only until the next marker."""
    current, cursor, spans = None, 0, []
    for marker in re.finditer(r'<!-- source-location: ([^\n]+?) -->', source):
        spans.append((current, source[cursor:marker.start()]))
        current = None if marker[1] == 'unknown' else marker[1]
        cursor = marker.end()
    spans.append((current, source[cursor:]))
    return spans


class PrepareBookSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.markdown = self.root / 'cleaned.md'
        self.output = self.root / 'package'
        self.structured = self.root / 'structured_content.json'
        (self.root / 'images').mkdir()

    def structure(self, blocks, suffix='epub', page_idx=1, **metadata):
        value = {'metadata': {'file_suffix': suffix, **metadata},
                 'pages': [{'page_idx': page_idx, 'blocks': blocks}]}
        self.structured.write_text(json.dumps(value), encoding='utf-8')
        return value

    def read_manifest(self):
        return json.loads((self.output / 'manifest.json').read_text(encoding='utf-8'))

    def test_plain_source_is_byte_exact_and_only_referenced_images_are_copied(self):
        data = '\ufeff# 标题\r\n\r\n😀 原文\r\n![](images/a.png)\r\n'.encode()
        self.markdown.write_bytes(data)
        (self.root / 'images/a.png').write_bytes(b'used image')
        (self.root / 'images/unused.png').write_bytes(b'not used')
        original = self.root / 'original.epub'
        original.write_bytes(b'original binary')
        packager.prepare(self.markdown, self.output, original_path=original)
        self.assertEqual((self.output / 'source.md').read_bytes(), data)
        self.assertEqual((self.output / 'images/a.png').read_bytes(), b'used image')
        self.assertFalse((self.output / 'images/unused.png').exists())
        self.assertFalse((self.output / original.name).exists())
        manifest = self.read_manifest()
        self.assertEqual(manifest['original'], {'filename': 'original.epub',
                         'sha256': hashlib.sha256(b'original binary').hexdigest()})
        self.assertEqual(manifest['source']['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(manifest['warnings'], [])
        self.assertNotIn(str(self.root), json.dumps(manifest))
        self.assertNotIn('docid', manifest)

    def test_heading_repair_and_epub_spine_positions_preserve_every_original_character(self):
        markdown = '<a id="keep"></a>\n# 第一章\n\n😀 原文引用\n\n![](images/a.png)\n'
        self.markdown.write_text(markdown, encoding='utf-8')
        (self.root / 'images/a.png').write_bytes(b'image')
        self.structure([
            {'type': 'paragraph_title', 'level': 3, 'content': '第一章'},
            {'type': 'text', 'content': '😀 原文引用'},
            {'type': 'image', 'image_source': 'images/a.png', 'content': ''},
        ], document={'page_count_kind': 'spine'})
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        source = (self.output / 'source.md').read_text()
        self.assertIn('<!-- source-location: epub-spine:2/block:1 -->\n# 第一章', source)
        self.assertIn('<!-- source-location: epub-spine:2/block:2 -->\n😀 原文引用', source)
        self.assertIn('<!-- source-location: epub-spine:2/block:3 -->\n![](images/a.png)', source)
        self.assertNotIn('pdf-page:', source)
        self.assertEqual(without_markers(source), markdown)
        self.assertEqual(source.count('<!-- source-location: unknown -->'), 3)
        self.assertEqual(manifest['matched_blocks'], 3)
        self.assertEqual(manifest['unmatched_blocks'], 0)

    def test_pdf_page_index_and_original_block_ordinals_survive_unmatched_blocks(self):
        self.markdown.write_text('Text\n\n# Changed meaning\n\nEnd\n', encoding='utf-8')
        self.structure([{'type': 'text', 'content': 'Text'},
                        {'type': 'paragraph_title', 'content': 'Original meaning'},
                        {'type': 'text', 'content': 'End'}], suffix='pdf', page_idx=4)
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        source = (self.output / 'source.md').read_text()
        self.assertIn('pdf-page:5/block:1', source)
        self.assertIn('pdf-page:5/block:3', source)
        self.assertNotIn('block:2 -->', source)
        self.assertIn('# Changed meaning', source)
        self.assertEqual(manifest['unmatched_blocks'], 1)
        self.assertEqual(len(manifest['warnings']), 1)

    def test_mixed_matches_never_assign_unmatched_prefix_middle_or_suffix_to_a_block(self):
        markdown = 'Unmatched prefix\n\n# Verified heading\n\nChanged paragraph\n\nVerified ending\n\nUnmatched suffix'
        self.markdown.write_text(markdown, encoding='utf-8')
        self.structure([{'type': 'paragraph_title', 'content': 'Verified heading'},
                        {'type': 'text', 'content': 'Original paragraph'},
                        {'type': 'text', 'content': 'Verified ending'}])
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        source = (self.output / 'source.md').read_text()
        spans = location_spans(source)
        known = [(location, text.strip()) for location, text in spans if location]
        self.assertEqual(known, [('epub-spine:2/block:1', '# Verified heading'),
                                 ('epub-spine:2/block:3', 'Verified ending')])
        unknown = ''.join(text for location, text in spans if location is None)
        for text in ('Unmatched prefix', 'Changed paragraph', 'Unmatched suffix'):
            self.assertIn(text, unknown)
        self.assertEqual((manifest['matched_blocks'], manifest['unmatched_blocks']), (2, 1))
        self.assertEqual(source.count('<!-- source-location: unknown -->'), 2)
        self.assertEqual(without_markers(source), markdown)

    def test_resets_at_eof_and_adjacent_blocks_preserve_crlf_and_exact_match_extent(self):
        for markdown in ('Text', '# Heading\r\nText\r\n', '```txt\nQuoted\n```\nUnmatched'):
            with self.subTest(markdown=markdown):
                blocks = ([{'type': 'code', 'content': '```txt\nQuoted\n```'}] if markdown.startswith('```')
                          else [{'type': 'paragraph_title', 'content': 'Heading'}, {'type': 'text', 'content': 'Text'}])
                value = {'metadata': {'file_suffix': 'pdf'}, 'pages': [{'page_idx': 0, 'blocks': blocks}]}
                source, _, matched, _, _ = packager.locate_blocks(markdown, value, [])
                self.assertEqual(source.count('<!-- source-location: unknown -->'), matched)
                self.assertEqual(without_markers(source), markdown)
                known = [text.strip() for location, text in location_spans(source) if location]
                if markdown == 'Text':
                    self.assertEqual(known, ['Text'])
                    self.assertTrue(source.endswith('\n<!-- source-location: unknown -->'))
                elif markdown.startswith('#'):
                    self.assertEqual(known, ['# Heading', 'Text'])
                else:
                    self.assertEqual(known, ['```txt\nQuoted\n```'])

    def test_matching_never_moves_backwards_or_accepts_substring_quotes(self):
        self.markdown.write_text('Earlier\n\nLater\n\nText has extra words\n', encoding='utf-8')
        self.structure([{'type': 'text', 'content': 'Later'}, {'type': 'text', 'content': 'Earlier'},
                        {'type': 'text', 'content': 'Text'}])
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        # Either reversed exact block could be kept; neither is unambiguous.
        self.assertEqual(manifest['matched_blocks'], 0)
        self.assertEqual(manifest['unmatched_blocks'], 3)
        self.assertEqual(len(manifest['warnings']), 3)

    def test_repeated_blocks_are_matched_only_when_their_order_is_unambiguous(self):
        self.markdown.write_text('Same\n\nSame\n', encoding='utf-8')
        self.structure([{'type': 'text', 'content': 'Same'}] * 3)
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        # With one of three identical structured blocks missing, all choices are
        # equally plausible. With both original blocks present, order pins both.
        self.assertEqual(manifest['matched_blocks'], 0)
        self.assertEqual(manifest['unmatched_blocks'], 3)
        value = self.structure([{'type': 'text', 'content': 'Same'}] * 2)
        source, _, matched, unmatched, _ = packager.locate_blocks('Same\n\nSame\n', value, [])
        self.assertEqual((matched, unmatched), (2, 0))
        self.assertEqual([location for location, _ in location_spans(source) if location],
                         ['epub-spine:2/block:1', 'epub-spine:2/block:2'])

    def test_changed_first_repeated_heading_cannot_steal_second_page_location(self):
        for first_heading in ('# Changed first heading\n\n', ''):
            with self.subTest(first_heading=first_heading):
                markdown = first_heading + 'The first page body.\n\n# Repeated heading\n\nThe second page body.\n'
                value = {'metadata': {'file_suffix': 'pdf'}, 'pages': [
                    {'page_idx': 0, 'blocks': [
                        {'type': 'paragraph_title', 'content': 'Repeated heading'},
                        {'type': 'text', 'content': 'The first page body.'}]},
                    {'page_idx': 1, 'blocks': [
                        {'type': 'paragraph_title', 'content': 'Repeated heading'},
                        {'type': 'text', 'content': 'The second page body.'}]},
                ]}
                source, _, matched, unmatched, warnings = packager.locate_blocks(markdown, value, [])
                known = [(location, text.strip()) for location, text in location_spans(source) if location]
                self.assertEqual(known, [('pdf-page:1/block:2', 'The first page body.'),
                                         ('pdf-page:2/block:1', '# Repeated heading'),
                                         ('pdf-page:2/block:2', 'The second page body.')])
                self.assertEqual((matched, unmatched, len(warnings)), (3, 1, 1))
                self.assertEqual(without_markers(source), markdown)

    def test_repeated_heading_without_distinguishing_context_is_unknown(self):
        markdown = '# Repeated heading\n\nSecond body\n'
        value = {'metadata': {'file_suffix': 'pdf'}, 'pages': [
            {'page_idx': 0, 'blocks': [{'type': 'paragraph_title', 'content': 'Repeated heading'},
                                      {'type': 'text', 'content': 'Missing first body'}]},
            {'page_idx': 1, 'blocks': [{'type': 'paragraph_title', 'content': 'Repeated heading'},
                                      {'type': 'text', 'content': 'Second body'}]},
        ]}
        source, _, _, _, warnings = packager.locate_blocks(markdown, value, [])
        known = [(location, text.strip()) for location, text in location_spans(source) if location]
        self.assertEqual(known, [('pdf-page:2/block:2', 'Second body')])
        self.assertTrue(warnings)
        self.assertEqual(without_markers(source), markdown)

    def test_explicit_partial_pdf_never_claims_original_physical_page_numbers(self):
        for full in (False, True, None):
            with self.subTest(is_full_document=full):
                value = {'metadata': {'file_suffix': 'pdf'}, 'pages': [
                    {'page_idx': 0, 'blocks': [{'type': 'text', 'content': 'Text'}]}]}
                if full is not None:
                    value['is_full_document'] = full
                source, kind, matched, _, warnings = packager.locate_blocks('Text', value, [])
                if full is False:
                    self.assertEqual(source, 'Text')
                    self.assertIsNone(kind)
                    self.assertEqual(matched, 0)
                    self.assertTrue(warnings)
                else:
                    self.assertIn('pdf-page:1/block:1', source)
                    self.assertEqual(matched, 1)

    def test_unknown_or_conflicting_format_never_invents_pdf_pages(self):
        for metadata in ({}, {'file_suffix': 'pdf', 'document': {'page_count_kind': 'spine'}}):
            with self.subTest(metadata=metadata):
                structure = {'metadata': metadata, 'pages': [{'page_idx': 0, 'blocks': [{'type': 'text', 'content': 'Text'}]}]}
                source, kind, matched, unmatched, warnings = packager.locate_blocks('Text', structure, [])
                self.assertEqual(source, 'Text')
                self.assertIsNone(kind)
                self.assertEqual((matched, unmatched), (0, 1))
                self.assertTrue(warnings)

    def test_reference_images_html_and_code_examples(self):
        self.markdown.write_text('![caption][pic]\n![pic]\n[pic]: <images/a b.png> "Title"\n'
                                 '<img alt="caption" src="images/nested/c.png">\n'
                                 '```md\n![](images/not-real.png)\n```\n'
                                 '    ![](images/not-real-either.png)\n'
                                 '`![](images/also-not-real.png)`\n'
                                 '\\![](images/escaped-example.png)\n', encoding='utf-8')
        (self.root / 'images/a b.png').write_bytes(b'a')
        (self.root / 'images/nested').mkdir()
        (self.root / 'images/nested/c.png').write_bytes(b'c')
        manifest = packager.prepare(self.markdown, self.output)
        self.assertEqual([x['path'] for x in manifest['images']], ['images/a b.png', 'images/nested/c.png'])
        source = (self.output / 'source.md').read_text()
        self.assertTrue(source.startswith('![caption](images/a%20b.png)\n![pic](images/a%20b.png)\n'))
        self.assertIn('[pic]: <images/a b.png> "Title"', source)
        self.assertIn('![caption](images/nested/c.png)', source)
        self.assertNotIn('<img', source)
        self.assertIn('```md\n![](images/not-real.png)\n```', source)
        self.assertIn('`![](images/also-not-real.png)`', source)
        self.assertEqual(manifest['transformations']['image_references'], 'inline-markdown')

    def test_image_titles_html_alt_and_parentheses_normalize_after_location_matching(self):
        markdown = '![inline alt](<images/a (1).jpg> "Title")\n\n'
        markdown += '<img src="images/a (1).jpg" alt="HTML alt" title="Discard title">\n\nChanged\n'
        self.markdown.write_text(markdown, encoding='utf-8')
        (self.root / 'images/a (1).jpg').write_bytes(b'jpeg')
        self.structure([{'type': 'image', 'image_source': 'images/a (1).jpg'},
                        {'type': 'image', 'image_source': 'images/a (1).jpg'},
                        {'type': 'text', 'content': 'Original'}])
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        source = (self.output / 'source.md').read_text()
        known = [(location, text.strip()) for location, text in location_spans(source) if location]
        self.assertEqual(known, [('epub-spine:2/block:1', '![inline alt](images/a%20%281%29.jpg)'),
                                 ('epub-spine:2/block:2', '![HTML alt](images/a%20%281%29.jpg)')])
        self.assertNotIn('title=', source)
        self.assertNotIn('"Title"', source)
        self.assertEqual((manifest['matched_blocks'], manifest['unmatched_blocks']), (2, 1))
        self.assertIn('Changed', ''.join(text for location, text in location_spans(source) if location is None))
        self.assertEqual(manifest['transformations']['image_titles'], 'removed')

    def test_unsupported_image_formats_are_explicit_errors(self):
        for extension in ('svg', 'bmp', 'tiff', 'avif', 'pdf'):
            with self.subTest(extension=extension):
                (self.root / f'images/a.{extension}').write_bytes(b'image')
                self.markdown.write_text(f'![](images/a.{extension})', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Unsupported image format'):
                    packager.prepare(self.markdown, self.output)
                self.assertFalse(self.output.exists())

    def test_titles_and_text_inside_fences_cannot_capture_real_block_locations(self):
        markdown = '```md\n# Chapter I\nRepeated text\n```\n\n## Chapter I\nRepeated text\n'
        self.markdown.write_text(markdown, encoding='utf-8')
        self.structure([{'type': 'paragraph_title', 'content': 'Chapter I'},
                        {'type': 'text', 'content': 'Repeated text'}])
        manifest = packager.prepare(self.markdown, self.output, self.structured)
        source = (self.output / 'source.md').read_text()
        self.assertTrue(source.startswith('```md\n# Chapter I\nRepeated text\n```\n\n<!-- source-location:'))
        self.assertEqual(manifest['matched_blocks'], 2)

    def test_invalid_schema_and_nonmonotonic_page_indices_never_guess_positions(self):
        with self.assertRaises(ValueError):
            packager.locate_blocks('Text', {'pages': 'wrong'}, [])
        with self.assertRaises(ValueError):
            packager.locate_blocks('Text', {'metadata': {'document': 'wrong'}, 'pages': []}, [])
        value = {'metadata': {'file_suffix': 'pdf'}, 'pages': [
            {'page_idx': 1, 'blocks': [{'type': 'text', 'content': 'First'}]},
            {'page_idx': 0, 'blocks': [{'type': 'text', 'content': 'Second'}]},
            {'page_idx': -1, 'blocks': [{'type': 'text', 'content': 'Third'}]},
        ]}
        _, _, matched, unmatched, warnings = packager.locate_blocks('First\nSecond\nThird', value, [])
        self.assertEqual((matched, unmatched), (1, 2))
        self.assertEqual(len(warnings), 2)

    def test_image_paths_reject_traversal_absolute_protocol_and_encoded_escapes(self):
        for target in ('../secret.png', 'images/../secret.png', '/tmp/secret.png',
                       'https://example.com/image.png', '//example.com/image.png',
                       'data:image/png;base64,xxx', 'file:///tmp/secret.png',
                       'images/%2e%2e/secret.png', 'images/%2Ftmp/../secret.png',
                       'images/..%5csecret.png', 'C:/secret.png'):
            with self.subTest(target=target):
                self.markdown.write_text(f'![]({target})', encoding='utf-8')
                with self.assertRaises(ValueError):
                    packager.prepare(self.markdown, self.output)
                self.assertFalse(self.output.exists())

    def test_symlink_file_and_directory_escape_are_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'secret.png').write_bytes(b'secret')
        (self.root / 'images/link.png').symlink_to(outside / 'secret.png')
        (self.root / 'images/linkdir').symlink_to(outside, target_is_directory=True)
        for target in ('images/link.png', 'images/linkdir/secret.png'):
            with self.subTest(target=target):
                self.markdown.write_text(f'![]({target})', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'symlink'):
                    packager.prepare(self.markdown, self.output)
                self.assertFalse(self.output.exists())

    def test_missing_resources_and_inputs_fail_before_creating_output(self):
        self.markdown.write_text('![](images/missing.png)', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'does not exist'):
            packager.prepare(self.markdown, self.output)
        self.assertFalse(self.output.exists())
        self.markdown.write_text('Text', encoding='utf-8')
        for kwargs in ({'structured_path': self.structured}, {'original_path': self.root / 'missing.pdf'}):
            with self.assertRaises(OSError):
                packager.prepare(self.markdown, self.output, **kwargs)
            self.assertFalse(self.output.exists())
        with self.assertRaises(OSError):
            packager.prepare(self.root / 'missing.md', self.output)

    def test_existing_output_including_dangling_symlink_is_never_overwritten(self):
        self.markdown.write_text('Text', encoding='utf-8')
        self.output.mkdir()
        (self.output / 'keep').write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            packager.prepare(self.markdown, self.output)
        self.assertEqual((self.output / 'keep').read_bytes(), b'keep')
        link = self.root / 'dangling'
        link.symlink_to(self.root / 'absent', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            packager.prepare(self.markdown, link)

    def test_cli_success_and_error_exit_codes(self):
        self.markdown.write_text('Text', encoding='utf-8')
        command = [sys.executable, '-B', str(SCRIPT), '--markdown', str(self.markdown), '--output', str(self.output)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['images'], 0)
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refusing to overwrite', result.stderr)

    def test_copied_single_script_runs_outside_repository(self):
        standalone = self.root / 'portable.py'
        shutil.copyfile(SCRIPT, standalone)
        self.markdown.write_text('Portable', encoding='utf-8')
        result = subprocess.run([sys.executable, '-B', str(standalone), '--markdown', str(self.markdown),
                                 '--output', str(self.output)], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.output / 'source.md').read_text(), 'Portable')


if __name__ == '__main__':
    unittest.main()
