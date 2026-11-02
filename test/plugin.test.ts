import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

test('marketplace lists the plugin at a path that exists, under a valid name', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.match(m.name, /^[A-Za-z0-9][\w.-]*$/);
  assert.ok(m.owner && m.owner.name);
  const p = m.plugins.find((x: { name: string }) => x.name === 'adfx');
  assert.ok(p, 'adfx plugin entry');
  assert.match(p.source, /^\.\//);
  assert.ok(fs.existsSync(path.join(root, p.source, '.claude-plugin', 'plugin.json')));
  // a package.json at the plugin root would make Claude Code install dependencies into its cache
  assert.ok(!fs.existsSync(path.join(root, p.source, 'package.json')));
});

test('plugin version, package version and the suggested install tag move together', () => {
  const pkg = json('package.json');
  const plugin = json('plugins/adfx/.claude-plugin/plugin.json');
  assert.strictEqual(plugin.name, 'adfx');
  assert.strictEqual(plugin.version, pkg.version);
  const skills = fs.readdirSync(path.join(root, 'plugins', 'adfx', 'skills')).map((s) => `plugins/adfx/skills/${s}/SKILL.md`);
  for (const rel of [...skills, 'README.md']) {
    for (const m of fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/smorey2\/adfx#v([\w.-]+)/g)) assert.strictEqual(m[1], pkg.version, rel);
  }
});

test('every skill has a description in its frontmatter', () => {
  const dir = path.join(root, 'plugins', 'adfx', 'skills');
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], /^description: \S/m, `${name}: description`);
  }
});
