// adf-bridge command line. Run "adf-bridge help" for usage.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfluenceApi, FixtureApi, pageWriter, type ConfluenceReader, type PageWriter } from './confluence/api.ts';
import { CONFIG_NAMES, loadConfluenceConfig, type ConfluenceConfig } from './confluence/config.ts';
import { pull } from './confluence/pull.ts';
import { publish } from './confluence/publish.ts';
import { replaceText } from './confluence/replace.ts';
import { credentialsFile, removeCredentials, requireCredentials, resolveCredentials, saveCredentials } from './core/credentials.ts';
import { findUp } from './core/files.ts';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const HELP = `adf-bridge: sync Confluence (and soon Jira) with git, as AsciiDoc.

Setup
  adf-bridge init [--root <page URL or id>]... [--site <name>.atlassian.net] [--out <dir>] [--force]
      Write confluence.yaml in this folder and make .adoc files use LF line endings.
  adf-bridge login [--site <site>] [--email <email>] [--token-stdin] [--no-verify]
      Save your Atlassian email and API token for this user (never in the repo).
      Create a token at ${TOKEN_URL}
  adf-bridge logout [--site <site>]
  adf-bridge whoami
      Show which account and credential source would be used (never the token).

Confluence
  adf-bridge confluence pull [--dry-run] [--page <id or URL>]... [--force]
      Pull in-scope pages into the mirror. Never overwrites a file with local edits.
  adf-bridge confluence push [files...] [--page <id or URL>]... [--apply] [--accept-loss] [--message <text>]
      Show what would change on Confluence (dry run). Add --apply to write.
  adf-bridge confluence check [files...] [--page <id or URL>]...
      Can each block be rebuilt exactly? Blocks that cannot are pull-only.
  adf-bridge confluence replace --map <file.json> [--apply]
      Replace exact table-cell values (e.g. real example data with fake data).

Options for every command
  --config <file>     use this confluence.yaml (default: the nearest one in this folder or above)
  --fixtures <file>   read Confluence from a JSON fixture instead of the API (no writes)
  --out <dir>         mirror folder (default: "out" in confluence.yaml, else docs/confluence)
  -h, --help          show this help
  -v, --version       show the version`;

interface Args {
  _: string[];
  flags: Record<string, string[]>;
}

