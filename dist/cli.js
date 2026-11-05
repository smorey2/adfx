// adfx command line. Run "adfx help" for usage.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfluenceApi, FixtureApi, pageCreator, pageWriter } from "./confluence/api.js";
import { CONFIG_NAMES, loadConfluenceConfig } from "./confluence/config.js";
import { pull } from "./confluence/pull.js";
import { publish } from "./confluence/publish.js";
import { replaceText } from "./confluence/replace.js";
import { newPage } from "./confluence/new.js";
import { JIRA_CONFIG_NAMES, loadJiraConfig } from "./jira/config.js";
import { JiraApi, JiraFixtureApi } from "./jira/api.js";
import { pullJira } from "./jira/pull.js";
import { credentialsFile, removeCredentials, requireCredentials, resolveCredentials, saveCredentials } from "./core/credentials.js";
import { findUp } from "./core/files.js";
const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const HELP = `adfx: sync Confluence and Jira with git, as AsciiDoc.

Setup
  adfx init [--root <page URL>]... [--board <Jira board URL>]... [--site <name>.atlassian.net] [--out <dir>] [--force]
      Write confluence.yaml (for --root) and/or jira.yaml (for --board), and make .adoc files use LF.
  adfx login [--site <site>] [--email <email>] [--token-stdin] [--no-verify]
      Save your Atlassian email and API token for this user (never in the repo).
      Create a token at ${TOKEN_URL}
  adfx logout [--site <site>]
  adfx whoami
      Show which account and credential source would be used (never the token).

Confluence
  adfx confluence pull [--dry-run] [--page <id or URL>]... [--force]
      Pull in-scope pages into the mirror. Never overwrites a file with local edits.
  adfx confluence push [files...] [--page <id or URL>]... [--apply] [--accept-loss] [--message <text>]
      Show what would change on Confluence (dry run). Add --apply to write.
      A file made by "confluence new" is created as a new page.
  adfx confluence new "<title>" --parent <page id or URL> [--template <name>]
      Write a draft for a new page, from a template in confluence.yaml.
  adfx confluence check [files...] [--page <id or URL>]...
      Can each block be rebuilt exactly? Blocks that cannot are pull-only.
  adfx confluence info
      Show the site, mirror, scope, wording rules and templates from confluence.yaml.
  adfx confluence replace --map <file.json> [--apply]
      Replace exact table-cell values (e.g. real example data with fake data).

Jira (read-only)
  adfx jira pull [--dry-run]
      Pull the issues jira.yaml names: one file per issue plus a page per board.
      Files for issues that left scope are deleted (git keeps them).

Options for every command
  --config <file>     use this confluence.yaml or jira.yaml (default: the nearest one in this folder or above)
  --fixtures <file>   read from a JSON fixture instead of the API (no writes)
  --out <dir>         mirror folder (default: "out" in confluence.yaml, else docs/confluence)
  -h, --help          show this help
  -v, --version       show the version`;
