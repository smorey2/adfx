import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pull } from '../src/confluence/pull.ts';
import { publish } from '../src/confluence/publish.ts';
import { newPage } from '../src/confluence/new.ts';
import { FixtureApi, type FixtureData, type NewPage } from '../src/confluence/api.ts';
import { parseConfluenceConfig } from '../src/confluence/config.ts';
import * as header from '../src/core/header.ts';
import { quiet, tmp } from './helpers.ts';

const TEMPLATE = ['= Template title (ignored)', ':confluence-heading-offset: 1', '', 'toc::[]', '', '== Overview', '', 'Write the overview here.', '', '[NOTE,panel=info]', '====', 'Keep it short.', '====', ''].join('\n');

function fixture(): FixtureData {
  return {
    spaces: { S1: 'DOCS' },
    content: {
      100: { type: 'page', title: 'ENG', spaceId: 'S1', adf: { type: 'doc', version: 1, content: [] } },
      101: { type: 'page', title: 'ENG: Jobs', parentId: '100', spaceId: 'S1', version: 2, adf: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'jobs' }] }] } },
      900: { type: 'page', title: 'Other team', spaceId: 'S1' },
    },
  };
}

async function setup() {
  const root = tmp('adf-bridge-new-');
  fs.mkdirSync(path.join(root, 'docs', 'confluence', '_templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'confluence', '_templates', 'process.adoc'), TEMPLATE);
  const config = parseConfluenceConfig('site: x.atlassian.net\nroots:\n  - id: "100"\ntemplates:\n  process: docs/confluence/_templates/process.adoc\n', { root });
  const data = fixture();
  await pull({ api: new FixtureApi(data), scope: config, outDir: config.out, log: quiet });
  const created: NewPage[] = [];
  // creates the page in the fixture, as Confluence would
  const create = async (p: NewPage) => {
    created.push(p);
    data.content['555'] = { type: 'page', title: p.title, parentId: p.parentId, spaceId: p.spaceId, version: 1, adf: p.adf };
    return { id: '555', version: { number: 1 } };
  };
  const run = async (opts: { apply?: boolean; files?: string[] } = {}) => {
    const logs: string[] = [];
    const r = await publish({ api: new FixtureApi(data), scope: config, outDir: config.out, create, log: (l) => logs.push(l), ...opts });
    return Object.assign(r, { logs: logs.join('\n') });
  };
  const draft = () => newPage({ api: new FixtureApi(data), config, outDir: config.out, title: 'ENG: Release Notes', parentId: '100', template: 'process', log: quiet });
  return { config, data, created, run, draft };
}

test('new writes a draft from the template, under its parent, with no page id', async () => {
  const s = await setup();
  const file = await s.draft();
  assert.strictEqual(path.relative(s.config.out, file).split(path.sep).join('/'), 'DOCS/eng/eng-release-notes.adoc');
  const h = header.parse(fs.readFileSync(file, 'utf8'))!;
  assert.strictEqual(h.title, 'ENG: Release Notes');
  assert.deepStrictEqual(h.attrs, { 'confluence-parent': '100', 'confluence-space': 'DOCS', 'scope-root': '100', 'confluence-heading-offset': '1', toc: 'macro' });
  assert.match(h.body, /^toc::\[\]\n\n== Overview\n/);
});

test('the first push creates the page, then the file becomes a normal clean mirror file', async () => {
  const s = await setup();
  const file = await s.draft();
  let r = await s.run();
  assert.strictEqual(r[0].status, 'ready', r.logs);
  assert.match(r.logs, /create "ENG: Release Notes" under "ENG" \(4 blocks\)/);
  assert.strictEqual(s.created.length, 0);

  r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'created', r.logs);
  const c = s.created[0];
  assert.deepStrictEqual([c.spaceId, c.parentId, c.title], ['S1', '100', 'ENG: Release Notes']);
  assert.deepStrictEqual(
    c.adf.content!.map((n) => n.type),
    ['extension', 'heading', 'paragraph', 'panel'],
  );
  assert.strictEqual(c.adf.content![0].attrs!.extensionKey, 'toc');
  assert.strictEqual(c.adf.content![1].attrs!.level, 2); // heading offset applied

  const h = header.parse(fs.readFileSync(file, 'utf8'))!;
  assert.strictEqual(h.attrs['confluence-id'], '555');
  assert.strictEqual(h.attrs['confluence-version'], '1');
  assert.strictEqual(h.attrs['confluence-sync-hash'], header.hash(h.body));
  assert.ok(!h.attrs['confluence-parent']);

  r = await s.run({ apply: true });
  assert.strictEqual(r.length, 0, 'nothing left to push; no duplicate page');
});

test('new refuses an unknown template, a title already under the parent, and parents out of scope', async () => {
  const s = await setup();
  const make = (title: string, parentId: string, template?: string) => newPage({ api: new FixtureApi(s.data), config: s.config, outDir: s.config.out, title, parentId, template, log: quiet });
  await assert.rejects(make('X', '100', 'nope'), /no template "nope".*templates: process/);
  await assert.rejects(make('ENG: Jobs', '100'), /already exists under that parent \(page 101\)/);
  await assert.rejects(make('X', '900'), /not in scope/);
});

test('a new page can include a table of contents, but not other macros', async () => {
  const s = await setup();
  const file = await s.draft();
  fs.appendFileSync(file, '\n[confluence=details]\n--\nOwner: Pat\n--\n');
  const r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'refused', r.logs);
  assert.match(r.logs, /new "details" macro: a new page can only include toc/);
  assert.strictEqual(s.created.length, 0);
});

test('a draft whose title was taken in Confluence meanwhile is refused', async () => {
  const s = await setup();
  await s.draft();
  s.data.content['600'] = { type: 'page', title: 'ENG: Release Notes', parentId: '100', spaceId: 'S1', version: 1 };
  const r = await s.run({ apply: true });
  assert.strictEqual(r[0].status, 'refused');
  assert.match(r.logs, /already exists under that parent \(page 600\)/);
});