const BOOLEAN = new Set(['dry-run', 'force', 'apply', 'accept-loss', 'token-stdin', 'no-verify', 'help', 'version']);
const ALIAS: Record<string, string> = { h: 'help', v: 'version' };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m || /^-\d/.test(a)) {
      out._.push(a);
      continue;
    }
    const name = ALIAS[m[1]] || m[1];
    if (a.startsWith('-') && !a.startsWith('--') && !ALIAS[m[1]]) throw new Error(`unknown option ${a}`);
    let value: string;
    if (BOOLEAN.has(name)) value = 'true';
    else if (m[2] !== undefined) value = m[2];
    else {
      if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`);
      value = argv[++i];
    }
    (out.flags[name] ||= []).push(value);
  }
  return out;
}

function only(args: Args, allowed: string[]): void {
  for (const k of Object.keys(args.flags)) if (!allowed.includes(k)) throw new Error(`unknown option --${k}`);
}

const flag = (args: Args, name: string) => Boolean(args.flags[name]);
const value = (args: Args, name: string) => (args.flags[name] ? args.flags[name][args.flags[name].length - 1] : undefined);
const values = (args: Args, name: string) => args.flags[name] || [];

// "12345", ".../pages/12345/Title", "...viewpage.action?pageId=12345" -> "12345"
export function pageIdOf(s: string): string {
  if (/^\d+$/.test(s)) return s;
  const m = /\/pages\/(\d+)|[?&]pageId=(\d+)/.exec(s);
  if (!m) throw new Error(`not a page id or Confluence page URL: ${s}`);
  return m[1] || m[2];
}

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return pkg.version;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (flag(args, 'version')) {
    console.log(version());
    return 0;
  }
  const [cmd, sub, ...rest] = args._;
  if (!cmd || cmd === 'help' || flag(args, 'help')) {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case 'init':
      return init(args);
    case 'login':
      return login(args);
    case 'logout':
      return logout(args);
    case 'whoami':
      return whoami(args);
    case 'confluence':
      return confluence(sub, { ...args, _: rest });
    default:
      throw new Error(`unknown command "${cmd}"; run "adf-bridge help"`);
  }
}

// ---------- confluence ----------

async function confluence(sub: string | undefined, args: Args): Promise<number> {
  const common = ['config', 'fixtures', 'out'];
  const cfg = loadConfluenceConfig({ explicit: value(args, 'config') });
  const outDir = value(args, 'out') ? path.resolve(value(args, 'out')!) : cfg.out;
  const pages = values(args, 'page').map(pageIdOf);
  switch (sub) {
    case 'pull': {
      only(args, [...common, 'dry-run', 'page', 'force']);
      if (args._.length) throw new Error(`unexpected argument "${args._[0]}"`);
      const report = await pull({ api: reader(cfg, args), scope: cfg, outDir, dryRun: flag(args, 'dry-run'), force: flag(args, 'force'), only: pages });
      return report.conflicts.length ? 2 : 0;
    }
    case 'push':
    case 'publish':
    case 'check': {
      const check = sub === 'check';
      only(args, check ? [...common, 'page'] : [...common, 'page', 'apply', 'accept-loss', 'message']);
      const apply = flag(args, 'apply');
      if (apply && value(args, 'fixtures')) throw new Error('--apply is not allowed with --fixtures');
      const results = await publish({
        api: reader(cfg, args),
        scope: cfg,
        outDir,
        files: args._,
        pages,
        apply,
        acceptLoss: flag(args, 'accept-loss'),
        check,
        message: value(args, 'message') || cfg.message,
        write: apply ? writer(cfg) : undefined,
      });
      return results.some((r) => ['refused', 'conflict', 'needs --accept-loss'].includes(r.status)) ? 2 : 0;
    }
    case 'replace': {
      only(args, [...common, 'map', 'apply']);
      const mapFile = value(args, 'map');
      if (!mapFile) throw new Error('replace needs --map <file.json>');
      const apply = flag(args, 'apply');
      if (apply && value(args, 'fixtures')) throw new Error('--apply is not allowed with --fixtures');
      const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      await replaceText({ api: reader(cfg, args), scope: cfg, map, apply, write: apply ? writer(cfg) : undefined });
      return 0;
    }
    default:
      throw new Error(`unknown confluence command "${sub ?? ''}"; use pull, push, check or replace`);
  }
}

function reader(cfg: ConfluenceConfig, args: Args): ConfluenceReader {
  const fixtures = value(args, 'fixtures');
  if (fixtures) return new FixtureApi(JSON.parse(fs.readFileSync(fixtures, 'utf8')));
  return new ConfluenceApi({ site: cfg.site, ...requireCredentials(cfg.site) });
}

function writer(cfg: ConfluenceConfig): PageWriter {
  return pageWriter({ site: cfg.site, ...requireCredentials(cfg.site) });
}

// ---------- setup ----------

async function init(args: Args): Promise<number> {
  only(args, ['root', 'site', 'out', 'force']);
  const file = path.resolve(CONFIG_NAMES[0]);
  const existing = CONFIG_NAMES.map((n) => path.resolve(n)).find((f) => fs.existsSync(f));
  if (existing && !flag(args, 'force')) throw new Error(`${path.basename(existing)} already exists here; edit it, or re-run with --force to replace it`);

  let roots = values(args, 'root');
  if (!roots.length) {
    if (!process.stdin.isTTY) throw new Error('init needs --root <Confluence page URL> (the page whose tree you want to sync)');
    const answer = await ask('Confluence page to sync, with everything under it (paste its URL): ');
    roots = answer ? [answer] : [];
    if (!roots.length) throw new Error('no page given');
  }
  let site = value(args, 'site');
  for (const r of roots) {
    const host = /^https:\/\/([^/]+)\//.exec(r);
    if (host && !site) site = host[1];
  }
  if (!site) throw new Error('init needs --site <name>.atlassian.net (or a full page URL as --root)');
  if (!/^[\w.-]+\.atlassian\.net$/.test(site)) throw new Error(`site must be <name>.atlassian.net, not ${site}`);
  const ids = roots.map(pageIdOf);
  const out = value(args, 'out') || 'docs/confluence';

  const yaml = [
    '# adf-bridge Confluence settings: https://github.com/smorey2/adf-bridge',
    '# Only pages under these roots are ever pulled or pushed. Review changes to this file.',
    `site: ${site}`,
    `out: ${out}`,
    'roots:',
    ...ids.flatMap((id) => [`  - id: "${id}"`, '    type: page']),
    'exclude: []',
    '# main:',
    '#   wording:',
    '#     - Spell out contractions; "cannot" is one word.',
    '# templates:',
    `#   process: ${out}/_templates/process.adoc`,
    '',
  ].join('\n');
  fs.writeFileSync(file, yaml);
  console.log(`wrote ${path.basename(file)} (site ${site}, ${ids.length} root${ids.length === 1 ? '' : 's'})`);

  const ga = path.resolve('.gitattributes');
  const rule = '*.adoc text eol=lf';
  const current = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
  if (!current.split(/\r?\n/).some((l) => l.trim() === rule)) {
    fs.writeFileSync(ga, current + (current && !current.endsWith('\n') ? '\n' : '') + rule + '\n');
    console.log('added ".adoc text eol=lf" to .gitattributes');
  }

  const signedIn = resolveCredentials(site);
  console.log('\nNext:');
  if (!signedIn) console.log('  adf-bridge login                       save your Atlassian email and API token');
  console.log('  adf-bridge confluence pull --dry-run   see what would be pulled');
  console.log('  adf-bridge confluence pull             pull the pages into ' + out);
  return 0;
}

