import test from 'node:test';
import assert from 'node:assert';
import { convert, isEmptyDoc, type ConvertOptions, type LinkResolution } from '../src/core/adoc.ts';
import type { AdfMark, AdfNode } from '../src/core/adf.ts';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const t = (text: string, ...marks: (string | AdfMark)[]): AdfNode => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) } : {}) });
const cell = (type: string, ...content: AdfNode[]): AdfNode => ({ type, attrs: {}, content });
const row = (...cells: AdfNode[]): AdfNode => ({ type: 'tableRow', content: cells });
const body = (adf: AdfNode, opts?: ConvertOptions) => convert(adf, opts).body;

test('escapes Salesforce names and merge fields, keeps plain words readable', () => {
  const out = body(doc(p(t('Set Order_Summary__c and {!Account.Name} via {plain} on C++ or a + b'))));
  assert.match(out, /\+\+Order_Summary__c\+\+/);
  assert.match(out, /\{!Account\.Name\}/); // not an attribute reference, left alone
  assert.match(out, /\+\+\{plain\}\+\+/);
  assert.match(out, /pass:c\[C\+\+\]/);
  assert.match(out, /a \{plus\} b/);
  assert.match(out, /^Set /m);
});

test('prefixes lines that would be read as block syntax', () => {
  const out = body(doc(p(t('- not a list'), { type: 'hardBreak' }, t('.NET is text'), { type: 'hardBreak' }, t('1. not ordered'))));
  assert.match(out, /^\{empty\}- not a list \+$/m);
  assert.match(out, /^\{empty\}\.NET is text \+$/m);
  assert.match(out, /^\{empty\}1\. not ordered$/m);
});

