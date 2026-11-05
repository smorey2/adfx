// Patch a live page with an edited AsciiDoc file (ADR-0005 §4). Never regenerates the page: each
// block read from the file is paired with a live block (by adf= id, then by text, then by position);
// blocks that read back the same are copied byte for byte, changed blocks are rebuilt with the live
// block's hidden data (local IDs, cell colours and widths, macro settings) carried over.
import { parse, meta } from "./adoc-parse.js";
import { placeholderLabel } from "./adoc.js";
// Marks AsciiDoc can express. Others (breakout, border, fragment, annotation) are carried over.
const OWNED_MARKS = new Set(['strong', 'em', 'code', 'strike', 'underline', 'textColor', 'backgroundColor', 'subsup', 'link', 'alignment', 'indentation']);
// Macros a new page may contain, built from nothing. Everything else is added in Confluence.
const NEW_MACROS = {
    toc: () => ({
        type: 'extension',
        attrs: {
            extensionType: 'com.atlassian.confluence.macro.core',
            extensionKey: 'toc',
            parameters: { macroParams: {}, macroMetadata: { schemaVersion: { value: '1' }, title: 'Table of Contents' } },
        },
    }),
};
export function buildPatch({ liveAdf, conv, body, parseOpts, shortIds, newPage = false }) {
    const parsed = parse(body, { ...parseOpts, refs: conv.refs });
    const env = { refs: conv.refs, shortIds, errors: [...parsed.errors], newMacros: newPage };
    const oldNodes = liveAdf.content || [];
    const newNodes = parsed.blocks.map((b) => b.node);
    const pair = alignPairs(newNodes, oldNodes, env);
    const usedOld = new Set(pair.filter((j) => j >= 0));
    // Blocks that convert() writes nothing for cannot be seen in the file; keep them where they were.
    const invisible = new Set(oldNodes.map((_, j) => j).filter((j) => !conv.chunks[j] || conv.chunks[j].text === ''));
    const keepAfter = (j) => {
        const out = [];
        for (let k = j + 1; k < oldNodes.length && invisible.has(k) && !usedOld.has(k); k++)
            out.push(oldNodes[k]);
        return out;
    };
    const content = [...keepAfter(-1)];
    const changes = [];
    newNodes.forEach((n, i) => {
        const j = pair[i];
        if (j >= 0) {
            const r = recover(n, oldNodes[j], env);
            if (r)
                content.push(r);
            if (r !== oldNodes[j])
                changes.push({ kind: 'changed', old: j, new: i });
            content.push(...keepAfter(j));
        }
        else {
            const r = fresh(n, env);
            if (r) {
                content.push(r);
                changes.push({ kind: 'added', new: i });
            }
        }
    });
    oldNodes.forEach((_, j) => {
        if (!usedOld.has(j) && !invisible.has(j))
            changes.push({ kind: 'removed', old: j });
    });
    const order = pair.filter((j) => j >= 0);
    const moved = order.some((j, k) => k > 0 && j < order[k - 1]);
    // Fidelity gate (ADR-0005 §4.6): a block is only rebuilt if its live version reads back exactly.
    for (const c of changes) {
        if (c.kind !== 'changed')
            continue;
        const j = c.old;
        const g = gate(oldNodes[j], conv.chunks[j].text, { ...parseOpts, refs: conv.refs }, env);
        if (!g.ok)
            env.errors.push(`block ${j + 1} (${describe(oldNodes[j], env)}) cannot be rebuilt without changing it: ${g.why}. Edit it in Confluence.`);
    }
    // Paired nodes keep all their hidden data, so the only silent loss is an inline comment whose text
    // was edited or deleted (the comment thread stays in Confluence, unanchored).
    const before = comments(oldNodes);
    const after = comments(content);
    const losses = [...before].filter(([id]) => !after.has(id)).map(([id, t]) => `inline comment on "${t.length > 40 ? t.slice(0, 40) + '…' : t}" (${id.slice(0, 8)})`);
    return {
        adf: { ...liveAdf, content },
        changes,
        moved,
        errors: env.errors,
        losses,
        oldText: (j) => conv.chunks[j].text,
        newText: (i) => parsed.blocks[i].text,
        describeOld: (j) => describe(oldNodes[j], env),
    };
}
// Does the live block survive AsciiDoc and back unchanged?
export function gate(node, chunkText, parseOpts, env) {
    const p = parse(chunkText, parseOpts);
    if (p.errors.length)
        return { ok: false, why: p.errors[0] };
    if (p.blocks.length !== 1)
        return { ok: false, why: `it reads back as ${p.blocks.length} blocks` };
    const e = { ...env, errors: [] };
    const r = recover(p.blocks[0].node, node, e);
    if (r === node)
        return { ok: true };
    return { ok: false, why: e.errors[0] || firstDiff(norm(node), norm(r), '') };
}
// ---------- recovery ----------
export function recover(n, o, env) {
    if (!o)
        return fresh(n, env);
    const m = meta(n);
    if (m.placeholder) {
        if (o.type !== n.type)
            return fresh(n, env);
        const key = o.type === 'extension' && o.attrs ? o.attrs.extensionKey : m.placeholder;
        if (key !== m.placeholder || m.label !== placeholderLabel(o, m.placeholder))
            env.errors.push(`the "${m.placeholder}" macro placeholder was edited; it can only be changed in Confluence`);
        return o;
    }
    if (m.macro) {
        if (o.type !== n.type || !o.attrs || o.attrs.extensionKey !== n.attrs.extensionKey)
            return fresh(n, env);
        if (n.type === 'extension')
            return o;
        const r = { ...o, content: alignChildren(n.content || [], o.content || [], env) };
        return same(r, o) ? o : r;
    }
    if (m.nestedTable) {
        if (o.type !== 'extension' || !o.attrs || o.attrs.extensionKey !== 'nested-table')
            return fresh(n, env);
        let inner = null;
        try {
            inner = JSON.parse(o.attrs.parameters.adf).content[0];
        }
        catch {
            inner = null;
        }
        const r = recover(m.nestedTable, inner, { ...env, errors: [] });
        if (r === inner)
            return o;
        env.errors.push('a nested table was edited; nested tables can only be edited in Confluence');
        return o;
    }
    let type = n.type;
    if (n.type !== o.type) {
        if (compatible(n, o))
            type = o.type;
        else
            return fresh(n, env);
    }
    const r = { type };
    const attrs = { ...(o.attrs || {}) };
    for (const [k, v] of Object.entries(n.attrs || {})) {
        if (v === undefined)
            delete attrs[k];
        else
            attrs[k] = v;
    }
    if (type === 'mediaSingle' && n.attrs && n.attrs.layout && o.attrs && layoutCategory(o.attrs.layout) === n.attrs.layout)
        attrs.layout = o.attrs.layout;
    if (type === 'date' && o.attrs && m.day && isoDay(o.attrs.timestamp) === m.day)
        attrs.timestamp = o.attrs.timestamp;
    if (Object.keys(attrs).length)
        r.attrs = attrs;
    if (n.type === 'text')
        r.text = n.text;
    const marks = mergeMarks(n, o, env);
    if (marks.length)
        r.marks = marks;
    if (n.content)
        r.content = alignChildren(carryMarks(n.content, o.content || []), o.content || [], env);
    // convert() writes captions as plain text and line breaks in headings as spaces
    if (type === 'caption' && plainText(n) === plainText(o))
        r.content = o.content;
    if (type === 'heading' && o.content && str({ type: 'p', content: r.content || [] }) === str({ type: 'p', content: o.content.map((c) => (c.type === 'hardBreak' ? { type: 'text', text: ' ' } : c)) }))
        r.content = o.content;
    if (type === 'codeBlock') {
        // convert() writes a final newline whether or not the code had one
        const nt = (r.content && r.content[0] && r.content[0].text) || '';
        const ot = (o.content && o.content[0] && o.content[0].text) || '';
        if (ot === nt + '\n')
            r.content = o.content;
    }
    return same(r, o) ? o : r;
}
// A node with nothing to pair with.
function fresh(n, env) {
    const m = meta(n);
    if (m.placeholder) {
        env.errors.push(`"${m.placeholder}" placeholder does not match a macro on the live page; macros can only be added in Confluence`);
        return null;
    }
    if (m.macro) {
        if (env.newMacros && NEW_MACROS[m.macro] && n.type === 'extension')
            return NEW_MACROS[m.macro]();
        env.errors.push(env.newMacros
            ? `new "${m.macro}" macro: a new page can only include ${Object.keys(NEW_MACROS).join(', ')}; add other macros in Confluence after the first push`
            : `new "${m.macro}" macro: macros can only be added in Confluence`);
        return null;
    }
    if (m.nestedTable) {
        env.errors.push('new nested table: nested tables can only be added in Confluence');
        return null;
    }
    const r = { type: n.type };
    if (n.attrs) {
        const a = {};
        for (const [k, v] of Object.entries(n.attrs))
            if (v !== undefined)
                a[k] = v;
        if (m.colwidth)
            a.colwidth = m.colwidth;
        if (Object.keys(a).length)
            r.attrs = a;
    }
    if (n.type === 'text')
        r.text = n.text;
    if (n.marks && n.marks.length)
        r.marks = n.marks.map((x) => ({ type: x.type, ...(x.attrs ? { attrs: { ...x.attrs } } : {}) }));
    if (n.content)
        r.content = n.content.map((c) => fresh(c, env)).filter((c) => Boolean(c));
    return r;
}
// AsciiDoc cannot show marks like inline comments, so text written as one run may have been several
// text nodes. Map each such mark's text range from the live inline content onto the new content;
// where that text is still there unchanged, split the new text at the same places and carry the mark.
function carryMarks(nk, ok) {
    if (!nk.some((c) => c.type === 'text'))
        return nk;
    const OBJ = '￼';
    const carried = [];
    let oldText = '';
    for (const o of ok) {
        const s = o.type === 'text' ? o.text || '' : OBJ;
        const extra = o.type === 'text' ? (o.marks || []).filter((m) => !OWNED_MARKS.has(m.type)) : [];
        if (extra.length && s)
            carried.push({ from: oldText.length, to: oldText.length + s.length, marks: extra });
        oldText += s;
    }
    if (!carried.length)
        return nk;
    const newText = nk.map((c) => (c.type === 'text' ? c.text : OBJ)).join('');
    const map = charMap(oldText, newText);
    const cuts = [];
    for (const c of carried) {
        const a = map[c.from];
        let ok2 = a >= 0;
        for (let k = c.from; ok2 && k < c.to; k++)
            ok2 = map[k] === a + (k - c.from);
        if (ok2)
            cuts.push({ from: a, to: a + (c.to - c.from), marks: c.marks });
    }
    if (!cuts.length)
        return nk;
    const out = [];
    let pos = 0;
    for (const c of nk) {
        if (c.type !== 'text') {
            out.push(c);
            pos += 1;
            continue;
        }
        const t = c.text || '';
        const start = pos;
        const end = pos + t.length;
        const bounds = new Set([start, end]);
        for (const x of cuts)
            for (const b of [x.from, x.to])
                if (b > start && b < end)
                    bounds.add(b);
        const bs = [...bounds].sort((a, b) => a - b);
        for (let k = 0; k < bs.length - 1; k++) {
            const marks = [...(c.marks || [])];
            for (const x of cuts)
                if (x.from <= bs[k] && bs[k + 1] <= x.to)
                    marks.push(...x.marks);
            const node = { type: 'text', text: t.slice(bs[k] - start, bs[k + 1] - start) };
            if (marks.length)
                node.marks = marks;
            out.push(node);
        }
        pos = end;
    }
    return out;
}
// For each index in a, the index of the same character in b (or -1): common prefix and suffix, and a
// character LCS of the middle when it is small enough.
function charMap(a, b) {
    const map = new Int32Array(a.length).fill(-1);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p])
        map[p] = p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
        map[a.length - 1 - s] = b.length - 1 - s;
        s++;
    }
    const ma = a.slice(p, a.length - s);
    const mb = b.slice(p, b.length - s);
    if (ma.length && mb.length && ma.length * mb.length <= 4e6)
        for (const [i, j] of lcs([...ma], [...mb]))
            map[p + i] = p + j;
    return map;
}
function compatible(n, o) {
    if (n.type === o.type)
        return true;
    // AsciiDoc has no "header + AsciiDoc content" cell style, so such header cells come back as cells
    return n.type === 'tableCell' && o.type === 'tableHeader' && meta(n).cellStyle === 'a';
}
function mergeMarks(n, o, env) {
    const nm = n.marks || [];
    const om = o.marks || [];
    const used = new Set();
    const out = nm.map((m) => {
        const k = om.findIndex((x, i) => !used.has(i) && x.type === m.type && equivMark(m, x, env));
        if (k >= 0) {
            used.add(k);
            return om[k];
        }
        return { type: m.type, ...(m.attrs ? { attrs: { ...m.attrs } } : {}) };
    });
    om.forEach((x, i) => {
        if (used.has(i) || OWNED_MARKS.has(x.type))
            return;
        if (x.type === 'annotation' && n.type === 'text' && n.text !== o.text)
            return; // comment lost with its text
        out.push(x);
    });
    if (out.length === om.length && out.every((x) => om.includes(x)))
        return om;
    return out;
}
function equivMark(m, x, env) {
    const a = m.attrs || {};
    const b = x.attrs || {};
    switch (m.type) {
        case 'link': {
            if (a.href === b.href)
                return true;
            const k = meta(m).key;
            const set = env.refs && k !== undefined ? env.refs.links.get(k) : undefined;
            return Boolean(set && set.has(b.href));
        }
        case 'textColor':
        case 'backgroundColor':
            return normColor(a.color) === normColor(b.color);
        case 'subsup':
            return a.type === b.type;
        case 'alignment':
            return a.align === b.align;
        case 'indentation':
            return a.level === b.level;
        default:
            return true;
    }
}
function alignChildren(nk, ok, env) {
    const pair = alignPairs(nk, ok, env);
    return nk.map((k, i) => (pair[i] >= 0 ? recover(k, ok[pair[i]], env) : fresh(k, env))).filter((c) => Boolean(c));
}
// Pair new children with old: by adf= id, then longest common subsequence of (type, text), then by
// position between those pairs. Returns, for each new child, the old index or -1.
function alignPairs(nk, ok, env) {
    const old = ok || [];
    const pair = new Array(nk.length).fill(-1);
    const used = new Set();
    nk.forEach((k, i) => {
        const id = meta(k).adf;
        if (!id)
            return;
        const j = old.findIndex((o, jj) => !used.has(jj) && shortIdOf(o, env) === id);
        if (j >= 0) {
            pair[i] = j;
            used.add(j);
        }
    });
    const ni = nk.map((_, i) => i).filter((i) => pair[i] < 0);
    const oj = old.map((_, j) => j).filter((j) => !used.has(j));
    for (const [a, b] of lcs(ni.map((i) => key(nk[i])), oj.map((j) => key(old[j])))) {
        if (compatible(nk[ni[a]], old[oj[b]])) {
            pair[ni[a]] = oj[b];
            used.add(oj[b]);
        }
    }
    let last = -1;
    for (let i = 0; i < nk.length; i++) {
        if (pair[i] >= 0) {
            last = pair[i];
            continue;
        }
        let next = old.length;
        for (let k = i + 1; k < nk.length; k++)
            if (pair[k] >= 0) {
                next = pair[k];
                break;
            }
        for (let j = last + 1; j < next; j++)
            if (!used.has(j) && compatible(nk[i], old[j])) {
                pair[i] = j;
                used.add(j);
                last = j;
                break;
            }
    }
    return pair;
}
function shortIdOf(o, env) {
    const id = o.attrs && o.attrs.localId;
    if (id)
        return env.shortIds.get(id);
    if (o.type === 'mediaSingle') {
        const media = (o.content || []).find((c) => c.type === 'media');
        if (media && media.attrs && media.attrs.localId)
            return env.shortIds.get(media.attrs.localId);
    }
    return undefined;
}
function key(n) {
    return n.type + '|' + plainText(n);
}
export function lcs(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n || !m)
        return [];
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    for (let i = 0, j = 0; i < n && j < m;) {
        if (a[i] === b[j]) {
            out.push([i, j]);
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1])
            i++;
        else
            j++;
    }
    return out;
}
// ---------- comparison ----------
const normCache = new WeakMap();
const strCache = new WeakMap();
export function same(a, b) {
    return a === b || str(a) === str(b);
}
function str(n) {
    if (n && typeof n === 'object' && strCache.has(n))
        return strCache.get(n);
    const s = JSON.stringify(norm(n));
    if (n && typeof n === 'object')
        strCache.set(n, s);
    return s;
}
// Canonical form: sorted keys, no undefined/empty attrs, marks sorted, adjacent text with the same
// marks merged, and whitespace at the edges of formatted text unformatted (as AsciiDoc writes it).
export function norm(n) {
    if (Array.isArray(n))
        return n.map(norm);
    if (!n || typeof n !== 'object')
        return n;
    if (normCache.has(n))
        return normCache.get(n);
    const src = n;
    const o = {};
    for (const k of Object.keys(src).sort()) {
        let v = src[k];
        if (v === undefined)
            continue;
        if (k === 'content' && Array.isArray(v)) {
            v = normContent(v);
            if (!v.length)
                continue;
        }
        else if (k === 'marks' && Array.isArray(v)) {
            v = v.map(norm).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
            if (!v.length)
                continue;
        }
        else if (v && typeof v === 'object') {
            v = norm(v);
            if (k === 'attrs' && !Object.keys(v).length)
                continue;
        }
        o[k] = v;
    }
    normCache.set(n, o);
    return o;
}
function normContent(list) {
    const out = [];
    const push = (t) => {
        if (t.text === '')
            return;
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text' && t.type === 'text' && JSON.stringify(prev.marks || []) === JSON.stringify(t.marks || [])) {
            out[out.length - 1] = { ...prev, text: prev.text + t.text };
            return;
        }
        out.push(t);
    };
    for (const c of list) {
        const n = norm(c);
        if (n && n.type === 'text' && n.marks && n.marks.some((m) => m.type !== 'link')) {
            const mm = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text || '');
            const edge = n.marks.filter((m) => m.type === 'link');
            const withMarks = (text, marks) => (marks.length ? { marks, text, type: 'text' } : { text, type: 'text' });
            if (mm[1])
                push(withMarks(mm[1], edge));
            push({ ...n, text: mm[2] });
            if (mm[3])
                push(withMarks(mm[3], edge));
        }
        else
            push(n);
    }
    return out;
}
function firstDiff(a, b, path) {
    if (JSON.stringify(a) === JSON.stringify(b))
        return null;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        for (const k of keys) {
            const d = firstDiff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : `.${k}`));
            if (d)
                return d;
        }
    }
    const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80));
    return `${path || 'block'} is ${show(a)} on the page but would become ${show(b)}`;
}
// ---------- reporting ----------
// What the write would change, as paths into the page: "expand[17] › table[2] › tableRow[+2] added".
export function adfChanges(a, b, path = '', out = []) {
    const J = (x) => JSON.stringify(x);
    const short = (x) => (x === undefined ? 'nothing' : J(x).length > 60 ? J(x).slice(0, 60) + '…' : J(x));
    if (J(a) === J(b))
        return out;
    if (Array.isArray(a) && Array.isArray(b)) {
        const ja = a.map(J);
        const jb = b.map(J);
        const pairs = lcs(ja, jb);
        const seg = (x, i) => `${path}${path ? ' › ' : ''}${(x && x.type) || 'item'}[${i}]`;
        let pi = 0;
        let pj = 0;
        for (const [ei, ej] of [...pairs, [a.length, b.length]]) {
            const ra = [];
            const rb = [];
            for (; pi < ei; pi++)
                ra.push(pi);
            for (; pj < ej; pj++)
                rb.push(pj);
            const n = Math.min(ra.length, rb.length);
            for (let k = 0; k < n; k++) {
                const x = a[ra[k]];
                const y = b[rb[k]];
                if (x && y && x.type === y.type)
                    adfChanges(x, y, seg(x, ra[k] + 1), out);
                else
                    out.push(`${seg(x, ra[k] + 1)} replaced by ${(y && y.type) || 'item'}`);
            }
            for (const k of ra.slice(n))
                out.push(`${seg(a[k], k + 1)} removed`);
            for (const k of rb.slice(n))
                out.push(`${seg(b[k], '+' + (k + 1))} added`);
            pi = ei + 1;
            pj = ej + 1;
        }
        return out;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (k === 'content' || k === 'marks')
                adfChanges(a[k] || [], b[k] || [], path, out);
            else if (k === 'attrs' && a.attrs && b.attrs) {
                for (const ak of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]))
                    if (J(a.attrs[ak]) !== J(b.attrs[ak]))
                        out.push(`${path} ${ak}: ${short(a.attrs[ak])} -> ${short(b.attrs[ak])}`);
            }
            else if (J(a[k]) !== J(b[k]))
                out.push(`${path} ${k}: ${short(a[k])} -> ${short(b[k])}`);
        }
        return out;
    }
    out.push(`${path}: ${short(a)} -> ${short(b)}`);
    return out;
}
// inline comment id -> the text it is attached to
function comments(nodes, acc = new Map()) {
    for (const n of nodes || []) {
        if (!n || typeof n !== 'object')
            continue;
        for (const m of n.marks || [])
            if (m.type === 'annotation' && m.attrs && m.attrs.id)
                acc.set(m.attrs.id, (acc.get(m.attrs.id) || '') + (n.text || ''));
        comments(n.content, acc);
    }
    return acc;
}
function describe(n, env) {
    const id = shortIdOf(n, env);
    const t = plainText(n).replace(/\s+/g, ' ').trim();
    return `${n.type}${id ? ' adf=' + id : ''}${t ? ' "' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + '"' : ''}`;
}
function plainText(n) {
    if (!n)
        return '';
    if (n.type === 'text')
        return n.text || '';
    if (n.attrs && n.attrs.text && (n.type === 'mention' || n.type === 'status' || n.type === 'emoji'))
        return n.attrs.text;
    return (n.content || []).map(plainText).join(n.type === 'tableRow' || n.type === 'table' ? ' ' : '');
}
function layoutCategory(l) {
    if (l === 'center')
        return 'center';
    if (l === 'wrap-left' || l === 'align-start')
        return 'wrap-left';
    if (l === 'wrap-right' || l === 'align-end')
        return 'wrap-right';
    return undefined;
}
function normColor(c) {
    return String(c || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toLowerCase();
}
function isoDay(ts) {
    const d = new Date(Number(ts));
    return isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 10);
}
