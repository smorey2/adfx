// Pull Jira issues into the repo as read-only AsciiDoc (ADR-0008): one file per issue, plus a board
// page per board listing the active sprint by column. Files for issues that left scope are deleted
// (git keeps their history). Nothing is ever written to Jira.

import fs from 'node:fs';
import path from 'node:path';
import { convert, type LinkResolution } from '../core/adoc.ts';
import { walk, type AdfNode, type AdfMark } from '../core/adf.ts';
import * as header from '../core/header.ts';
import { writeFile, relPosix } from '../core/files.ts';
import { slug } from '../confluence/layout.ts';
import { type Board, type BoardColumn, type Comment, type Issue, type IssueRef, type JiraReader, type Sprint } from './api.ts';
import type { JiraConfig, Include } from './config.ts';

export type Log = (line: string) => void;

export interface JiraPullReport {
  written: string[];
  unchanged: string[];
  deleted: string[];
  issues: number;
}

interface BoardView {
  board: Board;
  file: string;
  columns: BoardColumn[];
  sprints: { sprint: Sprint | null; keys: string[] }[];
}

const GENERATED = 'adfx jira pull; do not edit, the next pull replaces this file';

export async function pullJira({ api, config, dryRun = false, log = console.log }: { api: JiraReader; config: JiraConfig; dryRun?: boolean; log?: Log }): Promise<JiraPullReport> {
  const report: JiraPullReport = { written: [], unchanged: [], deleted: [], issues: 0 };
  const sprintOf = new Map<string, string>(); // issue key -> sprint name, for the issue page
  const keys = new Set<string>();

  // 1. Boards: the active sprint(s), or for boards without sprints, everything not done. Scrum and
  // team-managed ("simple") boards can have sprints; Jira answers 400 when a board does not.
  const views: BoardView[] = [];
  const usedBoardFiles = new Set<string>();
  for (const b of config.boards) {
    const board = await api.board(b.id);
    const columns = await api.boardColumns(b.id);
    const sprints: BoardView['sprints'] = [];
    const active = board.type === 'kanban' ? null : await api.activeSprints(b.id).catch((e: Error) => {
      if (/ -> 400 /.test(e.message)) return null;
      throw e;
    });
    if (active) {
      for (const s of active) {
        const ks = await api.sprintIssueKeys(b.id, String(s.id));
        for (const k of ks) sprintOf.set(k, s.name);
        sprints.push({ sprint: s, keys: ks });
      }
    } else sprints.push({ sprint: null, keys: await api.boardIssueKeys(b.id, 'statusCategory != Done') });
    for (const s of sprints) for (const k of s.keys) keys.add(k);
    const dir = (board.location && board.location.projectKey) || 'boards';
    let file = `${dir}/board.adoc`;
    if (usedBoardFiles.has(file)) file = `${dir}/board-${slug(board.name)}-${b.id}.adoc`;
    usedBoardFiles.add(file);
    views.push({ board, file, columns, sprints });
    log(`board ${b.id} "${board.name}": ${sprints.map((s) => `${s.sprint ? s.sprint.name : 'not done'} (${s.keys.length})`).join(', ') || 'no active sprint'}`);
  }

  // 2. Issue details, in batches by key; then projects by JQL, always limited to their project.
  const issues = new Map<string, Issue>();
  const wanted = [...keys];
  for (let i = 0; i < wanted.length; i += 50) {
    const batch = wanted.slice(i, i + 50);
    for (const issue of await api.search(`key in (${batch.join(', ')})`)) issues.set(issue.key, issue);
  }
  for (const p of config.projects) {
    const jql = `project = "${p.key}"${p.jql ? ` AND (${p.jql})` : ''} ORDER BY key ASC`;
    const found = await api.search(jql);
    for (const issue of found) issues.set(issue.key, issue);
    log(`project ${p.key}: ${found.length} issues`);
  }
  report.issues = issues.size;

  // 3. Render.
  const fileOf = (key: string) => `${key.split('-')[0]}/${key}.adoc`;
  const outputs = new Map<string, string>();
  for (const issue of issues.values()) {
    if (config.include.includes('comments') && issue.fields.comment && (issue.fields.comment.total ?? 0) > issue.fields.comment.comments.length) {
      issue.fields.comment.comments = await api.comments(issue.key);
    }
    const rel = fileOf(issue.key);
    outputs.set(rel, renderIssue(issue, { site: config.site, include: config.include, sprint: sprintOf.get(issue.key), resolveLink: linkResolver(config.site, rel, issues, fileOf) }));
  }
  for (const v of views) outputs.set(v.file, renderBoard(v, issues, { site: config.site, resolveLink: linkResolver(config.site, v.file, issues, fileOf) }));

  // 4. Write what changed; delete generated files that are no longer in scope.
  for (const [rel, text] of outputs) {
    const file = path.join(config.out, rel);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text) {
      report.unchanged.push(rel);
      continue;
    }
    log(`${fs.existsSync(file) ? 'updated' : 'new'.padEnd(7)}  ${rel}`);
    if (!dryRun) writeFile(file, text);
    report.written.push(rel);
  }
  for (const rel of generatedFiles(config.out)) {
    if (outputs.has(rel)) continue;
    log(`deleted  ${rel}  (no longer in scope)`);
    if (!dryRun) fs.rmSync(path.join(config.out, rel));
    report.deleted.push(rel);
  }

  log('');
  log(`issues ${report.issues}, written ${report.written.length}, unchanged ${report.unchanged.length}, deleted ${report.deleted.length}`);
  if (dryRun) log('(dry run: nothing written)');
  return report;
}

