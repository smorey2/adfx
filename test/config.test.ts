import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../src/core/yaml.ts';
import { parseConfluenceConfig, loadConfluenceConfig } from '../src/confluence/config.ts';
import { tmp } from './helpers.ts';

test('yaml: maps, lists of maps, quotes, flow lists, comments; every scalar is a string', () => {
  const doc = parseYaml(
    [
      '# comment',
      'site: example.atlassian.net   # trailing comment',
      'roots:',
      '  - id: "0012"',
      '    title: \'Sky\'\'s "notes" # not a comment\'',
      '  - 345',
      'list:',
      '- a',
      '- b',
      'flow: [x, "y, z", 3]',
      'empty: []',
      'none:',
      'nested:',
      '  deeper:',
      '    key: value',
    ].join('\n'),
  );
  assert.deepStrictEqual(doc, {
    site: 'example.atlassian.net',
    roots: [{ id: '0012', title: 'Sky\'s "notes" # not a comment' }, '345'],
    list: ['a', 'b'],
    flow: ['x', 'y, z', '3'],
    empty: [],
    none: null,
    nested: { deeper: { key: 'value' } },
  });
});

test('yaml: anything outside the subset is an error with a line number', () => {
  assert.throws(() => parseYaml('a: 1\n\tb: 2'), /line 2: tabs/);
  assert.throws(() => parseYaml('a: &x 1'), /line 1: anchors/);
  assert.throws(() => parseYaml('a: |\n  text'), /line 1: block scalars/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /line 2: duplicate key "a"/);
  assert.throws(() => parseYaml('a: b: c'), /line 1: quote this value/);
  assert.throws(() => parseYaml('a: 1\n    b: 2'), /line 2: unexpected indentation/);
  assert.throws(() => parseYaml('---\na: 1'), /one document/);
});

const minimal = 'site: x.atlassian.net\nroots:\n  - id: "100"\n';

test('confluence.yaml: defaults, paths relative to the file, wording and templates', () => {
  const root = tmp();
  const c = parseConfluenceConfig(
    minimal + 'main:\n  wording:\n    - Spell out contractions; "cannot" is one word.\ntemplates:\n  job: docs/confluence/_templates/job.adoc\n',
    { root },
  );
  assert.strictEqual(c.out, path.join(root, 'docs', 'confluence'));
  assert.strictEqual(c.message, 'Published with adf-bridge');
  assert.deepStrictEqual(c.roots, [{ id: '100', type: 'page' }]);
  assert.deepStrictEqual(c.exclude, []);
  assert.deepStrictEqual(c.main.wording, ['Spell out contractions; "cannot" is one word.']);
  assert.strictEqual(c.templates.job, path.join(root, 'docs', 'confluence', '_templates', 'job.adoc'));
});

test('confluence.yaml: typos and bad values fail loudly', () => {
  assert.throws(() => parseConfluenceConfig(minimal + 'space: DOCS\n'), /unknown key "space"/);
  assert.throws(() => parseConfluenceConfig('site: x.atlassian.net\nroots:\n  - id: "abc"\n'), /invalid id "abc"/);
  assert.throws(() => parseConfluenceConfig('site: example.com\nroots:\n  - id: "1"\n'), /site must be/);
  assert.throws(() => parseConfluenceConfig('site: x.atlassian.net\nroots: []\n'), /no roots/);
  assert.throws(() => parseConfluenceConfig(minimal + 'exclude:\n  - id: "2"\n    reason: x\n'), /unknown key "reason" in exclude\[1\]/);
  assert.throws(() => parseConfluenceConfig(minimal + 'main:\n  rules: []\n'), /unknown key "main.rules"/);
  assert.throws(() => parseConfluenceConfig('site: x.atlassian.net\nroots:\n  - id: "1"\n    type: space\n'), /type must be page or folder/);
});

test('confluence.yaml is found in a parent folder, and the project root is its folder', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'confluence.yaml'), minimal + 'out: mirror\n');
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const c = loadConfluenceConfig({ start: deep });
  assert.strictEqual(c.root, root);
  assert.strictEqual(c.out, path.join(root, 'mirror'));
  assert.throws(() => loadConfluenceConfig({ start: tmp() }), /no confluence.yaml/);
});
