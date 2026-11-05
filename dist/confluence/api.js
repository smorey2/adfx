// Confluence Cloud REST access. Reading is separate from writing: pull only ever gets a ConfluenceReader
// (GET requests only, ADR-0002 decision 4); the one write path is updatePage (ADR-0005 §4, §8).
import { AtlassianClient } from "../core/http.js";
export class ConfluenceApi {
    http;
    spaceKeys = new Map();
    constructor(opts) {
        this.http = new AtlassianClient(opts);
    }
    async paged(path) {
        const out = [];
        let next = path;
        while (next) {
            const j = await this.http.get(next);
            out.push(...(j.results || []));
            const link = j._links && j._links.next;
            next = link ? (link.startsWith('/wiki/') ? link : '/wiki' + link) : null;
        }
        return out;
    }
    page(id) {
        return this.http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    }
    folder(id) {
        return this.http.get(`/wiki/api/v2/folders/${id}`);
    }
    async spaceKey(spaceId) {
        if (!this.spaceKeys.has(spaceId))
            this.spaceKeys.set(spaceId, (await this.http.get(`/wiki/api/v2/spaces/${spaceId}`)).key);
        return this.spaceKeys.get(spaceId);
    }
    children(id, type) {
        return this.paged(`/wiki/api/v2/${type === 'folder' ? 'folders' : 'pages'}/${id}/direct-children?limit=250`);
    }
    cql(cql) {
        return this.paged(`/wiki/rest/api/content/search?limit=200&cql=${encodeURIComponent(cql)}`);
    }
    attachments(pageId) {
        return this.paged(`/wiki/api/v2/pages/${pageId}/attachments?limit=250`);
    }
    download(downloadLink) {
        return this.http.get(downloadLink.startsWith('/wiki/') ? downloadLink : '/wiki' + downloadLink, { binary: true });
    }
    // The signed-in user, to check a token works.
    currentUser() {
        return this.http.get('/wiki/rest/api/user/current');
    }
}
export function pageWriter(opts) {
    const http = new AtlassianClient(opts);
    return ({ id, title, adf, version, message }) => http.send('PUT', `/wiki/api/v2/pages/${id}`, { id, status: 'current', title, body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) }, version: { number: version, message } }, 'page changed since it was read; re-run');
}
export function pageCreator(opts) {
    const http = new AtlassianClient(opts);
    return async ({ spaceId, parentId, title, adf }) => {
        const res = await http.send('POST', '/wiki/api/v2/pages', { spaceId, status: 'current', title, parentId, body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) } });
        return { id: String(res.id), version: res.version };
    };
}
export class FixtureApi {
    data;
    calls = [];
    constructor(data) {
        this.data = data;
    }
    item(id) {
        const c = this.data.content[id];
        if (!c)
            throw new Error(`fixture: no content ${id}`);
        return c;
    }
    async page(id) {
        this.calls.push(['page', id]);
        const c = this.item(id);
        return {
            id,
            type: 'page',
            status: c.status || 'current',
            title: c.title,
            parentId: c.parentId || null,
            spaceId: c.spaceId,
            version: { number: c.version || 1, createdAt: c.createdAt || '2026-01-01T00:00:00.000Z' },
            body: { atlas_doc_format: { value: JSON.stringify(c.adf || { type: 'doc', version: 1, content: [] }) } },
        };
    }
    async folder(id) {
        const c = this.item(id);
        return { id, type: 'folder', title: c.title, parentId: c.parentId || null, spaceId: c.spaceId };
    }
    async spaceKey(spaceId) {
        return this.data.spaces[spaceId];
    }
    async children(id) {
        return Object.entries(this.data.content)
            .filter(([, c]) => c.parentId === id)
            .map(([cid, c]) => ({ id: cid, type: c.type, title: c.title, status: c.status || 'current' }));
    }
    async cql(cql) {
        const roots = [...cql.matchAll(/ancestor = (\d+)/g)].map((m) => m[1]);
        const under = (id) => {
            for (let p = this.data.content[id].parentId; p; p = this.data.content[p] && this.data.content[p].parentId)
                if (roots.includes(p))
                    return true;
            return false;
        };
        const only = /\bid = (\d+)/.exec(cql);
        return Object.entries(this.data.content)
            .filter(([id, c]) => (c.status || 'current') === 'current' && under(id) && (!only || only[1] === id))
            .map(([id, c]) => ({ id, type: c.type, title: c.title }));
    }
    async attachments(pageId) {
        return (this.item(pageId).attachments || []).map((a) => ({ ...a, base64: undefined }));
    }
    async download(link) {
        this.calls.push(['download', link]);
        for (const c of Object.values(this.data.content))
            for (const a of c.attachments || [])
                if (a.downloadLink === link)
                    return Buffer.from(a.base64 || '', 'base64');
        throw new Error(`fixture: no attachment ${link}`);
    }
}
