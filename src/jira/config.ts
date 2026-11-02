// jira.yaml: which Jira issues a project mirrors, read-only (ADR-0008). Only the documented keys are
// accepted, so a typo fails loudly.
//
//   site: example.atlassian.net
//   out: docs/jira                 # mirror folder, relative to this file
//   boards:                        # a board's issues, as the board shows them
//     - id: "42"
//       sprints: active            # active (default): the active sprint(s); kanban boards: not done
//   projects:                      # optional: more issues by project, narrowed by JQL
//     - key: CORE
//       jql: statusCategory != Done
//   include: [description, comments, subtasks, links]

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, type YamlValue } from '../core/yaml.ts';
import { findUp } from '../core/files.ts';

export const JIRA_CONFIG_NAMES = ['jira.yaml', 'jira.yml'];
export const INCLUDE = ['description', 'comments', 'subtasks', 'links'] as const;
export type Include = (typeof INCLUDE)[number];

export interface JiraConfig {
  file: string | null;
  root: string;
  site: string;
  out: string;
  boards: { id: string; sprints: 'active' }[];
  projects: { key: string; jql?: string }[];
  include: Include[];
}

const TOP = ['site', 'out', 'boards', 'projects', 'include'];

export function parseJiraConfig(text: string, { file = null, root = process.cwd() }: { file?: string | null; root?: string } = {}): JiraConfig {
  const name = file ? path.basename(file) : 'jira.yaml';
  const fail = (msg: string): never => {
    throw new Error(`${name}: ${msg}`);
  };
  const doc = parseYaml(text, name);
  if (!isMap(doc)) return fail('expected "key: value" settings');
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) fail(`unknown key "${k}" (allowed: ${TOP.join(', ')})`);

  const site = typeof doc.site === 'string' ? doc.site : '';
  if (!/^[\w.-]+\.atlassian\.net$/.test(site)) fail('site must be <name>.atlassian.net');

  const boards = list(doc.boards, 'boards', fail).map((item, i) => {
    const b = entry(item, `boards[${i + 1}]`, ['id', 'sprints', 'title'], 'id', fail);
    if (!/^\d+$/.test(b.id)) fail(`invalid board id "${b.id}" in boards[${i + 1}]`);
    const sprints = b.sprints || 'active';
    if (sprints !== 'active') fail(`boards[${i + 1}].sprints must be "active"`);
    return { id: b.id, sprints: 'active' as const };
  });
  const projects = list(doc.projects, 'projects', fail).map((item, i) => {
    const p = entry(item, `projects[${i + 1}]`, ['key', 'jql', 'title'], 'key', fail);
    if (!/^[A-Z][A-Z0-9_]+$/.test(p.key)) fail(`invalid project key "${p.key}" in projects[${i + 1}]`);
    return { key: p.key, ...(p.jql ? { jql: p.jql } : {}) };
  });
  if (!boards.length && !projects.length) fail('nothing to pull: add boards or projects');

  const include = doc.include === undefined ? [...INCLUDE] : list(doc.include, 'include', fail).map((v) => String(v));
  for (const v of include) if (!(INCLUDE as readonly string[]).includes(v)) fail(`include: unknown "${v}" (allowed: ${INCLUDE.join(', ')})`);

  const out = typeof doc.out === 'string' && doc.out ? doc.out : 'docs/jira';
  return { file, root, site, out: path.resolve(root, out), boards, projects, include: include as Include[] };
}

export function loadJiraConfig({ start = process.cwd(), explicit }: { start?: string; explicit?: string } = {}): JiraConfig {
  const file = explicit ? path.resolve(explicit) : findUp(start, JIRA_CONFIG_NAMES);
  if (!file) throw new Error(`no jira.yaml in ${path.resolve(start)} or any parent folder; run "adf-bridge init --board <board URL>"`);
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  return parseJiraConfig(fs.readFileSync(file, 'utf8'), { file, root: path.dirname(file) });
}

function isMap(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function list(v: YamlValue | undefined, key: string, fail: (m: string) => never): YamlValue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`expected a list under "${key}"`);
  return v as YamlValue[];
}

function entry(item: YamlValue, where: string, keys: string[], main: string, fail: (m: string) => never): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof item === 'string') out[main] = item;
  else if (isMap(item)) {
    for (const [k, v] of Object.entries(item)) {
      if (!keys.includes(k)) fail(`unknown key "${k}" in ${where} (allowed: ${keys.join(', ')})`);
      if (typeof v !== 'string') fail(`${where}.${k} must be a single value`);
      out[k] = v as string;
    }
  } else fail(`${where} must be a ${main} or "${main}: ..."`);
  if (!out[main]) fail(`${where} needs ${main}`);
  return out;
}
