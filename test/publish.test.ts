import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pull } from '../src/confluence/pull.ts';
import { publish, type PublishOptions } from '../src/confluence/publish.ts';
import { FixtureApi, type FixtureData, type PageUpdate } from '../src/confluence/api.ts';
import type { AdfMark, AdfNode } from '../src/core/adf.ts';
import { scopeOf, quiet, tmp } from './helpers.ts';

// ---------- a synthetic page using most of the ADR-0005 §2 mapping ----------

let n = 0;
const id = () => `id${String(++n).padStart(6, '0')}-0000-0000-0000-000000000000`;
const t = (text: string, marks?: AdfMark[]): AdfNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...c: AdfNode[]): AdfNode => ({ type: 'paragraph', attrs: { localId: id() }, content: c });
const cell = (type: string, c: AdfNode[], extra = {}): AdfNode => ({ type, attrs: { colspan: 1, rowspan: 1, localId: id(), ...extra }, content: c });

function richDoc(): AdfNode {
  n = 0;
  const nested = { type: 'doc', version: 1, content: [{ type: 'table', attrs: { localId: id() }, content: [{ type: 'tableRow', content: [cell('tableCell', [p(t('inner'))])] }] }] };
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'toc', parameters: { macroParams: {} }, localId: id() } },
      { type: 'heading', attrs: { level: 2, localId: id() }, content: [t('Goals')] },
      p(t('Plain, '), t('bold', [{ type: 'strong' }]), t(' and '), t('code_x', [{ type: 'code' }]), t(' see '), t('docs', [{ type: 'link', attrs: { href: 'https://example.com/docs' } }]), t(' '), { type: 'mention', attrs: { id: 'acct-1', localId: id(), text: '@Pat Example' } }, t(' '), { type: 'status', attrs: { text: 'DRAFT', color: 'blue', style: 'bold', localId: id() } }),
      p(t('Commented text', [{ type: 'annotation', attrs: { id: 'comment-1', annotationType: 'inlineComment' } }]), t(' here.')),
      {
        type: 'bulletList',
        attrs: { localId: id() },
        content: [
          { type: 'listItem', attrs: { localId: id() }, content: [p(t('one')), { type: 'orderedList', attrs: { order: 1, localId: id() }, content: [{ type: 'listItem', attrs: { localId: id() }, content: [p(t('one.a'))] }] }] },
          { type: 'listItem', attrs: { localId: id() }, content: [p(t('two'))] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'java', localId: id() }, content: [t('int x = 1;\n')] },
      { type: 'panel', attrs: { panelType: 'warning', localId: id() }, content: [p(t('Careful.'))] },
      {
        type: 'expand',
        attrs: { title: 'Details', localId: id() },
        marks: [{ type: 'breakout', attrs: { mode: 'wide', width: 1200 } }],
        content: [
          {
            type: 'table',
            attrs: { layout: 'default', localId: id() },
            content: [
              { type: 'tableRow', attrs: { localId: id() }, content: [cell('tableHeader', [p(t('Field'))], { colwidth: [120] }), cell('tableHeader', [p(t('Value'))], { colwidth: [200] })] },
              { type: 'tableRow', attrs: { localId: id() }, content: [cell('tableCell', [p(t('Name'))], { colwidth: [120], background: '#f4f5f7' }), cell('tableCell', [p(t('Pat'))], { colwidth: [200] })] },
              {
                type: 'tableRow',
                attrs: { localId: id() },
                content: [
                  cell('tableCell', [p(t('Nested'))], { colwidth: [120], background: '#f4f5f7' }),
                  cell('tableCell', [{ type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.migration', extensionKey: 'nested-table', parameters: { adf: JSON.stringify(nested), cxhtml: '<table/>' } } }], { colwidth: [200] }),
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'bodiedExtension',
        attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'details', parameters: { macroParams: { id: { value: 'x' } } }, localId: id() },
        content: [p(t('Owner: Pat'))],
      },
      { type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'jira', parameters: { macroMetadata: { title: 'Jira' } }, localId: id() } },
      { type: 'mediaSingle', attrs: { layout: 'center', width: 300, widthType: 'pixel' }, content: [{ type: 'media', attrs: { id: 'file-1', type: 'file', collection: 'c', alt: 'shot.png', width: 600, height: 400, localId: id() } }] },
      p(t('See the other page', [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/spaces/DOCS/pages/102/Other' } }])),
    ],
  };
}

function fixture(): FixtureData {
  return {
    spaces: { S1: 'DOCS' },
    content: {
      100: { type: 'page', title: 'ENG', spaceId: 'S1', adf: { type: 'doc', version: 1, content: [] } },
      101: { type: 'page', title: 'ENG: Rich', parentId: '100', spaceId: 'S1', version: 5, adf: richDoc(), attachments: [{ id: 'att1', title: 'shot.png', fileId: 'file-1', fileSize: 3, downloadLink: '/download/attachments/101/shot.png', base64: Buffer.from('png').toString('base64') }] },
      102: { type: 'page', title: 'ENG: Other', parentId: '100', spaceId: 'S1', version: 1, adf: { type: 'doc', version: 1, content: [p(t('other page'))] } },
      900: { type: 'page', title: 'Other team', spaceId: 'S1', adf: { type: 'doc', version: 1, content: [p(t('not ours'))] } },
    },
  };
}

const scope = scopeOf('site: x.atlassian.net\nroots:\n  - id: "100"\n    type: page\nexclude: []\n');
const RICH = 'DOCS/eng/eng-rich.adoc';

async function setup() {
  const out = tmp('adfx-publish-');
  const data = fixture();
  await pull({ api: new FixtureApi(data), scope, outDir: out, log: quiet });
  const file = path.join(out, RICH);
  const edit = (from: string, to: string) => {
    const s = fs.readFileSync(file, 'utf8');
    assert.ok(s.includes(from), `fixture file contains ${JSON.stringify(from)}`);
    fs.writeFileSync(file, s.replace(from, to));
  };
  // a write that applies the page update to the fixture, like Confluence would
  const writes: PageUpdate[] = [];
  const write = async (a: PageUpdate) => {
    writes.push(a);
    Object.assign(data.content[a.id], { adf: a.adf, version: a.version, title: a.title });
    return { version: { number: a.version } };
  };
  const run = async (opts: Partial<PublishOptions> = {}) => {
    const logs: string[] = [];
    const r = await publish({ api: new FixtureApi(data), scope, outDir: out, write, log: (l) => logs.push(l), ...opts });
    return Object.assign(r, { logs: logs.join('\n') });
  };
  return { out, data, file, edit, writes, run };
}

const strip = (doc: AdfNode, i: number): AdfNode => ({ ...doc, content: doc.content!.filter((_, k) => k !== i) });

test('every block of the synthetic page reads back exactly (fidelity gate)', async () => {
  const s = await setup();
  const r = await s.run({ check: true });
  const rich = r.find((x) => x.rel === RICH)!;
  assert.strictEqual(rich.status, 'ok', rich.errors.join('\n'));
  assert.match(r.logs, /blocks can be rebuilt exactly/);
});

test('nothing to publish when no file was edited', async () => {
  const s = await setup();
  const r = await s.run({ apply: true });
  assert.strictEqual(r.length, 0);
  assert.strictEqual(s.writes.length, 0);
});

test('dry run shows the change and writes nothing; apply sends only that change and re-pulls', async () => {
  const s = await setup();
  const before = JSON.parse(JSON.stringify(s.data.content[101].adf));
  s.edit('Careful.', 'Be careful.');
  let r = await s.run();
  assert.strictEqual(r[0].status, 'ready');
  assert.match(r.logs, /- Careful\.\n.*\+ Be careful\./);
  assert.match(r.logs, /panel\[7\] › paragraph\[1\] › text\[1\] text: "Careful\." -> "Be careful\."/);
  assert.match(r.logs, /dry run/);
  assert.strictEqual(s.writes.length, 0);

  r = await s.run({ apply: true, message: 'test edit' });
  assert.strictEqual(r[0].status, 'published');
  assert.strictEqual(s.writes.length, 1);
  const w = s.writes[0];
  assert.deepStrictEqual([w.id, w.version, w.message, w.title], ['101', 6, 'test edit', 'ENG: Rich']);
  // every other block is the live block, unchanged
  assert.deepStrictEqual(strip(w.adf, 6), strip(before, 6));
  assert.deepStrictEqual(w.adf.content![6], { ...before.content[6], content: [{ ...before.content[6].content[0], content: [t('Be careful.')] }] });
  // the file was re-pulled at the new version and is clean
  const after = fs.readFileSync(s.file, 'utf8');
  assert.match(after, /:confluence-version: 6\n/);
  r = await s.run();
  assert.strictEqual(r.length, 0);
});

test('table edits keep cell colours, widths and IDs; new rows get the column widths', async () => {
  const s = await setup();
  const before = s.data.content[101].adf!.content![7];
  s.edit('|Name\n|Pat\n', '|Name\n|Pat Q\n\n|Role\n|Owner\n');
  const r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'published', r.logs);
  const table = s.writes[0].adf.content![7].content![0];
  const bt = before.content![0];
  assert.deepStrictEqual(table.content![1].content![0], bt.content![1].content![0]); // "Name" cell untouched
  assert.strictEqual(table.content![1].content![1].content![0].content![0].text, 'Pat Q');
  assert.strictEqual(table.content![1].content![1].attrs!.localId, bt.content![1].content![1].attrs!.localId);
  assert.deepStrictEqual(
    table.content![2].content!.map((c) => c.attrs),
    [
      { colspan: 1, rowspan: 1, colwidth: [120] },
      { colspan: 1, rowspan: 1, colwidth: [200] },
    ],
  );
  assert.deepStrictEqual(table.content![3], bt.content![2]); // row with the nested table
  assert.deepStrictEqual(s.writes[0].adf.content![7].marks, before.marks); // expand width kept
});

test('refuses edits AsciiDoc cannot carry back', async () => {
  const cases: [string, (s: Awaited<ReturnType<typeof setup>>) => void, RegExp][] = [
    ['nested table', (s) => s.edit('!inner', '!changed'), /nested table was edited/],
    ['new image', (s) => s.edit('image::_attachments/101/shot.png', 'image::_attachments/101/other.png'), /new image/],
    ['new mention', (s) => s.edit('[.mention]##@Pat Example##', '[.mention]##@Someone Else##'), /mention "@Someone Else"/],
    ['new macro', (s) => s.edit('== Goals\n', '== Goals\n\ntoc::[]\n'), /new "toc" macro/],
    ['macro placeholder', (s) => s.edit('[confluence=extension,key=jira,', '[confluence=extension,key=jira-x,'), /placeholder|macros can only be added/],
  ];
  for (const [name, edit, why] of cases) {
    const s = await setup();
    edit(s);
    const r = await s.run({ apply: true });
    assert.strictEqual(r[0].status, 'refused', `${name}: ${r.logs}`);
    assert.match(r.logs, why, name);
    assert.strictEqual(s.writes.length, 0, name);
  }
});

test('refuses when Confluence changed since the pull, and pages out of scope', async () => {
  const s = await setup();
  s.edit('Careful.', 'Be careful.');
  s.data.content[101].version = 9;
  let r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'conflict');
  assert.match(r.logs, /v5 -> v9/);

  const stray = path.join(s.out, 'DOCS/eng/stray.adoc');
  fs.writeFileSync(stray, fs.readFileSync(path.join(s.out, 'DOCS/eng/eng-other.adoc'), 'utf8').replace(':confluence-id: 102', ':confluence-id: 900'));
  r = await s.run({ apply: true, files: [stray] });
  assert.strictEqual(r[0].status, 'refused');
  assert.match(r.logs, /not in scope/);
  assert.strictEqual(s.writes.length, 0);
});

test('editing commented text needs --accept-loss; a title change alone is published', async () => {
  const s = await setup();
  s.edit('Commented text here.', 'Edited text here.');
  let r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'needs --accept-loss');
  assert.match(r.logs, /will be lost: inline comment on "Commented text"/);
  assert.strictEqual(s.writes.length, 0);
  r = await s.run({ apply: true, acceptLoss: true });
  assert.strictEqual(r[0].status, 'published');

  const t2 = await setup();
  t2.edit('= ENG: Rich\n', '= ENG: Rich page\n');
  r = await t2.run({ apply: true });
  assert.strictEqual(r[0].status, 'published', r.logs);
  assert.strictEqual(t2.writes[0].title, 'ENG: Rich page');
  assert.deepStrictEqual(t2.writes[0].adf, fixture().content[101].adf);
});

test('new blocks typed by hand, including constrained formatting', async () => {
  const s = await setup();
  s.edit('== Goals\n', '== Goals\n\nA *new* paragraph with _style_ and `code`.\n\n* first\n* second\n');
  const r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'published', r.logs);
  const c = s.writes[0].adf.content!;
  assert.deepStrictEqual(c[2], { type: 'paragraph', content: [t('A '), t('new', [{ type: 'strong' }]), t(' paragraph with '), t('style', [{ type: 'em' }]), t(' and '), t('code', [{ type: 'code' }]), t('.')] });
  assert.deepStrictEqual(c[3], { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('first')] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [t('second')] }] }] });
  assert.strictEqual(c.length, fixture().content[101].adf!.content!.length + 2);
});