// Files this tool wrote: they carry :jira-key: or :jira-board:. Nothing else is ever deleted.
function generatedFiles(outDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(outDir)) return out;
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.adoc')) {
        const h = header.parse(fs.readFileSync(p, 'utf8'));
        if (h && (h.attrs['jira-key'] || h.attrs['jira-board'])) out.push(relPosix(outDir, p));
      }
    }
  };
  visit(outDir);
  return out;
}

// Links to issues in the mirror become xrefs; everything else stays a URL.
function linkResolver(site: string, fromRel: string, issues: Map<string, Issue>, fileOf: (key: string) => string): (href: string) => LinkResolution {
  const fromDir = path.posix.dirname(fromRel);
  const re = new RegExp(`^https://${site.replace(/\./g, '\\.')}/browse/([A-Z][A-Z0-9_]*-\\d+)(?:#(.*))?$`);
  return (href) => {
    if (href.startsWith('#')) return { anchor: href.slice(1) };
    const m = re.exec(href);
    if (m && issues.has(m[1])) return { xref: path.posix.relative(fromDir, fileOf(m[1])), fragment: m[2] || '' };
    return { url: href };
  };
}

// ---------- rendering: build one ADF document, then let the converter write the AsciiDoc ----------

const text = (t: string, marks?: AdfMark[]): AdfNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...c: AdfNode[]): AdfNode => ({ type: 'paragraph', content: c });
const heading = (level: number, t: string): AdfNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const browse = (site: string, key: string) => `https://${site}/browse/${key}`;
const issueLink = (site: string, key: string): AdfNode => text(key, [{ type: 'link', attrs: { href: browse(site, key) } }]);
const day = (ts?: string) => (ts ? ts.slice(0, 10) : '');

// Jira content sits under the page's own sections: shift its headings down and drop local IDs,
// which mean nothing in a read-only copy.
function nest(nodes: AdfNode[] | undefined, by: number): AdfNode[] {
  const copy: AdfNode[] = JSON.parse(JSON.stringify(nodes || []));
  for (const n of copy)
    walk(n, (x) => {
      if (x.attrs && x.attrs.localId) delete x.attrs.localId;
      if (x.type === 'heading' && x.attrs) x.attrs.level = Math.min(6, (x.attrs.level || 1) + by);
    });
  return copy;
}

function refLine(site: string, r: IssueRef, before: string[] = []): AdfNode {
  const s = r.fields || {};
  return { type: 'listItem', content: [para(...before.map((b) => text(b)), issueLink(site, r.key), text(` ${s.summary || ''}${s.status && s.status.name ? ` (${s.status.name})` : ''}`))] };
}

