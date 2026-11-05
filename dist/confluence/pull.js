// Pull in-scope Confluence pages into the mirror as AsciiDoc.
// Spec: docs/adr/0002-scope.md, docs/adr/0005-asciidoc-round-trip.md
import fs from 'node:fs';
import path from 'node:path';
import { convert, isEmptyDoc } from "../core/adoc.js";
import { parseAdf } from "../core/adf.js";
import * as header from "../core/header.js";
import { writeFile, relPosix } from "../core/files.js";
import { layoutTree, safeFileName } from "./layout.js";
export async function pull({ api, scope, outDir, dryRun = false, force = false, only = [], log = console.log }) {
    const report = { written: [], upToDate: [], localEdits: [], conflicts: [], moved: [], empty: [], orphans: [], excluded: [], skippedTypes: [], pages: {} };
    // 1-2. Discover the tree and cross-check it against CQL.
    const { nodes, roots, pageCache } = await discover(api, scope, report);
    for (const id of only)
        if (!nodes.has(id) || nodes.get(id).excluded)
            throw new Error(`page ${id} is not in scope`);
    // 3. Layout, existing files.
    const layout = layoutTree(nodes, roots);
    const existing = indexExisting(outDir);
    const targets = [...nodes.values()].filter((n) => n.type === 'page' && !n.excluded && (!only.length || only.includes(n.id)));
    // 4. Fetch target pages; decide which pages produce files (empty pages are containers).
    const fetched = new Map();
    for (const n of targets) {
        const p = pageCache.get(n.id) || (await api.page(n.id));
        fetched.set(n.id, { meta: p, adf: parseAdf(p.body && p.body.atlas_doc_format && p.body.atlas_doc_format.value) });
    }
    const fileOf = (id) => {
        const n = nodes.get(id);
        if (!n || n.excluded || n.type !== 'page')
            return null;
        if (fetched.has(id))
            return isEmptyDoc(fetched.get(id).adf) ? null : layout.get(id).file;
        const e = existing.get(id);
        return e ? e.rel : null;
    };
    // 5. Convert and write.
    for (const n of targets) {
        const { meta, adf } = fetched.get(n.id);
        const rel = layout.get(n.id).file;
        const version = meta.version && meta.version.number;
        const prior = existing.get(n.id);
        const line = (status, extra = '') => log(`${status.padEnd(12)} ${rel}${extra ? '  ' + extra : ''}`);
        if (isEmptyDoc(adf)) {
            report.empty.push(rel);
            if (prior)
                line('empty', `page is now empty; existing file left in place: ${prior.rel}`);
            continue;
        }
        if (prior && prior.localEdits) {
            if (String(prior.version) === String(version)) {
                report.localEdits.push(prior.rel);
                line('local-edits', 'not yet published; left unchanged');
            }
            else {
                report.conflicts.push(`${prior.rel} (local edits, Confluence v${prior.version} -> v${version})`);
                line('CONFLICT', `local edits and Confluence changed (v${prior.version} -> v${version})`);
            }
            continue;
        }
        if (prior && !force && String(prior.version) === String(version) && prior.rel === rel) {
            report.upToDate.push(rel);
            continue;
        }
        const pageDir = path.posix.dirname(rel);
        const attDir = `_attachments/${n.id}`;
        const attachments = hasMedia(adf) ? await api.attachments(n.id) : null;
        const { resolveMedia, downloads } = mediaResolver(attachments, attDir);
        const resolveLink = makeLinkResolver(scope.site, n.id, rel, fileOf, nodes);
        const result = convert(adf, { resolveLink, resolveMedia });
        const spaceKey = roots.find((r) => r.id === n.rootId).spaceKey;
        const attrs = [
            ['confluence-id', n.id],
            ['confluence-space', spaceKey],
            ['confluence-version', version],
            ['confluence-source', `https://${scope.site}/wiki/spaces/${spaceKey}/pages/${n.id}`],
            ['scope-root', n.rootId],
            ['confluence-heading-offset', result.headingOffset || null],
            ['confluence-sync-hash', header.hash(result.body)],
            ['toc', result.toc ? 'macro' : null],
        ];
        const text = header.render(meta.title, attrs, result.body);
        report.pages[rel] = result.report;
        const notes = [];
        const u = Object.entries(result.report.unsupported);
        if (u.length)
            notes.push('unsupported: ' + u.map(([k, v]) => `${k}x${v}`).join(' '));
        if (result.report.missingMedia.length)
            notes.push(`images not attached: ${result.report.missingMedia.length}`);
        if (result.report.outOfScopeLinks)
            notes.push(`out-of-scope links: ${result.report.outOfScopeLinks}`);
        if (prior && prior.rel !== rel) {
            report.moved.push(`${prior.rel} -> ${rel}`);
            if (!dryRun)
                moveFile(outDir, prior.rel, rel, n.id);
        }
        if (!dryRun) {
            writeFile(path.join(outDir, rel), text);
            for (const [name, att] of downloads) {
                const dest = path.join(outDir, pageDir, attDir, name);
                if (fs.existsSync(dest) && att.fileSize && fs.statSync(dest).size === att.fileSize)
                    continue;
                writeFile(dest, await api.download(att.downloadLink));
            }
        }
        report.written.push(rel);
        line(prior ? 'updated' : 'new', notes.join('; '));
    }
    // 6. Orphans: files whose page is gone, excluded, or out of scope (reported, never deleted).
    for (const [id, e] of existing) {
        const n = nodes.get(id);
        if (!n || n.excluded)
            report.orphans.push(e.rel);
    }
    log('');
    log(`written ${report.written.length}, up to date ${report.upToDate.length}, local edits ${report.localEdits.length}, conflicts ${report.conflicts.length}, empty ${report.empty.length}`);
    for (const [label, list] of [
        ['CONFLICTS', report.conflicts],
        ['moved', report.moved],
        ['orphans (not deleted)', report.orphans],
        ['excluded', report.excluded],
        ['skipped content types', report.skippedTypes],
    ]) {
        if (list.length)
            log(`${label}:\n  ${list.join('\n  ')}`);
    }
    if (dryRun)
        log('(dry run: nothing written)');
    return report;
}
// The tree under each root (ADR-0002 decision 5), cross-checked against CQL (decision 3): any
// difference aborts before anything is written.
export async function discover(api, scope, report = { excluded: [], skippedTypes: [] }) {
    const nodes = new Map();
    const roots = [];
    const pageCache = new Map();
    const excluded = new Set(scope.exclude);
    for (const r of scope.roots) {
        const meta = r.type === 'folder' ? await api.folder(r.id) : await api.page(r.id);
        if (r.type === 'page')
            pageCache.set(r.id, meta);
        const spaceKey = await api.spaceKey(meta.spaceId);
        nodes.set(r.id, { id: r.id, type: r.type, title: meta.title, parentId: null, rootId: r.id, children: [], excluded: excluded.has(r.id) });
        roots.push({ id: r.id, spaceKey });
        const queue = [r.id];
        while (queue.length) {
            const pid = queue.shift();
            const parent = nodes.get(pid);
            for (const c of await api.children(pid, parent.type)) {
                const id = String(c.id);
                if ((c.status || 'current') !== 'current')
                    continue;
                if (c.type !== 'page' && c.type !== 'folder') {
                    report.skippedTypes.push(`${id} ${c.type} "${c.title}"`);
                    continue;
                }
                const ex = parent.excluded || excluded.has(id);
                nodes.set(id, { id, type: c.type, title: c.title, parentId: pid, rootId: r.id, children: [], excluded: ex });
                parent.children.push(id);
                if (ex && excluded.has(id))
                    report.excluded.push(`${id} "${c.title}"`);
                queue.push(id);
            }
        }
    }
    // Cross-check against CQL; any difference aborts before anything is written (ADR-0002 decision 3).
    const rootIds = new Set(scope.roots.map((r) => r.id));
    const cqlIds = new Set((await api.cql(scope.roots.map((r) => `ancestor = ${r.id}`).join(' OR ')))
        .filter((c) => c.type === 'page' || c.type === 'folder')
        .map((c) => String(c.id)));
    const treeIds = new Set([...nodes.keys()].filter((id) => !rootIds.has(id)));
    const missing = [...cqlIds].filter((id) => !treeIds.has(id));
    const extra = [...treeIds].filter((id) => !cqlIds.has(id));
    if (missing.length || extra.length) {
        throw new Error(`scope cross-check failed: in CQL but not tree [${missing.join(', ')}]; in tree but not CQL [${extra.join(', ')}]`);
    }
    return { nodes, roots, pageCache };
}
// Images: match ADF media to the page's attachments by file id, then by name (ADR-0005 §6).
export function mediaResolver(attachments, attDir) {
    const downloads = new Map();
    const usedNames = new Map();
    const resolveMedia = (a) => {
        if (a.type === 'external' && a.url)
            return { url: a.url };
        const att = attachments && (attachments.find((x) => x.fileId && x.fileId === a.id) || attachments.find((x) => x.title === a.alt));
        if (!att)
            return { expected: `${attDir}/${safeFileName(a.alt || a.id || 'image')}` };
        const key = att.id || att.title;
        let name = usedNames.get(key);
        if (!name) {
            name = safeFileName(att.title);
            if ([...usedNames.values()].includes(name))
                name = `${String(att.fileId || att.id).slice(0, 8)}-${name}`;
            usedNames.set(key, name);
        }
        downloads.set(name, att);
        return { path: `${attDir}/${name}`, title: att.title };
    };
    return { resolveMedia, downloads };
}
export function makeLinkResolver(site, pageId, fromRel, fileOf, nodes) {
    const fromDir = path.posix.dirname(fromRel);
    return (href) => {
        let url = href;
        if (url.startsWith('#'))
            return { anchor: url.slice(1) };
        if (url.startsWith('/'))
            url = `https://${site}${url.startsWith('/wiki/') ? '' : '/wiki'}${url}`;
        const m = /^https:\/\/([^/]+)\/wiki\/(?:spaces\/[^/]+\/pages\/(\d+)[^#]*|pages\/viewpage\.action\?pageId=(\d+)[^#]*)(?:#(.*))?$/.exec(url);
        if (!m || m[1] !== site)
            return { url };
        const id = m[2] || m[3];
        const fragment = m[4] || '';
        if (id === pageId)
            return fragment ? { anchor: fragment } : { url };
        const target = fileOf(id);
        if (!target)
            return { url, outOfScope: !nodes.has(id) || nodes.get(id).excluded };
        return { xref: path.posix.relative(fromDir, target), fragment };
    };
}
export function hasMedia(adf) {
    let found = false;
    const walk = (n) => {
        if (!n || found)
            return;
        if (n.type === 'media' || n.type === 'mediaInline')
            found = true;
        (n.content || []).forEach(walk);
    };
    walk(adf);
    return found;
}
export function indexExisting(outDir) {
    const out = new Map();
    if (!fs.existsSync(outDir))
        return out;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== '_attachments' && e.name !== '_templates')
                    walk(p);
            }
            else if (e.name.endsWith('.adoc')) {
                const h = header.parse(fs.readFileSync(p, 'utf8'));
                const id = h && h.attrs['confluence-id'];
                if (!h || !id)
                    continue;
                out.set(id, {
                    rel: relPosix(outDir, p),
                    title: h.title.trim(),
                    version: h.attrs['confluence-version'],
                    localEdits: header.hash(h.body) !== h.attrs['confluence-sync-hash'],
                });
            }
        }
    };
    walk(outDir);
    return out;
}
export function indexDrafts(outDir) {
    const out = new Map();
    if (!fs.existsSync(outDir))
        return out;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== '_attachments' && e.name !== '_templates')
                    walk(p);
            }
            else if (e.name.endsWith('.adoc')) {
                const h = header.parse(fs.readFileSync(p, 'utf8'));
                if (!h || h.attrs['confluence-id'] || !h.attrs['confluence-parent'])
                    continue;
                const rel = relPosix(outDir, p);
                out.set(rel, { rel, title: h.title.trim(), parentId: h.attrs['confluence-parent'] });
            }
        }
    };
    walk(outDir);
    return out;
}
function moveFile(outDir, fromRel, toRel, pageId) {
    const from = path.join(outDir, fromRel);
    const to = path.join(outDir, toRel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    const fromAtt = path.join(path.dirname(from), '_attachments', pageId);
    const toAtt = path.join(path.dirname(to), '_attachments', pageId);
    if (fs.existsSync(fromAtt) && !fs.existsSync(toAtt)) {
        fs.mkdirSync(path.dirname(toAtt), { recursive: true });
        fs.renameSync(fromAtt, toAtt);
    }
}