test('marks, keeping surrounding spaces outside formatting', () => {
  const out = body(doc(p(t('Bold ', 'strong'), t('code', 'code'), t(' ital', 'em'), t(' gone', 'strike'), t('colored', { type: 'textColor', attrs: { color: '#FF5630' } }))));
  assert.match(out, /\*\*Bold\*\* ``code`` __ital__ \[\.line-through\]##gone##\[\.text-color-ff5630\]##colored##/);
});

test('top-level blocks carry short adf ids; nested blocks do not', () => {
  const adf = doc(
    { type: 'paragraph', attrs: { localId: 'abcdef12-3456' }, content: [t('Top')] },
    { type: 'bulletList', attrs: { localId: 'list0001-x' }, content: [{ type: 'listItem', attrs: { localId: 'item0001-x' }, content: [{ type: 'paragraph', attrs: { localId: 'para0001-x' }, content: [t('item')] }] }] },
  );
  const out = body(adf);
  assert.match(out, /^\[adf=abcdef12\]\nTop$/m);
  assert.match(out, /^\[adf=list0001\]\n\* item$/m);
  assert.doesNotMatch(out, /item0001|para0001/);
});

test('colliding short ids fall back to the full localId', () => {
  const out = body(doc({ type: 'paragraph', attrs: { localId: 'samepref-1' }, content: [t('a')] }, { type: 'paragraph', attrs: { localId: 'samepref-2' }, content: [t('b')] }));
  assert.match(out, /\[adf=samepref-1\]/);
  assert.match(out, /\[adf=samepref-2\]/);
});

test('headings: offset so the top level is ==, Confluence-style anchor ids, discrete inside blocks', () => {
  const r = convert(
    doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Transfer: transfer')] },
      { type: 'heading', attrs: { level: 3 }, content: [t('Child')] },
      { type: 'expand', attrs: { title: 'More' }, content: [{ type: 'heading', attrs: { level: 3 }, content: [t('Inside')] }] },
    ),
  );
  assert.strictEqual(r.headingOffset, 1);
  assert.match(r.body, /^\[#Transfer_-transfer\]\n== Transfer: transfer$/m);
  assert.match(r.body, /^\[#Child\]\n=== Child$/m);
  assert.match(r.body, /^\[discrete#Inside\]\n=== Inside$/m);
});

test('links: in-scope xref with anchor, same-page anchor, out-of-scope counted', () => {
  const link = (href: string): AdfMark => ({ type: 'link', attrs: { href } });
  const resolveLink = (href: string): LinkResolution => {
    if (href.startsWith('#')) return { anchor: href.slice(1) };
    if (href.includes('/pages/2/')) return { xref: '../b.adoc', fragment: 'Transfer%3A-transfer' };
    return { url: href, outOfScope: href.includes('/pages/') };
  };
  const out = body(
    doc(p(t('one', link('https://x.atlassian.net/wiki/spaces/DOCS/pages/2/B')), t(' '), t('two', link('#Orders')), t(' '), t('three', link('https://x.atlassian.net/wiki/spaces/DOCS/pages/9/Other')), t(' '), t('a=b', link('https://e.com/q?a=1')))),
    { resolveLink },
  );
  assert.match(out, /xref:\.\.\/b\.adoc#Transfer_-transfer\[one\]/);
  assert.match(out, /<<Orders,two>>/);
  assert.match(out, /link:https:\/\/x\.atlassian\.net\/wiki\/spaces\/DOCS\/pages\/9\/Other\[three\]/);
  assert.match(out, /link:https:\/\/e\.com\/q\?a=1\["a=b"\]/);
  assert.strictEqual(convert(doc(p(t('x', link('https://x.atlassian.net/wiki/spaces/DOCS/pages/9/O')))), { resolveLink }).report.outOfScopeLinks, 1);
});

test('lists: nesting, continuation blocks, adjacent lists stay separate, tasks', () => {
  const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
  const out = body(
    doc(
      { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('first')), { type: 'bulletList', content: [li(p(t('nested')))] }, p(t('after nested')))] },
      { type: 'bulletList', content: [li(p(t('second list')), { type: 'codeBlock', content: [t('x()')] })] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] }] },
    ),
  );
  assert.match(out, /^\[start=3\]\n\. first\n\*\* nested\n\n\+\nafter nested$/m);
  assert.match(out, /\n\/\/-\n\n\* second list\n\+\n\[source\]\n----\nx\(\)\n----/);
  assert.match(out, /\* \[x\] done/);
});

test('tables: header row, header column, spans, complex cells, escaped pipes', () => {
  const adf = doc({
    type: 'table',
    content: [
      row(cell('tableHeader', p(t('A'))), cell('tableHeader', p(t('B')))),
      row({ type: 'tableCell', attrs: { colspan: 2 }, content: [p(t('wide | piped'))] }),
      row({ type: 'tableHeader', attrs: { rowspan: 2 }, content: [p(t('side'))] }, cell('tableCell', p(t('one')), p(t('two')))),
      row(cell('tableCell', { type: 'codeBlock', content: [t('a|b')] })),
    ],
  });
  const out = body(adf);
  assert.match(out, /^\[%header,cols="1,1"\]\n\|===\n\|A\n\|B\n\n2\+\|wide \\\| piped\n\n\.2\+h\|side\na\|\none\n\ntwo\n\na\|\n\[source\]\n----\na\\\|b\n----\n\|===$/m);
});

test('nested-table extension becomes a !=== table inside an a| cell', () => {
  const inner = { type: 'doc', content: [{ type: 'table', content: [row(cell('tableHeader', p(t('Field'))), cell('tableHeader', p(t('Value')))), row(cell('tableCell', p(t('x!y'))), cell('tableCell', p(t('p|q'))))] }] };
  const adf = doc({
    type: 'table',
    content: [row(cell('tableCell', p(t('outer')), { type: 'extension', attrs: { extensionKey: 'nested-table', parameters: { adf: JSON.stringify(inner) } } }))],
  });
  const r = convert(adf);
  assert.match(r.body, /a\|\nouter\n\n\[%header,cols="1,1",confluence=nested-table\]\n!===\n!Field\n!Value\n\n!x\\!y\n!p\\\|q\n!===/);
  assert.deepStrictEqual(r.report.unsupported, {});
});

test('panels, expands with titles, nested delimiters get longer', () => {
  const out = body(doc({ type: 'expand', attrs: { title: 'Read: Order Header File', localId: 'exp00001' }, content: [{ type: 'panel', attrs: { panelType: 'warning' }, content: [p(t('careful'))] }] }));
  assert.match(out, /^\.Read: Order Header File\n\[%collapsible,adf=exp00001\]\n====\n\[WARNING,panel=warning\]\n=====\ncareful\n=====\n====$/m);
});

test('layouts as comments, details/excerpt as open blocks, toc macro', () => {
  const r = convert(
    doc({
      type: 'layoutSection',
      attrs: { localId: 'lay00001' },
      content: [
        { type: 'layoutColumn', attrs: { width: 50, localId: 'col00001' }, content: [{ type: 'bodiedExtension', attrs: { extensionKey: 'details', localId: 'det00001' }, content: [p(t('props'))] }] },
        { type: 'layoutColumn', attrs: { width: 50, localId: 'col00002' }, content: [{ type: 'extension', attrs: { extensionKey: 'toc', localId: 'toc00001' } }] },
      ],
    }),
  );
  assert.strictEqual(r.toc, true);
  assert.match(r.body, /\/\/ confluence:layout-section adf=lay00001\n\n\/\/ confluence:layout-column adf=col00001 width=50\n\n\[confluence=details,adf=det00001\]\n--\nprops\n--\n\n\/\/ confluence:layout-column adf=col00002 width=50\n\ntoc::\[adf=toc00001\]\n\n\/\/ confluence:layout-end/);
});

test('status, mention, date, inline card', () => {
  const out = body(
    doc(
      p(
        { type: 'status', attrs: { text: 'IN REVIEW', color: 'yellow' } },
        t(' '),
        { type: 'mention', attrs: { id: 'acc1', text: '@Pat Example' } },
        t(' '),
        { type: 'date', attrs: { timestamp: '1776816000000' } },
        t(' '),
        { type: 'inlineCard', attrs: { url: 'https://e.com/x' } },
      ),
    ),
  );
  assert.strictEqual(out, '[.status-yellow]##IN REVIEW## [.mention]##@Pat Example## [.date]##2026-04-22## [.card]##link:https://e.com/x[]##\n');
});

test('media: resolved to local path; missing keeps a marked placeholder', () => {
  const ms = (id: string, alt: string): AdfNode => ({ type: 'mediaSingle', attrs: { layout: 'center', width: 600, widthType: 'pixel' }, content: [{ type: 'media', attrs: { id, alt, type: 'file', localId: 'med-' + id } }] });
  const r = convert(doc(ms('f1', 'shot.png'), ms('f2', 'gone.png')), {
    resolveMedia: (a) => (a.id === 'f1' ? { path: '_attachments/9/shot.png' } : { expected: '_attachments/9/gone.png' }),
  });
  assert.match(r.body, /^\[adf=med-f1\]\nimage::_attachments\/9\/shot\.png\["shot\.png",width=600,align=center\]$/m);
  assert.match(r.body, /^\/\/ confluence: image not attached to this page: gone\.png\n\[adf=med-f2\]\nimage::_attachments\/9\/gone\.png/m);
  assert.deepStrictEqual(r.report.missingMedia, ['gone.png']);
});

test('an inline image with no attachment gets a placeholder path instead of failing', () => {
  const r = convert(doc(p(t('see '), { type: 'mediaInline', attrs: { id: 'f9', alt: 'icon.png' } })));
  assert.match(r.body, /image:_attachments\/missing\/icon\.png\["icon\.png"\]/);
  assert.deepStrictEqual(r.report.missingMedia, ['icon.png']);
});

test('unknown macros become read-only placeholders and are reported', () => {
  const r = convert(doc({ type: 'extension', attrs: { extensionKey: 'jira', localId: 'ext00001', parameters: { macroMetadata: { title: 'Jira' } } } }));
  assert.match(r.body, /^\[confluence=extension,key=jira,adf=ext00001\]\n\.\.\.\.\nConfluence macro "Jira" \(jira\)\. Edit in Confluence\.\n\.\.\.\.$/m);
  assert.deepStrictEqual(r.report.unsupported, { jira: 1 });
});

test('empty paragraphs are kept; empty documents are detected', () => {
  assert.strictEqual(body(doc(p(t('a')), { type: 'paragraph' })), 'a\n\n{empty}\n');
  assert.strictEqual(isEmptyDoc(doc({ type: 'paragraph' })), true);
  assert.strictEqual(isEmptyDoc(doc(p(t('a')))), false);
});
