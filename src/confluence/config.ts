// confluence.yaml: what a project syncs, where the mirror lives, and how pages are written (ADR-0002,
// ADR-0006). Only the documented keys are accepted, so a typo fails loudly instead of silently
// widening or narrowing scope.
//
//   site: example.atlassian.net
//   out: docs/confluence                 # mirror folder, relative to this file
//   message: Published with adfx   # default version comment for pushes
//   roots:                               # pages (or folders) synced with everything under them
//     - id: "123456"
//       space: DOCS                      # for people; only id is used
//       title: Engineering
//       type: page                       # page | folder
//   exclude:                             # never pulled or pushed, with everything under them
//     - id: "234567"
//       title: Private notes
//   main:                                # rules for every page
//     wording:
//       - Spell out contractions; "cannot" is one word.
//   templates:                           # page skeletons for "confluence new"
//     process: docs/confluence/_templates/process.adoc

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, type YamlValue } from '../core/yaml.ts';
import { findUp } from '../core/files.ts';

export const CONFIG_NAMES = ['confluence.yaml', 'confluence.yml'];

export interface Root {
  id: string;
  type: 'page' | 'folder';
  space?: string;
  title?: string;
}

export interface Scope {
  site: string;
  roots: Root[];
  exclude: string[];
}

export interface ConfluenceConfig extends Scope {
  file: string | null; // the config file, or null when parsed from text
  root: string; // project root: the folder holding the config file
  out: string; // absolute mirror folder
  message: string;
  main: { wording: string[] };
  templates: Record<string, string>; // name -> absolute path
}

const TOP_KEYS = ['site', 'out', 'message', 'roots', 'exclude', 'main', 'templates'];

export function parseConfluenceConfig(text: string, { file = null, root = process.cwd() }: { file?: string | null; root?: string } = {}): ConfluenceConfig {
  const name = file ? path.basename(file) : 'confluence.yaml';
  const fail = (msg: string): never => {
    throw new Error(`${name}: ${msg}`);
  };
  const doc = parseYaml(text, name);
  if (!isMap(doc)) return fail('expected "key: value" settings');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) fail(`unknown key "${k}" (allowed: ${TOP_KEYS.join(', ')})`);

  const site = str(doc.site, 'site', fail);
  if (!site || !/^[\w.-]+\.atlassian\.net$/.test(site)) fail('site must be <name>.atlassian.net');

  const roots: Root[] = list(doc.roots, 'roots', fail).map((item, i) => {
    const r = entry(item, `roots[${i + 1}]`, ['id', 'type', 'space', 'title'], fail);
    const type = r.type || 'page';
    if (type !== 'page' && type !== 'folder') fail(`root ${r.id} type must be page or folder`);
    return { id: r.id, type: type as Root['type'], ...(r.space ? { space: r.space } : {}), ...(r.title ? { title: r.title } : {}) };
  });
  if (!roots.length) fail('no roots');
  const exclude = list(doc.exclude, 'exclude', fail).map((item, i) => entry(item, `exclude[${i + 1}]`, ['id', 'title'], fail).id);

  const mainDoc = doc.main ?? {};
  if (!isMap(mainDoc)) fail('main must be a set of "key: value" settings');
  const mainMap = mainDoc as Record<string, YamlValue>;
  for (const k of Object.keys(mainMap)) if (k !== 'wording') fail(`unknown key "main.${k}" (allowed: wording)`);
  const wording = list(mainMap.wording, 'main.wording', fail).map((w, i) => str(w, `main.wording[${i + 1}]`, fail) || fail(`main.wording[${i + 1}] is empty`));

  const tplDoc = doc.templates ?? {};
  if (!isMap(tplDoc)) fail('templates must map a name to a file');
  const templates: Record<string, string> = {};
  for (const [k, v] of Object.entries(tplDoc as Record<string, YamlValue>)) {
    if (!/^[\w-]+$/.test(k)) fail(`template name "${k}" may only use letters, digits, - and _`);
    templates[k] = path.resolve(root, str(v, `templates.${k}`, fail) || fail(`templates.${k} needs a file`));
  }

  return {
    file,
    root,
    site,
    roots,
    exclude,
    out: path.resolve(root, str(doc.out, 'out', fail) || 'docs/confluence'),
    message: str(doc.message, 'message', fail) || 'Published with adfx',
    main: { wording },
    templates,
  };
}

// Finds confluence.yaml in `start` or a parent folder (like git), or uses `explicit`.
export function loadConfluenceConfig({ start = process.cwd(), explicit }: { start?: string; explicit?: string } = {}): ConfluenceConfig {
  const file = explicit ? path.resolve(explicit) : findUp(start, CONFIG_NAMES);
  if (!file) throw new Error(`no confluence.yaml in ${path.resolve(start)} or any parent folder; run "adfx init"`);
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  return parseConfluenceConfig(fs.readFileSync(file, 'utf8'), { file, root: path.dirname(file) });
}

function isMap(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: YamlValue | undefined, key: string, fail: (m: string) => never): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(`${key} must be a single value`);
  return v as string;
}

function list(v: YamlValue | undefined, key: string, fail: (m: string) => never): YamlValue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`expected a list under "${key}"`);
  return v as YamlValue[];
}

// A list entry: either "- 123" or "- id: 123" with optional extra keys.
function entry(item: YamlValue, where: string, keys: string[], fail: (m: string) => never): Record<string, string> & { id: string } {
  const out: Record<string, string> = {};
  if (typeof item === 'string') out.id = item;
  else if (isMap(item)) {
    for (const [k, v] of Object.entries(item)) {
      if (!keys.includes(k)) fail(`unknown key "${k}" in ${where} (allowed: ${keys.join(', ')})`);
      out[k] = str(v, `${where}.${k}`, fail);
    }
  } else fail(`${where} must be an id or "id: ..."`);
  if (!/^\d+$/.test(out.id || '')) fail(`invalid id "${out.id ?? ''}" in ${where}`);
  return out as Record<string, string> & { id: string };
}