async function login(args: Args): Promise<number> {
  only(args, ['site', 'email', 'token-stdin', 'no-verify', 'config']);
  const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
  const email = value(args, 'email') || (await ask('Atlassian email: '));
  if (!email) throw new Error('no email given');
  console.log(`API token (create one at ${TOKEN_URL})`);
  const token = flag(args, 'token-stdin') ? (await readStdin()).trim() : await askHidden('API token: ');
  if (!token) throw new Error('no token given');

  if (site && !flag(args, 'no-verify')) {
    try {
      const me = await new ConfluenceApi({ site, email, token }).currentUser();
      console.log(`signed in to ${site} as ${me.displayName || email}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/-> 40[13]\b/.test(msg)) throw new Error(`${site} rejected that email and token; nothing was saved`);
      console.log(`warning: could not check the token against ${site} (${msg.slice(0, 120)}); saving it anyway`);
    }
  }
  const file = saveCredentials(site || null, { email, token });
  console.log(`saved for ${site || 'all sites'} in ${file}`);
  return 0;
}

async function logout(args: Args): Promise<number> {
  only(args, ['site', 'config']);
  const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
  const removed = removeCredentials(site || null) || (site ? removeCredentials(null) : false);
  console.log(removed ? `removed saved credentials${site ? ' for ' + site : ''}` : 'no saved credentials to remove');
  return 0;
}

async function whoami(args: Args): Promise<number> {
  only(args, ['site', 'config']);
  const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
  if (!site) {
    console.log(`no site: run in a folder with confluence.yaml, or pass --site (credentials file: ${credentialsFile()})`);
    return 1;
  }
  const c = resolveCredentials(site);
  console.log(c ? `${site}: ${c.email} (from ${c.source})` : `${site}: not signed in; run "adf-bridge login"`);
  return c ? 0 : 1;
}

function siteFromConfig(explicit?: string): string | undefined {
  if (!explicit && !findUp(process.cwd(), CONFIG_NAMES)) return undefined;
  return loadConfluenceConfig({ explicit }).site;
}

// ---------- prompts ----------

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// Reads a line without echoing it.
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('no terminal to type the token in; pipe it with --token-stdin');
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(buf.trim());
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Run when executed directly (bin/adf-bridge.js imports main instead).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run();
}

export function run(): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error('error: ' + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    },
  );
}
