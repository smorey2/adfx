// Push edited mirror files back to their Confluence pages. Spec: docs/adr/0005-asciidoc-round-trip.md §4, §5.
import fs from 'node:fs';
import path from 'node:path';
import { convert, buildShortIds } from "../core/adoc.js";
import { parseAdf } from "../core/adf.js";
import { buildPatch, gate, adfChanges } from "../core/patch.js";
import * as header from "../core/header.js";
import { writeFile, relPosix } from "../core/files.js";
import { pull, discover, mediaResolver, makeLinkResolver, hasMedia, indexExisting, indexDrafts } from "./pull.js";
export async function publish({ api, scope, outDir, files = [], pages = [], apply = false, acceptLoss = false, check = false, message, write, create, repull, log = console.log }) {
    const existing = indexExisting(outDir);
    const drafts = indexDrafts(outDir);
    const byRel = new Map([...existing].map(([id, e]) => [e.rel, id]));
    let targets = [];
    let newTargets = [];
    for (const f of files) {
        const rel = relPosix(outDir, path.resolve(f));
        if (drafts.has(rel) && !check) {
            newTargets.push(rel);
            continue;
        }
        if (!byRel.has(rel))
            throw new Error(`${f} is not a pulled Confluence page or a new-page draft under ${outDir}`);
        targets.push(byRel.get(rel));
    }
    for (const id of pages) {
        if (!existing.has(id))
            throw new Error(`no file for page ${id}; pull it first`);
        targets.push(id);
    }
    const results = [];
    // Scope (ADR-0002): the full tree, cross-checked against CQL, as for pull.
    const tree = await discover(api, scope);
    const { nodes } = tree;
    if (!files.length && !pages.length) {
        // body edits change the sync hash; title edits are found by comparing with the live title
        const renamed = (id, title) => nodes.has(id) && title !== String(nodes.get(id).title).replace(/\s+/g, ' ').trim();
        targets = [...existing].filter(([id, e]) => check || e.localEdits || renamed(id, e.title)).map(([id]) => id);
        if (!check)
            newTargets = [...drafts.keys()];
    }
    targets = [...new Set(targets)];
    newTargets = [...new Set(newTargets)];
    if (!targets.length && !newTargets.length) {
        log('nothing to publish: no files have local edits');
        return results;
    }
    const fileOf = (id) => (existing.has(id) ? existing.get(id).rel : null);
    const totals = { blocks: 0, failed: 0 };
    for (const id of targets) {
        const e = existing.get(id);
        const res = { id, rel: e.rel, status: 'unchanged', errors: [], losses: [] };
        results.push(res);
        const n = nodes.get(id);
        if (!n || n.excluded) {
            res.status = 'refused';
            res.errors.push(`page ${id} is not in scope`);
            log(`== ${e.rel}\n   REFUSED: page ${id} is not in scope (confluence.yaml)`);
            continue;
        }
        const h = header.parse(fs.readFileSync(path.join(outDir, e.rel), 'utf8'));
        const page = await api.page(id);
        const version = page.version.number;
        const liveAdf = parseAdf(page.body && page.body.atlas_doc_format && page.body.atlas_doc_format.value);
        const attachments = hasMedia(liveAdf) ? await api.attachments(id) : null;
        const { resolveMedia } = mediaResolver(attachments, `_attachments/${id}`);
        const conv = convert(liveAdf, { resolveLink: makeLinkResolver(scope.site, id, e.rel, fileOf, nodes), resolveMedia });
        const parseOpts = { headingOffset: Number(h.attrs['confluence-heading-offset'] || 0), resolveXref: (t) => xrefUrl(outDir, e.rel, t, byRel) };
        const shortIds = buildShortIds(liveAdf);
        if (check) {
            const fails = [];
            (liveAdf.content || []).forEach((node, j) => {
                if (!conv.chunks[j] || conv.chunks[j].text === '')
                    return;
                const g = gate(node, conv.chunks[j].text, { ...parseOpts, refs: conv.refs }, { refs: conv.refs, shortIds });
                if (!g.ok)
                    fails.push(`block ${j + 1} ${node.type}: ${g.why}`);
            });
            const count = conv.chunks.filter((c) => c.text !== '').length;
            totals.blocks += count;
            totals.failed += fails.length;
            res.status = fails.length ? 'pull-only blocks' : 'ok';
            res.errors = fails;
            log(`${fails.length ? 'PARTIAL' : 'ok     '} ${e.rel}  ${count - fails.length}/${count} blocks can be rebuilt${fails.length ? '\n   ' + fails.join('\n   ') : ''}`);
            continue;
        }
        log(`== ${e.rel}  (page ${id}, v${version})`);
        if (String(version) !== String(h.attrs['confluence-version'])) {
            res.status = 'conflict';
            res.errors.push(`Confluence is at v${version}, the file was pulled at v${h.attrs['confluence-version']}`);
            log(`   CONFLICT: Confluence changed since this file was pulled (v${h.attrs['confluence-version']} -> v${version}).`);
            log('   Pull it into a temporary directory, merge your edits, then publish again (ADR-0005 §5).');
            continue;
        }
        const liveTitle = String(page.title).replace(/\s+/g, ' ').trim();
        const title = h.title.trim();
        const patch = buildPatch({ liveAdf, conv, body: h.body, parseOpts, shortIds });
        res.errors = patch.errors;
        res.losses = patch.losses;
        if (title !== liveTitle)
            log(`   title: "${liveTitle}" -> "${title}"`);
        for (const c of patch.changes) {
            if (c.kind === 'changed')
                log(`   ~ block ${c.old + 1} ${patch.describeOld(c.old)}\n${indent(lineDiff(patch.oldText(c.old), patch.newText(c.new)))}`);
            else if (c.kind === 'added')
                log(`   + new block\n${indent(patch
                    .newText(c.new)
                    .split('\n')
                    .map((l) => '+ ' + l)
                    .join('\n'))}`);
            else
                log(`   - block ${c.old + 1} removed: ${patch.describeOld(c.old)}`);
        }
        if (patch.moved)
            log('   (blocks were reordered)');
        for (const l of patch.losses)
            log(`   will be lost: ${l}`);
        for (const err of patch.errors)
            log(`   REFUSED: ${err}`);
        if (patch.errors.length) {
            res.status = 'refused';
            continue;
        }
        if (!patch.changes.length && !patch.moved && title === liveTitle) {
            log('   no changes to publish' + (e.localEdits ? ' (the file differs from the last pull only in ways that read back the same)' : ''));
            continue;
        }
        const counts = ['changed', 'added', 'removed'].map((k) => `${patch.changes.filter((c) => c.kind === k).length} ${k}`).join(', ');
        if (patch.losses.length && !acceptLoss) {
            res.status = 'needs --accept-loss';
            log(`   ${counts}. Hidden data above would be lost; re-run with --accept-loss to publish anyway.`);
            continue;
        }
        res.status = 'ready';
        const sent = adfChanges(liveAdf, patch.adf);
        log(`   Confluence changes (${sent.length}):\n${sent
            .slice(0, 15)
            .map((l) => '     ' + l)
            .join('\n')}${sent.length > 15 ? `\n     … ${sent.length - 15} more` : ''}`);
        log(`   ${counts}; every other block is copied unchanged.`);
        if (!apply)
            continue;
        if (!write)
            throw new Error('no writer configured; publishing needs credentials (not --fixtures)');
        const out = await write({ id, title, adf: patch.adf, version: version + 1, message: message || 'Published with adfx' });
        res.status = 'published';
        res.newVersion = (out && out.version && out.version.number) || version + 1;
        log(`   published: v${version} -> v${res.newVersion}`);
        // Mark the file clean, then pull the new version so the file matches Confluence exactly.
        const file = path.join(outDir, e.rel);
        const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        writeFile(file, text.replace(/^:confluence-sync-hash: .*$/m, `:confluence-sync-hash: ${header.hash(header.parse(text).body)}`));
        await (repull || ((pid) => pull({ api, scope, outDir, only: [pid], force: true, log: () => { } })))(id);
    }
    for (const rel of newTargets) {
        const res = await createPage({ api, scope, outDir, rel, tree, byRel, apply, create, repull, log });
        results.push(res);
    }
    if (check)
        log(`\n${totals.blocks - totals.failed}/${totals.blocks} blocks can be rebuilt exactly; the rest are pull-only until the converter handles them.`);
    else {
        const by = (s) => results.filter((r) => r.status === s).length;
        const created = by('created') ? `, created ${by('created')}` : '';
        log(`\nready ${by('ready')}, published ${by('published')}${created}, refused ${by('refused')}, needs --accept-loss ${by('needs --accept-loss')}, conflicts ${by('conflict')}, unchanged ${by('unchanged')}`);
        if (!apply && by('ready'))
            log('(dry run: nothing written; re-run with --apply)');
    }
    return results;
}
// The first push of a "confluence new" draft creates the page (ADR-0007). The body is built from the
// file alone; only macros a new page may contain are allowed.
async function createPage({ api, scope, outDir, rel, tree, byRel, apply, create, repull, log, }) {
    const res = { id: '', rel, status: 'unchanged', errors: [], losses: [] };
    const file = path.join(outDir, rel);
    const h = header.parse(fs.readFileSync(file, 'utf8'));
    const parentId = h.attrs['confluence-parent'];
    const parent = tree.nodes.get(parentId);
    const title = h.title.replace(/\s+/g, ' ').trim();
    log(`== ${rel}  (new page${parent ? ` under "${parent.title}"` : ''})`);
    const refuse = (why) => {
        res.status = 'refused';
        res.errors.push(why);
        log(`   REFUSED: ${why}`);
        return res;
    };
    if (!parent || parent.excluded)
        return refuse(`parent ${parentId} is not in scope (confluence.yaml)`);
    if (!title)
        return refuse('the file needs a "= Title" line');
    const taken = parent.children.map((c) => tree.nodes.get(c)).find((c) => c.title.replace(/\s+/g, ' ').trim().toLowerCase() === title.toLowerCase());
    if (taken)
        return refuse(`"${taken.title}" already exists under that parent (page ${taken.id}); pull it instead`);
    const empty = { type: 'doc', version: 1, content: [] };
    const parseOpts = { headingOffset: Number(h.attrs['confluence-heading-offset'] || 0), resolveXref: (t) => xrefUrl(outDir, rel, t, byRel) };
    const patch = buildPatch({ liveAdf: empty, conv: convert(empty), body: h.body, parseOpts, shortIds: new Map(), newPage: true });
    for (const c of patch.changes) {
        if (c.kind !== 'added')
            continue;
        log(`   + ${indent(patch
            .newText(c.new)
            .split('\n')
            .map((l) => '+ ' + l)
            .join('\n')).trimStart()}`);
    }
    for (const err of patch.errors)
        log(`   REFUSED: ${err}`);
    if (patch.errors.length) {
        res.status = 'refused';
        res.errors = patch.errors;
        return res;
    }
    res.status = 'ready';
    log(`   Confluence: create "${title}" under "${parent.title}" (${patch.adf.content.length} blocks)`);
    if (!apply)
        return res;
    if (!create)
        throw new Error('no page creator configured; creating pages needs credentials (not --fixtures)');
    const spaceId = (parent.type === 'folder' ? await api.folder(parent.id) : await api.page(parent.id)).spaceId;
    const out = await create({ spaceId, parentId: parent.id, title, adf: patch.adf });
    res.id = out.id;
    res.status = 'created';
    res.newVersion = (out.version && out.version.number) || 1;
    log(`   created: page ${out.id}`);
    // The file now belongs to the page. Version 0 means "pull me": a second push cannot create a
    // duplicate, and the next pull replaces the draft with the page as Confluence stored it.
    const spaceKey = tree.roots.find((r) => r.id === parent.rootId).spaceKey;
    const claimed = header.render(title, [
        ['confluence-id', out.id],
        ['confluence-space', spaceKey],
        ['confluence-version', 0],
        ['scope-root', parent.rootId],
        ['confluence-heading-offset', h.attrs['confluence-heading-offset'] || null],
        ['confluence-sync-hash', header.hash(h.body)],
        ['toc', h.attrs.toc || null],
    ], h.body);
    writeFile(file, claimed);
    const again = repull || ((id) => pull({ api, scope, outDir, only: [id], force: true, log: () => { } }));
    // Confluence search can take a few seconds to list a new page, which the scope cross-check needs.
    for (let attempt = 0;; attempt++) {
        try {
            await again(out.id);
            break;
        }
        catch (e) {
            if (attempt >= 4 || !/not in scope|cross-check/.test(e.message)) {
                log(`   the page was created, but pulling it back failed (${e.message.slice(0, 120)}); run "adfx confluence pull" in a minute`);
                break;
            }
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
    }
    return res;
}
// xref:../other/page.adoc -> that page's Confluence URL
function xrefUrl(outDir, fromRel, target, byRel) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), target));
    if (!byRel.has(rel))
        return null;
    const h = header.parse(fs.readFileSync(path.join(outDir, rel), 'utf8'));
    return (h && h.attrs['confluence-source']) || null;
}
// Changed lines with one line of context, from a line-level LCS.
export function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--)
        for (let j = y.length - 1; j >= 0; j--)
            dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
        if (i < x.length && j < y.length && x[i] === y[j]) {
            ops.push(['  ', x[i++]]);
            j++;
        }
        else if (i < x.length && (j >= y.length || dp[i + 1][j] >= dp[i][j + 1]))
            ops.push(['- ', x[i++]]);
        else
            ops.push(['+ ', y[j++]]);
    }
    const keep = ops.map((o, k) => o[0] !== '  ' || (ops[k - 1] && ops[k - 1][0] !== '  ') || (ops[k + 1] && ops[k + 1][0] !== '  '));
    const out = [];
    ops.forEach((o, k) => {
        if (keep[k])
            out.push(o[0] + o[1]);
        else if (out[out.length - 1] !== '  …')
            out.push('  …');
    });
    return out.slice(0, 60).join('\n') + (out.length > 60 ? `\n  … ${out.length - 60} more lines` : '');
}
function indent(s) {
    return s
        .split('\n')
        .map((l) => '       ' + l)
        .join('\n');
}
