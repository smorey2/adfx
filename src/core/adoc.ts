// ADF -> AsciiDoc converter. Spec: docs/adr/0005-asciidoc-round-trip.md §2.
// Pure function: no I/O. Links and media are resolved through callbacks.
// Also returns each top-level block's text (chunks) and what each written link, image and mention
// stood for (refs), so the AsciiDoc parser can map them back to the live page (adoc-parse.ts).

import { walk, type AdfMark, type AdfNode, type Attrs } from './adf.ts';

export interface LinkResolution {
  url?: string;
  anchor?: string;
  xref?: string;
  fragment?: string;
  outOfScope?: boolean;
}

export interface MediaResolution {
  url?: string;
  path?: string;
  expected?: string;
  title?: string;
}

export interface ConvertReport {
  unsupported: Record<string, number>;
  missingMedia: string[];
  outOfScopeLinks: number;
  cellBackgrounds: number;
}

// What each written target stood for: links -> every href written that way, media -> the first
// media node, mentions -> the first mention's attrs.
export interface Refs {
  links: Map<string, Set<string>>;
  media: Map<string, AdfNode>;
  mentions: Map<string, Attrs>;
}

export interface Chunk {
  node: AdfNode;
  text: string;
}

export interface ConvertOptions {
  resolveLink?: (href: string) => LinkResolution;
  resolveMedia?: (attrs: Attrs) => MediaResolution;
}

export interface ConvertResult {
  body: string;
  toc: boolean;
  headingOffset: number;
  report: ConvertReport;
  chunks: Chunk[];
  refs: Refs;
}