const BOOLEAN = new Set(['dry-run', 'force', 'apply', 'accept-loss', 'token-stdin', 'no-verify', 'help', 'version']);
const ALIAS = { h: 'help', v: 'version' };
export function parseArgs(argv) {
    const out = { _: [], flags: {} };
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
        if (a.startsWith('-') && !a.startsWith('--') && !ALIAS[m[1]])
            throw new Error(`unknown option ${a}`);
        let value;
        if (BOOLEAN.has(name))
            value = 'true';
        else if (m[2] !== undefined)
            value = m[2];
        else {
            if (i + 1 >= argv.length)
                throw new Error(`--${name} needs a value`);
            value = argv[++i];
        }
        (out.flags[name] ||= []).push(value);
    }
    return out;
}
function only(args, allowed) {
    for (const k of Object.keys(args.flags))
        if (!allowed.includes(k))
            throw new Error(`unknown option --${k}`);
}
const flag = (args, name) => Boolean(args.flags[name]);
const value = (args, name) => (args.flags[name] ? args.flags[name][args.flags[name].length - 1] : undefined);
const values = (args, name) => args.flags[name] || [];
// "12345", ".../pages/12345/Title", "...viewpage.action?pageId=12345" -> "12345"
export function pageIdOf(s) {
    if (/^\d+$/.test(s))
        return s;
    const m = /\/pages\/(\d+)|[?&]pageId=(\d+)/.exec(s);
    if (!m)
        throw new Error(`not a page id or Confluence page URL: ${s}`);
    return m[1] || m[2];
}
function version() {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return pkg.version;
}
export async function main(argv = process.argv.slice(2)) {
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
        case 'jira':
            return jira(sub, { ...args, _: rest });
        default:
            throw new Error(`unknown command "${cmd}"; run "adfx help"`);
    }
}
// ---------- confluence ----------
async function confluence(sub, args) {
    const common = ['config', 'fixtures', 'out'];
    const cfg = loadConfluenceConfig({ explicit: value(args, 'config') });
    const outDir = value(args, 'out') ? path.resolve(value(args, 'out')) : cfg.out;
    const pages = values(args, 'page').map(pageIdOf);
    switch (sub) {
        case 'pull': {
            only(args, [...common, 'dry-run', 'page', 'force']);
            if (args._.length)
                throw new Error(`unexpected argument "${args._[0]}"`);
            const report = await pull({ api: reader(cfg, args), scope: cfg, outDir, dryRun: flag(args, 'dry-run'), force: flag(args, 'force'), only: pages });
            return report.conflicts.length ? 2 : 0;
        }
        case 'push':
        case 'publish':
        case 'check': {
            const check = sub === 'check';
            only(args, check ? [...common, 'page'] : [...common, 'page', 'apply', 'accept-loss', 'message']);
            const apply = flag(args, 'apply');
            if (apply && value(args, 'fixtures'))
                throw new Error('--apply is not allowed with --fixtures');
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
                create: apply ? creator(cfg) : undefined,
            });
            return results.some((r) => ['refused', 'conflict', 'needs --accept-loss'].includes(r.status)) ? 2 : 0;
        }
        case 'new': {
            only(args, [...common, 'parent', 'template']);
            const title = args._.join(' ');
            const parent = value(args, 'parent');
            if (!title)
                throw new Error('new needs a title: adfx confluence new "Page title" --parent <page id or URL>');
            if (!parent)
                throw new Error('new needs --parent <page id or URL> (an in-scope page or folder)');
            await newPage({ api: reader(cfg, args), config: cfg, outDir, title, parentId: pageIdOf(parent), template: value(args, 'template') });
            return 0;
        }
        case 'info': {
            only(args, ['config']);
            const rel = (p) => path.relative(cfg.root, p).split(path.sep).join('/') || '.';
            console.log(`config     ${cfg.file}`);
            console.log(`site       ${cfg.site}`);
            console.log(`mirror     ${rel(cfg.out)}`);
            console.log(`roots      ${cfg.roots.map((r) => r.id + (r.title ? ` (${r.title})` : '')).join(', ')}`);
            console.log(`exclude    ${cfg.exclude.join(', ') || 'none'}`);
            console.log('wording rules (follow them when writing page text):');
            for (const w of cfg.main.wording)
                console.log(`  - ${w}`);
            if (!cfg.main.wording.length)
                console.log('  none');
            console.log('templates (for "confluence new --template <name>"):');
            for (const [k, v] of Object.entries(cfg.templates))
                console.log(`  ${k}: ${rel(v)}${fs.existsSync(v) ? '' : '  (missing)'}`);
            if (!Object.keys(cfg.templates).length)
                console.log('  none');
            return 0;
        }
        case 'replace': {
            only(args, [...common, 'map', 'apply']);
            const mapFile = value(args, 'map');
            if (!mapFile)
                throw new Error('replace needs --map <file.json>');
            const apply = flag(args, 'apply');
            if (apply && value(args, 'fixtures'))
                throw new Error('--apply is not allowed with --fixtures');
            const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
            await replaceText({ api: reader(cfg, args), scope: cfg, map, apply, write: apply ? writer(cfg) : undefined });
            return 0;
        }
        default:
            throw new Error(`unknown confluence command "${sub ?? ''}"; use pull, push, new, check, info or replace`);
    }
}
// ---------- jira (read-only) ----------
async function jira(sub, args) {
    if (sub !== 'pull')
        throw new Error(`unknown jira command "${sub ?? ''}"; use pull (Jira is read-only)`);
    only(args, ['config', 'fixtures', 'out', 'dry-run']);
    if (args._.length)
        throw new Error(`unexpected argument "${args._[0]}"`);
    const cfg = loadJiraConfig({ explicit: value(args, 'config') });
    if (value(args, 'out'))
        cfg.out = path.resolve(value(args, 'out'));
    const fixtures = value(args, 'fixtures');
    const api = fixtures ? new JiraFixtureApi(JSON.parse(fs.readFileSync(fixtures, 'utf8'))) : new JiraApi({ site: cfg.site, ...requireCredentials(cfg.site) });
    await pullJira({ api, config: cfg, dryRun: flag(args, 'dry-run') });
    return 0;
}
function reader(cfg, args) {
    const fixtures = value(args, 'fixtures');
    if (fixtures)
        return new FixtureApi(JSON.parse(fs.readFileSync(fixtures, 'utf8')));
    return new ConfluenceApi({ site: cfg.site, ...requireCredentials(cfg.site) });
}
function writer(cfg) {
    return pageWriter({ site: cfg.site, ...requireCredentials(cfg.site) });
}
function creator(cfg) {
    return pageCreator({ site: cfg.site, ...requireCredentials(cfg.site) });
}
// ---------- setup ----------
// "12", ".../boards/12", ".../RapidBoard.jspa?rapidView=12" -> "12"
export function boardIdOf(s) {
    if (/^\d+$/.test(s))
        return s;
    const m = /\/boards\/(\d+)|[?&]rapidView=(\d+)/.exec(s);
    if (!m)
        throw new Error(`not a board id or Jira board URL: ${s}`);
    return m[1] || m[2];
}
function siteOf(urls, explicit) {
    let site = explicit;
    for (const u of urls) {
        const host = /^https:\/\/([^/]+)\//.exec(u);
        if (host && !site)
            site = host[1];
    }
    if (!site)
        throw new Error('init needs --site <name>.atlassian.net (or full URLs)');
    if (!/^[\w.-]+\.atlassian\.net$/.test(site))
        throw new Error(`site must be <name>.atlassian.net, not ${site}`);
    return site;
}
function refuseExisting(names, force) {
    const existing = names.map((n) => path.resolve(n)).find((f) => fs.existsSync(f));
    if (existing && !force)
        throw new Error(`${path.basename(existing)} already exists here; edit it, or re-run with --force to replace it`);
}
async function init(args) {
    only(args, ['root', 'board', 'site', 'out', 'force']);
    let roots = values(args, 'root');
    const boards = values(args, 'board');
    if (!roots.length && !boards.length) {
        if (!process.stdin.isTTY)
            throw new Error('init needs --root <Confluence page URL> and/or --board <Jira board URL>');
        const answer = await ask('Confluence page to sync, with everything under it (paste its URL): ');
        roots = answer ? [answer] : [];
        if (!roots.length)
            throw new Error('no page given');
    }
    const force = flag(args, 'force');
    if (roots.length)
        refuseExisting(CONFIG_NAMES, force);
    if (boards.length)
        refuseExisting(JIRA_CONFIG_NAMES, force);
    const next = [];
    let site = '';
    if (boards.length) {
        site = siteOf(boards, value(args, 'site'));
        const ids = boards.map(boardIdOf);
        const out = roots.length ? 'docs/jira' : value(args, 'out') || 'docs/jira';
        const yaml = [
            '# adfx Jira settings (read-only mirror): https://github.com/smorey2/adfx',
            `site: ${site}`,
            `out: ${out}`,
            'boards:',
            ...ids.flatMap((id) => [`  - id: "${id}"`, '    sprints: active']),
            '# projects:',
            '#   - key: ABC',
            '#     jql: statusCategory != Done',
            'include: [description, comments, subtasks, links]',
            '',
        ].join('\n');
        fs.writeFileSync(path.resolve(JIRA_CONFIG_NAMES[0]), yaml);
        console.log(`wrote jira.yaml (site ${site}, board${ids.length === 1 ? '' : 's'} ${ids.join(', ')})`);
        next.push('  adfx jira pull --dry-run         see which issues would be pulled');
    }
    if (!roots.length)
        return initDone(site, next);
    site = siteOf(roots, value(args, 'site'));
    const file = path.resolve(CONFIG_NAMES[0]);
    const ids = roots.map(pageIdOf);
    const out = value(args, 'out') || 'docs/confluence';
    const yaml = [
        '# adfx Confluence settings: https://github.com/smorey2/adfx',
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
    next.unshift('  adfx confluence pull --dry-run   see what would be pulled', '  adfx confluence pull             pull the pages into ' + out);
    return initDone(site, next);
}
function initDone(site, next) {
    const ga = path.resolve('.gitattributes');
    const rule = '*.adoc text eol=lf';
    const current = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
    if (!current.split(/\r?\n/).some((l) => l.trim() === rule)) {
        fs.writeFileSync(ga, current + (current && !current.endsWith('\n') ? '\n' : '') + rule + '\n');
        console.log('added ".adoc text eol=lf" to .gitattributes');
    }
    console.log('\nNext:');
    if (!resolveCredentials(site))
        console.log('  adfx login                       save your Atlassian email and API token');
    for (const l of next)
        console.log(l);
    return 0;
}
async function login(args) {
    only(args, ['site', 'email', 'token-stdin', 'no-verify', 'config']);
    const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
    const email = value(args, 'email') || (await ask('Atlassian email: '));
    if (!email)
        throw new Error('no email given');
    console.log(`API token (create one at ${TOKEN_URL})`);
    const token = flag(args, 'token-stdin') ? (await readStdin()).trim() : await askHidden('API token: ');
    if (!token)
        throw new Error('no token given');
    if (site && !flag(args, 'no-verify')) {
        try {
            const me = await new ConfluenceApi({ site, email, token }).currentUser();
            console.log(`signed in to ${site} as ${me.displayName || email}`);
        }
        catch (e) {
            const msg = e.message;
            if (/-> 40[13]\b/.test(msg))
                throw new Error(`${site} rejected that email and token; nothing was saved`);
            console.log(`warning: could not check the token against ${site} (${msg.slice(0, 120)}); saving it anyway`);
        }
    }
    const file = saveCredentials(site || null, { email, token });
    console.log(`saved for ${site || 'all sites'} in ${file}`);
    return 0;
}
async function logout(args) {
    only(args, ['site', 'config']);
    const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
    const removed = removeCredentials(site || null) || (site ? removeCredentials(null) : false);
    console.log(removed ? `removed saved credentials${site ? ' for ' + site : ''}` : 'no saved credentials to remove');
    return 0;
}
async function whoami(args) {
    only(args, ['site', 'config']);
    const site = value(args, 'site') || siteFromConfig(value(args, 'config'));
    if (!site) {
        console.log(`no site: run in a folder with confluence.yaml, or pass --site (credentials file: ${credentialsFile()})`);
        return 1;
    }
    const c = resolveCredentials(site);
    console.log(c ? `${site}: ${c.email} (from ${c.source})` : `${site}: not signed in; run "adfx login"`);
    return c ? 0 : 1;
}
function siteFromConfig(explicit) {
    if (explicit)
        return /jira\.ya?ml$/i.test(explicit) ? loadJiraConfig({ explicit }).site : loadConfluenceConfig({ explicit }).site;
    if (findUp(process.cwd(), CONFIG_NAMES))
        return loadConfluenceConfig().site;
    if (findUp(process.cwd(), JIRA_CONFIG_NAMES))
        return loadJiraConfig().site;
    return undefined;
}
// ---------- prompts ----------
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => {
        rl.close();
        resolve(a.trim());
    }));
}
// Reads a line without echoing it.
function askHidden(question) {
    const stdin = process.stdin;
    if (!stdin.isTTY)
        throw new Error('no terminal to type the token in; pipe it with --token-stdin');
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return new Promise((resolve, reject) => {
        let buf = '';
        const finish = (err) => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\n');
            if (err)
                reject(err);
            else
                resolve(buf.trim());
        };
        const onData = (s) => {
            for (const ch of s) {
                if (ch === '\r' || ch === '\n')
                    return finish();
                if (ch === '\u0003')
                    return finish(new Error('cancelled'));
                if (ch === '\u007f' || ch === '\b')
                    buf = buf.slice(0, -1);
                else
                    buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}
async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}
// Run when executed directly (bin/adfx.js imports main instead).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    run();
}
export function run() {
    main().then((code) => {
        process.exitCode = code;
    }, (e) => {
        console.error('error: ' + (e instanceof Error ? e.message : String(e)));
        process.exitCode = 1;
    });
}
