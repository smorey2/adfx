// Replace exact table-cell values on in-scope pages, e.g. real example data -> fake (ADR-0005 §8).
// Only text nodes whose trimmed text equals a mapped value are changed, so partial matches ("FL" in
// "FLS") are left alone. Marks (including inline-comment annotations) and all other nodes are untouched.

import { parseAdf, type AdfNode } from '../core/adf.ts';
import type { ConfluenceReader, PageWriter } from './api.ts';
import type { Scope } from './config.ts';
import type { Log } from './pull.ts';

export interface CellChange {
  from: string;
  to: string;
  row: string;
}

export function replaceInCells(adf: AdfNode, mapping: Record<string, string>): { adf: AdfNode; counts: Record<string, number>; changes: CellChange[]; leftovers: Record<string, number> } {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(mapping).map((k) => [k, 0]));
  const changes: CellChange[] = [];

  const visit = (node: AdfNode, inCell: boolean, row: string) => {
    if (!node || typeof node !== 'object') return;
    const cell = inCell || node.type === 'tableCell' || node.type === 'tableHeader';
    const r = node.type === 'tableRow' ? rowText(node) : row;
    if (node.type === 'text' && cell && typeof node.text === 'string') {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text)!;
      if (Object.prototype.hasOwnProperty.call(mapping, m[2])) {
        counts[m[2]]++;
        changes.push({ from: m[2], to: mapping[m[2]], row: r });
        node.text = m[1] + mapping[m[2]] + m[3];
        // e.g. an auto-linked email carries the old value in its mailto: href
        for (const mk of node.marks || []) {
          if (mk.type === 'link' && mk.attrs && typeof mk.attrs.href === 'string') mk.attrs.href = mk.attrs.href.split(m[2]).join(mapping[m[2]]);
        }
      }
    }
    // nested tables are stored as an ADF JSON string inside an extension
    const a = node.attrs;
    if (node.type === 'extension' && a && a.extensionKey === 'nested-table' && a.parameters && a.parameters.adf) {
      const inner = JSON.parse(a.parameters.adf);
      const res = replaceInCells(inner, mapping);
      if (res.changes.length) {
        a.parameters.adf = JSON.stringify(inner);
        for (const [k, v] of Object.entries(res.counts)) counts[k] += v;
        changes.push(...res.changes);
      }
    }
    for (const c of node.content || []) visit(c, cell, r);
  };
  visit(adf, false, '');

  // anything still containing an old value (partial matches, text outside tables) is reported, not changed
  const leftovers: Record<string, number> = {};
  const all = JSON.stringify(adf);
  for (const k of Object.keys(mapping)) {
    const n = all.split(k).length - 1;
    if (n) leftovers[k] = n;
  }
  return { adf, counts, changes, leftovers };
}

function rowText(row: AdfNode): string {
  const cells = (row.content || []).map((c) => {
    const out: string[] = [];
    const walk = (n: AdfNode) => {
      if (n.type === 'text') out.push((n.text || '').trim());
      (n.content || []).forEach(walk);
    };
    walk(c);
    return out.join(' ');
  });
  return cells.join(' | ').slice(0, 160);
}

// map: { "message": "...", "pages": { "<pageId>": { "<old>": "<new>" } } }. Keep map files that
// contain real values out of the repo.
export interface ReplaceMap {
  message?: string;
  pages?: Record<string, Record<string, string>>;
}

export interface ReplaceResult {
  id: string;
  title: string;
  version: number;
  changes: number;
  written: boolean;
  newVersion?: number;
}

export async function replaceText({ api, scope, map, apply = false, write, log = console.log }: { api: ConfluenceReader; scope: Scope; map: ReplaceMap; apply?: boolean; write?: PageWriter; log?: Log }): Promise<ReplaceResult[]> {
  const results: ReplaceResult[] = [];
  const message = map.message || 'Replace example values';
  for (const [id, mapping] of Object.entries(map.pages || {})) {
    if (!/^\d+$/.test(id)) throw new Error(`map: invalid page id "${id}"`);
    for (const [k, v] of Object.entries(mapping)) {
      if (!k || typeof v !== 'string') throw new Error(`map: page ${id} has an empty key or non-string value`);
      if (Object.prototype.hasOwnProperty.call(mapping, v)) throw new Error(`map: page ${id} maps "${k}" to "${v}", which is itself replaced`);
    }

    // scope (ADR-0002): the page must sit under a root and not be excluded
    const cql = `id = ${id} AND (${scope.roots.map((r) => `ancestor = ${r.id}`).join(' OR ')})`;
    const hits = (await api.cql(cql)).filter((c) => String(c.id) === id);
    if (hits.length !== 1) throw new Error(`page ${id} is not in scope`);
    if (scope.exclude.includes(id)) throw new Error(`page ${id} is excluded in confluence.yaml`);

    const page = await api.page(id);
    const version = page.version.number;
    const adf = parseAdf(page.body && page.body.atlas_doc_format && page.body.atlas_doc_format.value);
    const res = replaceInCells(adf, mapping);

    log(`== ${id} "${page.title}" (v${version})`);
    for (const c of res.changes) log(`   ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}   [${c.row}]`);
    for (const [k, n] of Object.entries(res.counts)) if (!n) log(`   WARNING: "${k}" not found in any table cell`);
    for (const [k, n] of Object.entries(res.leftovers)) log(`   note: "${k}" still appears ${n}x outside a whole cell value (left unchanged)`);

    const result: ReplaceResult = { id, title: page.title, version, changes: res.changes.length, written: false };
    if (apply && res.changes.length) {
      if (!write) throw new Error('no writer configured; replacing needs credentials (not --fixtures)');
      const out = await write({ id, title: page.title, adf: res.adf, version: version + 1, message });
      result.written = true;
      result.newVersion = out && out.version && out.version.number;
      log(`   written: v${version} -> v${result.newVersion || version + 1}`);
    }
    results.push(result);
  }
  if (!apply) log('\n(dry run: nothing written; re-run with --apply)');
  return results;
}
