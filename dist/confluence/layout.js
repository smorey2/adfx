// Mirror paths for the page tree (ADR-0003 layout rules, carried into ADR-0005 §1).
// Names Windows refuses as files or folders, even with an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export function slug(title) {
    const s = String(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'untitled';
    return RESERVED.test(s) ? s + '-page' : s;
}
// Returns id -> { dir, file } where file is the .adoc path a page would use (relative, '/'-separated).
export function layoutTree(nodes, roots) {
    const out = new Map();
    const place = (id, dir) => {
        const n = nodes.get(id);
        out.set(id, { dir, file: n.children.length ? dir + '/index.adoc' : dir + '.adoc' });
        const counts = new Map();
        for (const c of n.children) {
            const s = slug(nodes.get(c).title);
            counts.set(s, (counts.get(s) || 0) + 1);
        }
        for (const c of n.children) {
            const s = slug(nodes.get(c).title);
            place(c, dir + '/' + (counts.get(s) > 1 ? s + '-' + c : s));
        }
    };
    for (const r of roots)
        place(r.id, r.spaceKey + '/' + slug(nodes.get(r.id).title));
    return out;
}
// Safe on Windows, macOS and Linux: letters, digits, dot, dash and underscore only.
export function safeFileName(name) {
    const s = String(name)
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^\.+/, '');
    return s || 'file';
}
