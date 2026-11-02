import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, pageIdOf } from '../src/cli.ts';
import { configDir, resolveCredentials, saveCredentials, removeCredentials, credentialsFile } from '../src/core/credentials.ts';
import { tmp } from './helpers.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'adf-bridge.js');

test('args: flags, values, repeats, positionals', () => {
  const a = parseArgs(['confluence', 'push', 'a.adoc', '--page', '1', '--page=2', '--apply', '-h']);
  assert.deepStrictEqual(a._, ['confluence', 'push', 'a.adoc']);
  assert.deepStrictEqual(a.flags, { page: ['1', '2'], apply: ['true'], help: ['true'] });
  assert.throws(() => parseArgs(['--message']), /needs a value/);
  assert.throws(() => parseArgs(['-x']), /unknown option -x/);
});

test('page ids from ids and Confluence URLs', () => {
  assert.strictEqual(pageIdOf('123456789'), '123456789');
  assert.strictEqual(pageIdOf('https://x.atlassian.net/wiki/spaces/DOCS/pages/123456789/Release+Notes'), '123456789');
  assert.strictEqual(pageIdOf('https://x.atlassian.net/wiki/pages/viewpage.action?pageId=42'), '42');
  assert.throws(() => pageIdOf('not-a-page'), /not a page id/);
});

test('credentials: env vars first, then the site entry, then the default; file outside the repo', () => {
  const dir = tmp();
  const env = { ADF_BRIDGE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  assert.strictEqual(resolveCredentials('a.atlassian.net', env), null);
  saveCredentials(null, { email: 'any@example.com', token: 't0' }, env);
  saveCredentials('a.atlassian.net', { email: 'a@example.com', token: 't1' }, env);
  assert.strictEqual(resolveCredentials('a.atlassian.net', env)!.email, 'a@example.com');
  assert.strictEqual(resolveCredentials('b.atlassian.net', env)!.email, 'any@example.com');
  assert.strictEqual(resolveCredentials('a.atlassian.net', { ...env, ATLASSIAN_EMAIL: 'ci@example.com', ATLASSIAN_API_TOKEN: 'x' })!.source, 'ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(credentialsFile(env)).mode & 0o777, 0o600);
  assert.ok(removeCredentials('a.atlassian.net', env));
  assert.strictEqual(resolveCredentials('a.atlassian.net', env)!.email, 'any@example.com');
});

test('config folder per OS', () => {
  assert.strictEqual(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\u\\AppData\\Roaming', 'adf-bridge'));
  assert.strictEqual(configDir({ XDG_CONFIG_HOME: '/home/u/.config' }, 'linux'), path.join('/home/u/.config', 'adf-bridge'));
});

test('init writes confluence.yaml and .gitattributes from a page URL; refuses to overwrite', () => {
  const dir = tmp();
  const env = { ...process.env, ADF_BRIDGE_CONFIG_DIR: tmp(), ATLASSIAN_EMAIL: '', ATLASSIAN_API_TOKEN: '', CONFLUENCE_EMAIL: '', CONFLUENCE_API_TOKEN: '' };
  const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8' });
  const out = run('init', '--root', 'https://example.atlassian.net/wiki/spaces/DOCS/pages/12345/Handbook');
  assert.match(out, /wrote confluence.yaml \(site example.atlassian.net, 1 root\)/);
  assert.match(out, /adf-bridge login/);
  const yaml = fs.readFileSync(path.join(dir, 'confluence.yaml'), 'utf8');
  assert.match(yaml, /^site: example.atlassian.net$/m);
  assert.match(yaml, /^ {2}- id: "12345"$/m);
  assert.match(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), /^\*\.adoc text eol=lf$/m);
  assert.throws(() => run('init', '--root', '1', '--site', 'example.atlassian.net'), /already exists/);
});

test('version and help', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }), /adf-bridge confluence push/);
});
