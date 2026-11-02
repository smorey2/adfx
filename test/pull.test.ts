import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pull } from '../src/confluence/pull.ts';
import { FixtureApi, type FixtureData } from '../src/confluence/api.ts';
import * as header from '../src/core/header.ts';
import type { AdfNode } from '../src/core/adf.ts';
import { scopeOf, quiet, tmp } from './helpers.ts';

const p = (text: string, extra = {}): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text, ...extra }] });
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content });

function fixture(): FixtureData {
  return {
    spaces: { S1: 'DOCS' },
    content: {
      100: { type: 'page', title: 'OPS', spaceId: 'S1', adf: doc() },
      101: { type: 'page', title: 'OPS: Returns', parentId: '100', spaceId: 'S1', version: 3, adf: doc(p('see shipments', { marks: [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/spaces/DOCS/pages/103/Shipments#Stuck' } }] })) },
      102: { type: 'folder', title: 'Data', parentId: '100', spaceId: 'S1' },
      103: { type: 'page', title: 'Shipments', parentId: '102', spaceId: 'S1', version: 1, adf: doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'file-1', alt: 'shot 1.png', type: 'file' } }] }), attachments: [{ id: 'att1', title: 'shot 1.png', fileId: 'file-1', fileSize: 3, downloadLink: '/download/attachments/103/shot%201.png', base64: Buffer.from('png').toString('base64') }] },
      104: { type: 'page', title: 'Private', parentId: '100', spaceId: 'S1', adf: doc(p('secret')) },
      900: { type: 'page', title: 'Other team', spaceId: 'S1', adf: doc(p('not ours')) },
    },
  };
}

const config = 'site: x.atlassian.net\nroots:\n  - id: "100"\n    title: "OPS"\n    type: page   # page | folder\nexclude:\n  - id: "104"\n';
const scope = () => scopeOf(config);

test('pulls in-scope pages, skips empty roots and excluded pages, downloads images, links across files', async () => {
  const out = tmp();
  const api = new FixtureApi(fixture());
  const r = await pull({ api, scope: scope(), outDir: out, log: quiet });
  assert.deepStrictEqual(r.written.sort(), ['DOCS/ops/data/shipments.adoc', 'DOCS/ops/ops-returns.adoc']);
  assert.ok(!fs.existsSync(path.join(out, 'DOCS/ops/index.adoc')), 'empty root is a container');
  assert.ok(!fs.existsSync(path.join(out, 'DOCS/ops/private.adoc')), 'excluded page not written');
  assert.deepStrictEqual(r.excluded, ['104 "Private"']);
  const returns = fs.readFileSync(path.join(out, 'DOCS/ops/ops-returns.adoc'), 'utf8');
  assert.match(returns, /^= OPS: Returns\n:confluence-id: 101\n:confluence-space: DOCS\n:confluence-version: 3\n/);
  assert.match(returns, /xref:data\/shipments\.adoc#Stuck\[see shipments\]/);
  const ship = fs.readFileSync(path.join(out, 'DOCS/ops/data/shipments.adoc'), 'utf8');
  assert.match(ship, /image::_attachments\/103\/shot_1\.png\["shot 1\.png"\]/);
  assert.strictEqual(fs.readFileSync(path.join(out, 'DOCS/ops/data/_attachments/103/shot_1.png'), 'utf8'), 'png');
  assert.ok(!api.calls.some(([k, id]) => k === 'page' && id === '900'), 'never fetches out-of-scope pages');
});

test('second pull is a no-op; local edits are kept; local edits plus a new version is a conflict', async () => {
  const out = tmp();
  const data = fixture();
  await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });

  let r = await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  assert.deepStrictEqual(r.written, []);
  assert.strictEqual(r.upToDate.length, 2);

  const file = path.join(out, 'DOCS/ops/ops-returns.adoc');
  fs.appendFileSync(file, '\nlocal edit\n');
  r = await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet, force: true });
  assert.deepStrictEqual(r.localEdits, ['DOCS/ops/ops-returns.adoc']);
  assert.match(fs.readFileSync(file, 'utf8'), /local edit/);

  data.content[101].version = 4;
  r = await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  assert.strictEqual(r.conflicts.length, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /local edit/);
});

test('a file checked out with Windows line endings is not treated as edited', async () => {
  const out = tmp();
  const data = fixture();
  await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  const file = path.join(out, 'DOCS/ops/ops-returns.adoc');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  const r = await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  assert.deepStrictEqual(r.localEdits, []);
  assert.strictEqual(r.upToDate.length, 2);
});

test('new Confluence version rewrites the file and its sync hash', async () => {
  const out = tmp();
  const data = fixture();
  await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  data.content[101].version = 4;
  data.content[101].adf = doc(p('changed'));
  const r = await pull({ api: new FixtureApi(data), scope: scope(), outDir: out, log: quiet });
  assert.deepStrictEqual(r.written, ['DOCS/ops/ops-returns.adoc']);
  const h = header.parse(fs.readFileSync(path.join(out, 'DOCS/ops/ops-returns.adoc'), 'utf8'))!;
  assert.strictEqual(h.attrs['confluence-version'], '4');
  assert.strictEqual(h.attrs['confluence-sync-hash'], header.hash(h.body));
});

test('scope cross-check mismatch aborts before writing', async () => {
  const out = tmp();
  const api = new FixtureApi(fixture());
  api.cql = async () => [{ id: '101', type: 'page', title: 'OPS: Returns' }];
  await assert.rejects(pull({ api, scope: scope(), outDir: out, log: quiet }), /scope cross-check failed/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test('--page outside scope is refused', async () => {
  await assert.rejects(pull({ api: new FixtureApi(fixture()), scope: scope(), outDir: tmp(), only: ['900'], log: quiet }), /not in scope/);
});

test('dry run writes nothing', async () => {
  const out = tmp();
  const r = await pull({ api: new FixtureApi(fixture()), scope: scope(), outDir: out, dryRun: true, log: quiet });
  assert.strictEqual(r.written.length, 2);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});