export function renderIssue(issue: Issue, opts: { site: string; include: Include[]; sprint?: string; resolveLink: (href: string) => LinkResolution }): string {
  const f = issue.fields;
  const { site } = opts;
  const row = (label: string, value: AdfNode[]): AdfNode => ({
    type: 'tableRow',
    content: [
      { type: 'tableHeader', attrs: { colwidth: [160] }, content: [para(text(label))] },
      { type: 'tableCell', attrs: { colwidth: [520] }, content: [para(...value)] },
    ],
  });
  const rows = [
    row('Type', [text(f.issuetype?.name || '')]),
    row('Status', [text(f.status?.name || '')]),
    row('Priority', [text(f.priority?.name || 'None')]),
    row('Assignee', [text(f.assignee?.displayName || 'Unassigned')]),
    row('Reporter', [text(f.reporter?.displayName || '')]),
  ];
  if (opts.sprint) rows.push(row('Sprint', [text(opts.sprint)]));
  if (f.parent) rows.push(row('Parent', [issueLink(site, f.parent.key), text(f.parent.fields?.summary ? ` ${f.parent.fields.summary}` : '')]));
  if (f.labels && f.labels.length) rows.push(row('Labels', [text(f.labels.join(', '))]));
  rows.push(row('Created', [text(day(f.created))]), row('Updated', [text(day(f.updated))]));

  const content: AdfNode[] = [{ type: 'table', content: rows }];
  if (opts.include.includes('description')) {
    content.push(heading(1, 'Description'));
    content.push(...(f.description && f.description.content && f.description.content.length ? nest(f.description.content, 1) : [para(text('No description.'))]));
  }
  if (opts.include.includes('subtasks') && f.subtasks && f.subtasks.length) {
    content.push(heading(1, 'Subtasks'), { type: 'bulletList', content: f.subtasks.map((s) => refLine(site, s)) });
  }
  if (opts.include.includes('links') && f.issuelinks && f.issuelinks.length) {
    const items = f.issuelinks.map((l) => (l.outwardIssue ? refLine(site, l.outwardIssue, [l.type.outward + ' ']) : refLine(site, l.inwardIssue!, [l.type.inward + ' '])));
    content.push(heading(1, 'Links'), { type: 'bulletList', content: items });
  }
  const comments: Comment[] = (f.comment && f.comment.comments) || [];
  if (opts.include.includes('comments') && comments.length) {
    content.push(heading(1, 'Comments'));
    for (const c of comments) {
      content.push(heading(2, `${c.author?.displayName || 'Unknown'}, ${day(c.created)}`));
      content.push(...(c.body && c.body.content && c.body.content.length ? nest(c.body.content, 2) : [para(text('(empty)'))]));
    }
  }

  const attachments = f.attachment || [];
  const result = convert(
    { type: 'doc', version: 1, content },
    {
      resolveLink: opts.resolveLink,
      resolveMedia: (a) => {
        const att = attachments.find((x) => x.filename === a.alt);
        return att ? { url: att.content, title: att.filename } : {};
      },
    },
  );
  return header.render(`${issue.key}: ${f.summary || ''}`, [
    ['jira-key', issue.key],
    ['jira-source', browse(site, issue.key)],
    ['jira-updated', f.updated || null],
    ['generated', GENERATED],
  ], result.body);
}

export function renderBoard(view: BoardView, issues: Map<string, Issue>, opts: { site: string; resolveLink: (href: string) => LinkResolution }): string {
  const { site } = opts;
  const content: AdfNode[] = [para(text(`Board "${view.board.name}", as of the last pull. Each issue links to its own page.`))];
  const columnOf = (key: string): string => {
    const status = issues.get(key)?.fields.status;
    const col = view.columns.find((c) => c.statuses.some((s) => String(s.id) === String(status?.id)));
    return col ? col.name : status?.name || 'Other';
  };
  const columnNames = [...view.columns.map((c) => c.name)];
  for (const { sprint, keys } of view.sprints) {
    const level = sprint ? 2 : 1;
    if (sprint) {
      content.push(heading(1, sprint.name));
      const dates = sprint.startDate || sprint.endDate ? `${day(sprint.startDate)} to ${day(sprint.endDate)}` : '';
      const line = [dates, sprint.goal ? `Goal: ${sprint.goal}` : ''].filter(Boolean).join('. ');
      if (line) content.push(para(text(line)));
    }
    const names = [...columnNames, ...new Set(keys.map(columnOf).filter((n) => !columnNames.includes(n)))];
    for (const name of names) {
      const inCol = keys.filter((k) => columnOf(k) === name && issues.has(k));
      content.push(heading(level, name));
      if (!inCol.length) {
        content.push(para(text('None.')));
        continue;
      }
      const cell = (type: string, c: AdfNode[], w: number): AdfNode => ({ type, attrs: { colwidth: [w] }, content: [para(...c)] });
      const head: AdfNode = { type: 'tableRow', content: [cell('tableHeader', [text('Key')], 110), cell('tableHeader', [text('Summary')], 400), cell('tableHeader', [text('Type')], 100), cell('tableHeader', [text('Assignee')], 160)] };
      const rows = inCol.map((k) => {
        const f = issues.get(k)!.fields;
        return { type: 'tableRow', content: [cell('tableCell', [issueLink(site, k)], 110), cell('tableCell', [text(f.summary || '')], 400), cell('tableCell', [text(f.issuetype?.name || '')], 100), cell('tableCell', [text(f.assignee?.displayName || 'Unassigned')], 160)] };
      });
      content.push({ type: 'table', content: [head, ...rows] });
    }
  }
  if (!view.sprints.length) content.push(para(text('No active sprint.')));
  const result = convert({ type: 'doc', version: 1, content }, { resolveLink: opts.resolveLink });
  return header.render(view.board.name, [
    ['jira-board', String(view.board.id)],
    ['jira-source', `https://${site}/secure/RapidBoard.jspa?rapidView=${view.board.id}`],
    ['generated', GENERATED],
  ], result.body);
}
