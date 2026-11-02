import test from 'node:test';
import assert from 'node:assert';
import { replaceInCells, replaceText } from '../src/confluence/replace.ts';
import { FixtureApi, type PageUpdate } from '../src/confluence/api.ts';
import type { AdfMark, AdfNode } from '../src/core/adf.ts';
import { scopeOf } from './helpers.ts';

const t = (text: string, marks?: AdfMark[]): AdfNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...c: AdfNode[]): AdfNode => ({ type: 'paragraph', content: c });
const cell = (...c: AdfNode[]): AdfNode => ({ type: 'tableCell', attrs: {}, content: c });
const row = (...c: AdfNode[]): AdfNode => ({ type: 'tableRow', content: c });
const at = (n: AdfNode, ...path: number[]): AdfNode => path.reduce((x, i) => x.content![i], n);

function page(): AdfNode {
  const nested = { type: 'doc', content: [{ type: 'table', content: [row(cell(p(t('Jane Q'))))] }] };
  return {
    type: 'doc',
    version: 1,
    content: [
      p(t('Jane Q wrote this outside a table')),
      {
        type: 'table',
        content: [
          row(cell(p(t('Name'))), cell(p(t(' Jane Q ', [{ type: 'annotation', attrs: { id: 'c1', annotationType: 'inlineComment' } }])))),
          row(cell(p(t('Code'))), cell(p(t('FLS')))),
          row(cell(p(t('State'))), cell(p(t('FL')))),
          row(cell({ type: 'extension', attrs: { extensionKey: 'nested-table', parameters: { adf: JSON.stringify(nested) } } })),
        ],
      },
    ],
  };
}

test('replaces whole cell values only, keeps marks and surrounding spaces, reaches nested tables', () => {
  const res = replaceInCells(page(), { 'Jane Q': 'John Doe', FL: 'XX' });
  assert.deepStrictEqual(res.counts, { 'Jane Q': 2, FL: 1 });
  const cellText = at(res.adf, 1, 0, 1, 0, 0);
  assert.strictEqual(cellText.text, ' John Doe ');
  assert.strictEqual(cellText.marks![0].type, 'annotation');
  assert.strictEqual(at(res.adf, 1, 1, 1, 0, 0).text, 'FLS');
  assert.match(at(res.adf, 1, 3, 0, 0).attrs!.parameters.adf, /John Doe/);
  assert.strictEqual(at(res.adf, 0, 0).text, 'Jane Q wrote this outside a table');
  assert.deepStrictEqual(res.leftovers, { 'Jane Q': 1, FL: 1 }); // paragraph text and "FLS"
  assert.match(res.changes[0].row, /Name \| Jane Q/);
});

test('updates the link target of a replaced value (auto-linked email)', () => {
  const adf: AdfNode = { type: 'doc', content: [{ type: 'table', content: [row(cell(p(t('a@real.com', [{ type: 'link', attrs: { href: 'mailto:a@real.com' } }]))))] }] };
  const res = replaceInCells(adf, { 'a@real.com': 'a@example.com' });
  assert.deepStrictEqual(at(res.adf, 0, 0, 0, 0, 0).marks![0].attrs!.href, 'mailto:a@example.com');
  assert.deepStrictEqual(res.leftovers, {});
});

const scope = scopeOf('site: x.atlassian.net\nroots:\n  - id: "100"\nexclude:\n  - id: "102"\n');
const fixture = () =>
  new FixtureApi({
    spaces: { S1: 'DOCS' },
    content: {
      100: { type: 'page', title: 'Root', spaceId: 'S1' },
      101: { type: 'page', title: 'Form', parentId: '100', spaceId: 'S1', version: 7, adf: page() },
      102: { type: 'page', title: 'Hidden', parentId: '100', spaceId: 'S1', adf: page() },
      900: { type: 'page', title: 'Other team', spaceId: 'S1', adf: page() },
    },
  });

test('dry run never writes; apply writes version + 1 with the replaced ADF', async () => {
  const writes: PageUpdate[] = [];
  const write = async (args: PageUpdate) => (writes.push(args), { version: { number: args.version } });
  const map = { message: 'fake data', pages: { 101: { 'Jane Q': 'John Doe' } } };
  await replaceText({ api: fixture(), scope, map, write, log: () => {} });
  assert.strictEqual(writes.length, 0);
  const [r] = await replaceText({ api: fixture(), scope, map, apply: true, write, log: () => {} });
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].version, 8);
  assert.strictEqual(writes[0].message, 'fake data');
  assert.match(JSON.stringify(writes[0].adf), /John Doe/);
  assert.deepStrictEqual([r.written, r.newVersion], [true, 8]);
});

test('refuses out-of-scope and excluded pages, and chained mappings', async () => {
  const write = async () => assert.fail('must not write');
  await assert.rejects(replaceText({ api: fixture(), scope, map: { pages: { 900: { a: 'b' } } }, apply: true, write, log: () => {} }), /not in scope/);
  await assert.rejects(replaceText({ api: fixture(), scope, map: { pages: { 102: { a: 'b' } } }, apply: true, write, log: () => {} }), /excluded/);
  await assert.rejects(replaceText({ api: fixture(), scope, map: { pages: { 101: { a: 'b', b: 'c' } } }, apply: true, write, log: () => {} }), /itself replaced/);
});