interface Ctx {
  resolveLink: (href: string) => LinkResolution;
  resolveMedia: (attrs: Attrs) => MediaResolution;
  report: ConvertReport;
  refs: Refs;
  shortIds: Map<string, string>;
  headingOffset: number;
  state: { toc: boolean; ids: Set<string> };
  seps: string; // active table cell separators ('|' or '|!')
  sections: boolean; // section titles allowed here (false inside blocks)
  open: boolean; // inside an open block (open blocks cannot nest)
  delims: Record<string, number>; // nesting depth per delimiter character
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList', 'decisionList']);
const PANEL_STYLE: Record<string, string> = { info: 'NOTE', note: 'NOTE', success: 'TIP', warning: 'WARNING', error: 'CAUTION', custom: 'NOTE' };

// Lines that AsciiDoc would read as block syntax; prefixed with {empty} to keep them as text.
const LINE_RISK = new RegExp(
  [
    '^\\s', // indented first line -> literal paragraph
    '^(\\*+|\\.+|-)\\s', // list markers
    '^\\d+\\.\\s',
    '^[a-zA-Z]\\.\\s',
    '^[ivxIVX]+\\)\\s',
    '^<\\d+>\\s', // callout
    '^=+\\s', // section title
    '^\\.[^\\s.]', // block title
    '^\\/\\/', // comment
    '^\\[.*\\]$', // block attribute line
    '^\\[\\[', // anchor
    '^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\\s',
    '^:[\\w-]+!?:', // attribute entry
    "^'''",
    '^(\\*\\s*){3,}$',
    '^(-\\s*){3,}$',
    '^<<<',
    '^(\\*{4,}|={4,}|_{4,}|\\.{4,}|\\+{4,}|-{2,}|`{3,}|~{4,})$', // delimiters
    '^\\+$', // list continuation
    '^[|!]===',
    '^\\w+::\\S*\\[', // block macro
  ].join('|'),
);

export function convert(adf: AdfNode, opts: ConvertOptions = {}): ConvertResult {
  const state = { toc: false, ids: new Set<string>() };
  const ctx: Ctx = {
    resolveLink: opts.resolveLink || ((href) => ({ url: href })),
    resolveMedia: opts.resolveMedia || (() => ({})),
    report: { unsupported: {}, missingMedia: [], outOfScopeLinks: 0, cellBackgrounds: 0 },
    refs: { links: new Map(), media: new Map(), mentions: new Map() },
    shortIds: buildShortIds(adf),
    headingOffset: headingOffset(adf),
    state,
    seps: '',
    sections: true,
    open: false,
    delims: {},
  };
  const chunks: Chunk[] = [];
  const body = blocks(adf.content || [], ctx, true, chunks);
  return { body: body ? body + '\n' : '', toc: state.toc, headingOffset: ctx.headingOffset, report: ctx.report, chunks, refs: ctx.refs };
}

// ---------- blocks ----------

function blocks(nodes: AdfNode[], ctx: Ctx, top: boolean, chunks?: Chunk[]): string {
  const out: string[] = [];
  let prevList = false;
  for (const n of nodes) {
    const s = block(n, ctx, top);
    if (chunks) chunks.push({ node: n, text: s || '' });
    if (s === null || s === undefined || s === '') continue;
    const isList = LIST_TYPES.has(n.type);
    if (isList && prevList) out.push('//-'); // keep adjacent lists separate
    out.push(s);
    prevList = isList;
  }
  return out.join('\n\n');
}

function block(n: AdfNode, ctx: Ctx, top: boolean): string {
  switch (n.type) {
    case 'paragraph':
      return paragraph(n, ctx, top);
    case 'heading':
      return heading(n, ctx, top);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'decisionList':
      return list(n, ctx, 1, top);
    case 'codeBlock':
      return codeBlock(n, ctx, top);
    case 'blockquote':
      return delimited(ctx, '_', attrLine(ctx, n, top), (inner) => blocks(n.content || [], inner, false), { sections: false });
    case 'rule':
      return attrLine(ctx, n, top) + "'''";
    case 'panel': {
      const type = (n.attrs && n.attrs.panelType) || 'info';
      const head = attrLine(ctx, n, top, [PANEL_STYLE[type] || 'NOTE', 'panel=' + type]);
      return delimited(ctx, '=', head, (inner) => blocks(n.content || [], inner, true), { sections: false });
    }
    case 'expand':
    case 'nestedExpand': {
      const title = n.attrs && n.attrs.title;
      const head =
        (title ? '.' + blockTitle(title, ctx) + '\n' : '') +
        attrLine(ctx, n, top, ['%collapsible', n.type === 'nestedExpand' ? 'expand=nested' : '']);
      return delimited(ctx, '=', head, (inner) => blocks(n.content || [], inner, true), { sections: false });
    }
    case 'table':
      return table(n, ctx, top, []);
    case 'mediaSingle':
      return mediaSingle(n, ctx, top);
    case 'mediaGroup':
      return (n.content || []).map((m) => mediaBlock(m, ctx, top, {})).join('\n\n');
    case 'layoutSection':
      return layout(n, ctx);
    case 'extension':
      return extension(n, ctx, top);
    case 'bodiedExtension':
      return bodiedExtension(n, ctx, top);
    case 'blockCard':
    case 'embedCard':
      if (n.attrs && n.attrs.url) return attrLine(ctx, n, top, ['confluence=' + n.type]) + 'link:' + ref(ctx, 'links', 'link:' + escUrl(n.attrs.url, ctx), n.attrs.url) + '[]';
      return placeholder(n, ctx, top, n.type);
    default:
      return placeholder(n, ctx, top, n.type);
  }
}

function paragraph(n: AdfNode, ctx: Ctx, top: boolean): string {
  const text = inlines(n.content || [], ctx);
  return attrLine(ctx, n, top, blockRoles(n)) + (text === '' ? '{empty}' : escapeLines(text));
}

function heading(n: AdfNode, ctx: Ctx, top: boolean): string {
  const confluenceLevel = Math.min(Math.max((n.attrs && n.attrs.level) || 1, 1), 6);
  const level = Math.max(1, confluenceLevel - ctx.headingOffset);
  const plain = plainText(n).trim();
  let id = plain ? anchorId(plain.replace(/\s+/g, '-')) : null;
  if (id && ctx.state.ids.has(id)) id = null;
  if (id) ctx.state.ids.add(id);
  const text = inlines(n.content || [], ctx).replace(/ \+\n/g, ' ') || '{empty}';
  const section = ctx.sections && level <= 5;
  const roles = blockRoles(n).join('');
  const first = (section ? '' : 'discrete') + (id ? '#' + id : '') + roles;
  return attrLine(ctx, n, top, [first]) + '='.repeat(level + 1) + ' ' + text;
}

function list(n: AdfNode, ctx: Ctx, depth: number, top: boolean): string {
  const marker = (n.type === 'orderedList' ? '.' : '*').repeat(depth);
  const items: string[] = [];
  for (const li of n.content || []) {
    if (LIST_TYPES.has(li.type)) items.push(list(li, ctx, depth + 1, false));
    else items.push(listItem(li, ctx, marker, depth));
  }
  const attrs: string[] = [];
  if (n.type === 'decisionList') attrs.push('.decisions');
  if (n.type === 'orderedList' && n.attrs && n.attrs.order > 1) attrs.push('start=' + n.attrs.order);
  return attrLine(ctx, n, top, attrs) + items.join('\n');
}

function listItem(li: AdfNode, ctx: Ctx, marker: string, depth: number): string {
  if (li.type === 'taskItem' || li.type === 'decisionItem') {
    const box = li.type === 'taskItem' ? (li.attrs && li.attrs.state === 'DONE' ? '[x] ' : '[ ] ') : '';
    const text = inlines(li.content || [], ctx);
    return marker + ' ' + box + (text ? escapeLines(text) : '{empty}');
  }
  const kids = li.content || [];
  let head = '{empty}';
  let rest = kids;
  if (kids[0] && kids[0].type === 'paragraph' && !(kids[0].marks || []).length) {
    const text = inlines(kids[0].content || [], ctx);
    head = text ? escapeLines(text) : '{empty}';
    rest = kids.slice(1);
  }
  let s = marker + ' ' + head;
  let prevNested = false;
  const inner: Ctx = { ...ctx, sections: false };
  for (const k of rest) {
    if (LIST_TYPES.has(k.type)) {
      s += '\n' + list(k, inner, depth + 1, false);
      prevNested = true;
    } else {
      // blank line before '+' attaches the block to this item rather than the nested one
      s += (prevNested ? '\n\n+\n' : '\n+\n') + block(k, inner, false);
      prevNested = false;
    }
  }
  return s;
}

function codeBlock(n: AdfNode, ctx: Ctx, top: boolean): string {
  const text = (n.content || []).map((t) => t.text || '').join('');
  const lang = n.attrs && n.attrs.language;
  let len = 4;
  for (const line of text.split('\n')) if (/^-{4,}$/.test(line)) len = Math.max(len, line.length + 1);
  const d = '-'.repeat(len);
  const style = 'source' + (lang ? ',' + attrValue(lang) : '');
  const content = escSeps(text, ctx);
  return attrLine(ctx, n, top, [style]) + d + '\n' + (content ? content.replace(/\n$/, '') + '\n' : '') + d;
}

function table(n: AdfNode, ctx: Ctx, top: boolean, extra: string[]): string {
  if (ctx.seps.includes('!')) return placeholder(n, ctx, top, 'table-nested-too-deep');
  const sep = ctx.seps.includes('|') ? '!' : '|';
  const rows = (n.content || []).filter((r) => r.type === 'tableRow');
  const first = rows.length ? rows[0].content || [] : [];
  const span = (c: AdfNode): number => (c.attrs && c.attrs.colspan) || 1;
  const ncols = first.reduce((a, c) => a + span(c), 0) || 1;
  const widths: (number | null)[] = [];
  for (const c of first) {
    const w = c.attrs && c.attrs.colwidth;
    for (let i = 0; i < span(c); i++) widths.push(w && w[i] ? Math.round(w[i]) : null);
  }
  const cols = widths.length === ncols && widths.every(Boolean) ? widths.join(',') : new Array(ncols).fill('1').join(',');
  const cellCtx: Ctx = { ...ctx, seps: ctx.seps + sep, sections: false, open: false, delims: {} };
  const simple = (c: AdfNode): boolean => {
    const k = c.content || [];
    return k.length === 0 || (k.length === 1 && k[0].type === 'paragraph' && !(k[0].marks || []).length);
  };
  const headerRow = first.length > 0 && first.every((c) => c.type === 'tableHeader' && simple(c));

  const rowText = rows.map((row, ri) =>
    (row.content || [])
      .map((c) => {
        const a = c.attrs || {};
        if (a.background) ctx.report.cellBackgrounds++;
        const cs = a.colspan > 1 ? a.colspan : 0;
        const rs = a.rowspan > 1 ? a.rowspan : 0;
        let spec = cs || rs ? (cs || '') + (rs ? '.' + rs : '') + '+' : '';
        if (!simple(c)) return spec + 'a' + sep + '\n' + blocks(c.content || [], cellCtx, false);
        if (c.type === 'tableHeader' && !(ri === 0 && headerRow)) spec += 'h';
        const k = c.content || [];
        const text = k.length ? inlines(k[0].content || [], cellCtx) : '';
        return spec + sep + text;
      })
      .join('\n'),
  );
  const items = [headerRow ? '%header' : '', 'cols="' + cols + '"', ...extra];
  const d = sep + '===';
  return attrLine(ctx, n, top, items) + d + '\n' + rowText.join('\n\n') + '\n' + d;
}

function mediaSingle(n: AdfNode, ctx: Ctx, top: boolean): string {
  const media = (n.content || []).find((c) => c.type === 'media');
  if (!media) return placeholder(n, ctx, top, 'mediaSingle');
  const caption = (n.content || []).find((c) => c.type === 'caption');
  const a = n.attrs || {};
  const extra: string[] = [];
  if (a.layout === 'center') extra.push('align=center');
  else if (a.layout === 'wrap-left' || a.layout === 'align-start') extra.push('float=left');
  else if (a.layout === 'wrap-right' || a.layout === 'align-end') extra.push('float=right');
  const width = a.widthType === 'pixel' && a.width ? Math.round(a.width) : null;
  const title = caption ? '.' + blockTitle(plainText(caption), ctx) + '\n' : '';
  return mediaBlock(media, ctx, top, { width, extra, title });
}

function mediaBlock(m: AdfNode, ctx: Ctx, top: boolean, opt: { width?: number | null; extra?: string[]; title?: string }): string {
  const a = m.attrs || {};
  const r = ctx.resolveMedia(a) || {};
  const alt: string = a.alt || r.title || 'image';
  let pre = '';
  let target = r.path || r.url;
  if (!target) {
    ctx.report.missingMedia.push(alt);
    pre = '// confluence: image not attached to this page: ' + alt + '\n';
    target = r.expected || missingTarget(alt);
  }
  ref(ctx, 'media', target, m);
  const items = [quote(escSeps(alt, ctx))];
  if (opt.width) items.push('width=' + opt.width);
  items.push(...(opt.extra || []));
  return pre + (opt.title || '') + attrLine(ctx, m, top) + 'image::' + target + '[' + items.join(',') + ']';
}

function missingTarget(alt: string): string {
  return '_attachments/missing/' + alt.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function layout(n: AdfNode, ctx: Ctx): string {
  const id = (x: AdfNode): string => (x.attrs && x.attrs.localId ? ' adf=' + ctx.shortIds.get(x.attrs.localId) : '');
  const parts = ['// confluence:layout-section' + id(n)];
  for (const col of n.content || []) {
    const width = col.attrs && col.attrs.width ? ' width=' + col.attrs.width : '';
    parts.push('// confluence:layout-column' + id(col) + width);
    const b = blocks(col.content || [], ctx, true);
    if (b) parts.push(b);
  }
  parts.push('// confluence:layout-end');
  return parts.join('\n\n');
}

function extension(n: AdfNode, ctx: Ctx, top: boolean): string {
  const a = n.attrs || {};
  const key = a.extensionKey;
  if (key === 'toc' && !ctx.state.toc) {
    ctx.state.toc = true;
    return 'toc::[' + (top && a.localId ? 'adf=' + ctx.shortIds.get(a.localId) : '') + ']';
  }
  if (key === 'nested-table') {
    let doc: AdfNode | null = null;
    try {
      doc = JSON.parse(a.parameters && a.parameters.adf);
    } catch {
      doc = null;
    }
    const content = (doc && doc.content) || [];
    if (content.length === 1 && content[0].type === 'table') {
      return table(content[0], ctx, false, ['confluence=nested-table']);
    }
  }
  return placeholder(n, ctx, top, key);
}

function bodiedExtension(n: AdfNode, ctx: Ctx, top: boolean): string {
  const key: string = (n.attrs && n.attrs.extensionKey) || 'unknown';
  const kind = key === 'details' || key === 'excerpt' ? key : 'bodied-extension';
  const items = ['confluence=' + kind];
  if (kind === 'bodied-extension') items.push('key=' + attrValue(key));
  const head = attrLine(ctx, n, top, items);
  if (!ctx.open) {
    const body = blocks(n.content || [], { ...ctx, open: true }, true);
    return head + '--\n' + (body ? body + '\n' : '') + '--';
  }
  return delimited(ctx, '=', head, (inner) => blocks(n.content || [], inner, true), {});
}

function placeholder(n: AdfNode, ctx: Ctx, top: boolean, key: string): string {
  ctx.report.unsupported[key] = (ctx.report.unsupported[key] || 0) + 1;
  const label = placeholderLabel(n, key);
  const items = ['confluence=' + n.type];
  if (key && key !== n.type) items.push('key=' + attrValue(key));
  return attrLine(ctx, n, top, items) + '....\n' + escSeps(label, ctx) + '\n....';
}

export function placeholderLabel(n: AdfNode, key: string): string {
  const params = n.attrs && n.attrs.parameters;
  const title = params && params.macroMetadata && params.macroMetadata.title;
  return 'Confluence ' + (title ? 'macro "' + title + '"' : n.type) + (key && key !== n.type ? ' (' + key + ')' : '') + '. Edit in Confluence.';
}

function delimited(ctx: Ctx, ch: string, head: string, render: (inner: Ctx) => string, over: Partial<Ctx>): string {
  const depth = ctx.delims[ch] || 0;
  const d = ch.repeat(4 + depth);
  const inner: Ctx = { ...ctx, ...over, delims: { ...ctx.delims, [ch]: depth + 1 } };
  const body = render(inner);
  return head + d + '\n' + (body ? body + '\n' : '') + d;
}

// ---------- inlines ----------

function inlines(nodes: AdfNode[], ctx: Ctx): string {
  let out = '';
  for (let i = 0; i < nodes.length; ) {
    const href = linkHref(nodes[i]);
    if (href) {
      let j = i;
      let inner = '';
      while (j < nodes.length && linkHref(nodes[j]) === href) inner += textNode(nodes[j++], ctx);
      out += link(href, inner, ctx);
      i = j;
      continue;
    }
    const n = nodes[i++];
    if (n.type === 'hardBreak') out += (out === '' || out.endsWith('\n') ? '{empty}' : '') + ' +\n';
    else out += inline(n, ctx);
  }
  return out;
}

function inline(n: AdfNode, ctx: Ctx): string {
  const a = n.attrs || {};
  switch (n.type) {
    case 'text':
      return textNode(n, ctx);
    case 'mention':
      ref(ctx, 'mentions', a.text || '@' + a.id, a);
      return '[.mention]##' + escapeText(a.text || '@' + a.id, ctx) + '##';
    case 'status':
      return '[.status-' + (a.color || 'neutral') + ']##' + escapeText(a.text || '', ctx) + '##';
    case 'date': {
      const d = new Date(Number(a.timestamp));
      return '[.date]##' + (isNaN(d.getTime()) ? escapeText(String(a.timestamp), ctx) : d.toISOString().slice(0, 10)) + '##';
    }
    case 'emoji':
      return escapeText(a.text || a.shortName || '', ctx);
    case 'inlineCard':
      return a.url ? '[.card]##' + link(a.url, '', ctx) + '##' : '';
    case 'placeholder':
      return escapeText(a.text || '', ctx);
    case 'mediaInline': {
      const r = ctx.resolveMedia(a) || {};
      const target = r.path || r.url || r.expected || missingTarget(a.alt || 'image');
      if (!r.path && !r.url) ctx.report.missingMedia.push(a.alt || 'image');
      ref(ctx, 'media', target, n);
      return 'image:' + target + '[' + quote(escSeps(a.alt || 'image', ctx)) + ']';
    }
    case 'inlineExtension':
      ctx.report.unsupported[a.extensionKey || 'inlineExtension'] = (ctx.report.unsupported[a.extensionKey || 'inlineExtension'] || 0) + 1;
      return '[.confluence-extension]##' + escapeText(a.extensionKey || 'extension', ctx) + '##';
    default:
      ctx.report.unsupported[n.type] = (ctx.report.unsupported[n.type] || 0) + 1;
      return '[.confluence-unsupported]##' + escapeText(n.type, ctx) + '##';
  }
}

function linkHref(n: AdfNode | undefined): string | null {
  if (!n || n.type !== 'text') return null;
  const m = (n.marks || []).find((x) => x.type === 'link');
  return m && m.attrs && m.attrs.href ? m.attrs.href : null;
}

function textNode(n: AdfNode, ctx: Ctx): string {
  const marks = (n.marks || []).filter((m) => m.type !== 'link');
  const text = n.text || '';
  if (!marks.length) return escapeText(text, ctx);
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!m[2]) return escapeText(text, ctx);
  return m[1] + formatted(m[2], marks, ctx) + m[3];
}

function formatted(t: string, marks: AdfMark[], ctx: Ctx): string {
  const has = (type: string) => marks.find((x) => x.type === type);
  let s = has('code') ? codeSpan(t, ctx) : escapeText(t, ctx);
  if (has('em')) s = '__' + s + '__';
  if (has('strong')) s = '**' + s + '**';
  const sub = has('subsup');
  if (sub) {
    const ch = sub.attrs && sub.attrs.type === 'sup' ? '^' : '~';
    s = /\s/.test(t) ? '[.' + (ch === '^' ? 'sup' : 'sub') + ']##' + s + '##' : ch + s + ch;
  }
  const roles: string[] = [];
  for (const m of marks) {
    const color = m.attrs && m.attrs.color ? String(m.attrs.color).replace(/[^A-Za-z0-9]/g, '').toLowerCase() : '';
    if (m.type === 'strike') roles.push('line-through');
    else if (m.type === 'underline') roles.push('underline');
    else if (m.type === 'textColor') roles.push('text-color-' + color);
    else if (m.type === 'backgroundColor') roles.push('bg-color-' + color);
    else if (!['code', 'em', 'strong', 'subsup'].includes(m.type)) ctx.report.unsupported['mark:' + m.type] = (ctx.report.unsupported['mark:' + m.type] || 0) + 1;
  }
  if (roles.length) s = '[.' + roles.join('.') + ']##' + s + '##';
  return s;
}

function codeSpan(t: string, ctx: Ctx): string {
  let inner = t;
  if (/[*_`#^~+[\]{}<\\&]|::|;;/.test(t)) inner = t.includes('+') ? 'pass:c[' + t.replace(/]/g, '\\]') + ']' : '++' + t + '++';
  return '``' + escSeps(inner, ctx) + '``';
}

function link(href: string, inner: string, ctx: Ctx): string {
  const r = ctx.resolveLink(href) || { url: href };
  if (r.anchor !== undefined) {
    const id = anchorId(decode(r.anchor));
    ref(ctx, 'links', '<<' + id, href);
    return '<<' + id + (inner ? ',' + inner.replace(/>>/g, '&gt;&gt;') : '') + '>>';
  }
  if (r.xref) {
    const target = r.xref + (r.fragment ? '#' + anchorId(decode(r.fragment)) : '');
    ref(ctx, 'links', 'xref:' + target, href);
    return 'xref:' + target + '[' + linkText(inner) + ']';
  }
  if (r.outOfScope) ctx.report.outOfScopeLinks++;
  const url = escUrl(r.url || href, ctx);
  ref(ctx, 'links', 'link:' + url, href);
  return 'link:' + url + '[' + linkText(inner) + ']';
}

function linkText(inner: string): string {
  const t = inner.replace(/]/g, '\\]');
  return t.includes('=') ? '"' + t.replace(/"/g, '\\"') + '"' : t;
}

// ---------- escaping ----------

function escapeText(s: string, ctx: Ctx): string {
  const out = s
    .split(/(\s+)/)
    .map((tok) => (tok === '' || /^\s+$/.test(tok) ? tok : escToken(tok)))
    .join('');
  return escSeps(out, ctx);
}

function escToken(t: string): string {
  if (t === '+') return '{plus}';
  if (!riskyToken(t)) return t;
  return t.includes('+') ? 'pass:c[' + t.replace(/]/g, '\\]') + ']' : '++' + t + '++';
}

function riskyToken(t: string): boolean {
  const core = t.replace(/^[("'“‘]+/, '').replace(/[)"'”’.,:;!?]+$/, '');
  return (
    /[*_#]{2}/.test(t) ||
    /^[*_#]|[*_#]$/.test(core) ||
    /`/.test(t) ||
    /\+\+|^\+.*\+$/.test(core) ||
    /\^[^\s^]+\^|~[^\s~]+~/.test(t) ||
    /\[\[|]]|\[[.#%]|][#*_`]/.test(t) ||
    /\w:[^\s[]*\[/.test(t) ||
    /\{[A-Za-z0-9_][\w-]*\}/.test(t) ||
    /<</.test(t) ||
    /\\[*_`#^~+[\]{}<]/.test(t) ||
    /&(#\d+|#x[0-9a-f]+|\w+);/i.test(t) ||
    /::|;;/.test(t)
  );
}

function escapeLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (LINE_RISK.test(line) ? '{empty}' + line : line))
    .join('\n');
}

function escSeps(s: string, ctx: Ctx): string {
  let out = s;
  for (const ch of ctx.seps) out = out.split(ch).join('\\' + ch);
  return out;
}

function escUrl(url: string, ctx: Ctx): string {
  let u = String(url).replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/]/g, '%5D');
  if (ctx.seps.includes('|')) u = u.replace(/\|/g, '%7C');
  if (ctx.seps.includes('!')) u = u.replace(/!/g, '%21');
  return u;
}

function blockTitle(t: string, ctx: Ctx): string {
  const s = escapeText(String(t).replace(/\s*\n\s*/g, ' '), ctx);
  return /^[\s.]/.test(s) || s === '' ? '{empty}' + s : s;
}

// ---------- helpers ----------

function ref(ctx: Ctx, kind: 'links', key: string, value: string): string;
function ref(ctx: Ctx, kind: 'media', key: string, value: AdfNode): string;
function ref(ctx: Ctx, kind: 'mentions', key: string, value: Attrs): string;
function ref(ctx: Ctx, kind: keyof Refs, key: string, value: any): string {
  if (kind === 'links') {
    const m = ctx.refs.links;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(value);
  } else {
    const m: Map<string, unknown> = ctx.refs[kind];
    if (!m.has(key)) m.set(key, value);
  }
  return key.startsWith('link:') ? key.slice(5) : key;
}

function attrLine(ctx: Ctx, n: AdfNode, top: boolean, items: string[] = []): string {
  const all = items.filter(Boolean);
  const id = top && n.attrs && n.attrs.localId;
  if (id) all.push('adf=' + ctx.shortIds.get(id));
  return all.length ? '[' + all.join(',') + ']\n' : '';
}

function blockRoles(n: AdfNode): string[] {
  const roles: string[] = [];
  for (const m of n.marks || []) {
    if (m.type === 'alignment' && m.attrs) roles.push('.text-' + m.attrs.align);
    else if (m.type === 'indentation' && m.attrs) roles.push('.indent-' + m.attrs.level);
  }
  return roles.length ? [roles.join('')] : [];
}

function attrValue(v: string): string {
  return /^[\w.-]+$/.test(v) ? v : quote(v);
}

function quote(v: string): string {
  return '"' + String(v).replace(/"/g, '\\"') + '"';
}

export function anchorId(s: string): string {
  const id = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : '_' + id;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function plainText(n: AdfNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.text || '';
  if (n.attrs && n.attrs.text && (n.type === 'mention' || n.type === 'status' || n.type === 'emoji')) return n.attrs.text;
  return (n.content || []).map(plainText).join('');
}

export function buildShortIds(adf: AdfNode): Map<string, string> {
  const all: string[] = [];
  walk(adf, (n) => {
    if (n.attrs && n.attrs.localId) all.push(n.attrs.localId);
  });
  const count = new Map<string, number>();
  for (const id of all) count.set(id.slice(0, 8), (count.get(id.slice(0, 8)) || 0) + 1);
  const map = new Map<string, string>();
  for (const id of all) map.set(id, count.get(id.slice(0, 8))! > 1 ? id : id.slice(0, 8));
  return map;
}

function headingOffset(adf: AdfNode): number {
  let min = 7;
  walk(adf, (n) => {
    if (n.type === 'heading' && n.attrs && n.attrs.level) min = Math.min(min, n.attrs.level);
  });
  return min === 7 ? 0 : min - 1;
}

export function isEmptyDoc(adf: AdfNode | null | undefined): boolean {
  const meaningful = (n: AdfNode) => !(n.type === 'paragraph' && !(n.content || []).length);
  return !(adf && adf.content && adf.content.some(meaningful));
}
