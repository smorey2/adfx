// Confluence Cloud REST access. Reading is separate from writing: pull only ever gets a ConfluenceReader
// (GET requests only, ADR-0002 decision 4); the one write path is updatePage (ADR-0005 §4, §8).

import { AtlassianClient, type FetchLike, type Credentials } from '../core/http.ts';
import type { AdfNode } from '../core/adf.ts';

export interface PageMeta {
  id: string;
  type?: string;
  status?: string;
  title: string;
  parentId?: string | null;
  spaceId: string;
  version: { number: number; createdAt?: string };
  body?: { atlas_doc_format?: { value: string } };
}

export interface FolderMeta {
  id: string;
  type?: string;
  title: string;
  parentId?: string | null;
  spaceId: string;
}

export interface ChildRef {
  id: string | number;
  type: string;
  title: string;
  status?: string;
}

export interface Attachment {
  id?: string;
  title: string;
  fileId?: string;
  fileSize?: number;
  mediaType?: string;
  downloadLink: string;
}

export interface ConfluenceReader {
  page(id: string): Promise<PageMeta>;
  folder(id: string): Promise<FolderMeta>;
  spaceKey(spaceId: string): Promise<string>;
  children(id: string, type: string): Promise<ChildRef[]>;
  cql(cql: string): Promise<ChildRef[]>;
  attachments(pageId: string): Promise<Attachment[]>;
  download(downloadLink: string): Promise<Buffer>;
}

export interface PageUpdate {
  id: string;
  title: string;
  adf: AdfNode;
  version: number;
  message: string;
}

export type PageWriter = (u: PageUpdate) => Promise<{ version?: { number: number } } | undefined>;

export class ConfluenceApi implements ConfluenceReader {
  private readonly http: AtlassianClient;
  private readonly spaceKeys = new Map<string, string>();

  constructor(opts: { site: string; fetchImpl?: FetchLike } & Credentials) {
    this.http = new AtlassianClient(opts);
  }

  private async paged(path: string): Promise<any[]> {
    const out: any[] = [];
    let next: string | null = path;
    while (next) {
      const j: any = await this.http.get(next);
      out.push(...(j.results || []));
      const link: string | undefined = j._links && j._links.next;
      next = link ? (link.startsWith('/wiki/') ? link : '/wiki' + link) : null;
    }
    return out;
  }

  page(id: string): Promise<PageMeta> {
    return this.http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
  }

  folder(id: string): Promise<FolderMeta> {
    return this.http.get(`/wiki/api/v2/folders/${id}`);
  }

  async spaceKey(spaceId: string): Promise<string> {
    if (!this.spaceKeys.has(spaceId)) this.spaceKeys.set(spaceId, (await this.http.get(`/wiki/api/v2/spaces/${spaceId}`)).key);
    return this.spaceKeys.get(spaceId)!;
  }

  children(id: string, type: string): Promise<ChildRef[]> {
    return this.paged(`/wiki/api/v2/${type === 'folder' ? 'folders' : 'pages'}/${id}/direct-children?limit=250`);
  }

  cql(cql: string): Promise<ChildRef[]> {
    return this.paged(`/wiki/rest/api/content/search?limit=200&cql=${encodeURIComponent(cql)}`);
  }

  attachments(pageId: string): Promise<Attachment[]> {
    return this.paged(`/wiki/api/v2/pages/${pageId}/attachments?limit=250`);
  }

  download(downloadLink: string): Promise<Buffer> {
    return this.http.get(downloadLink.startsWith('/wiki/') ? downloadLink : '/wiki' + downloadLink, { binary: true });
  }

  // The signed-in user, to check a token works.
  currentUser(): Promise<{ displayName?: string; email?: string }> {
    return this.http.get('/wiki/rest/api/user/current');
  }
}

export function pageWriter(opts: { site: string; fetchImpl?: FetchLike } & Credentials): PageWriter {
  const http = new AtlassianClient(opts);
  return ({ id, title, adf, version, message }) =>
    http.send(
      'PUT',
      `/wiki/api/v2/pages/${id}`,
      { id, status: 'current', title, body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) }, version: { number: version, message } },
      'page changed since it was read; re-run',
    );
}

export interface NewPage {
  spaceId: string;
  parentId: string;
  title: string;
  adf: AdfNode;
}

export type PageCreator = (p: NewPage) => Promise<{ id: string; version?: { number: number } }>;

export function pageCreator(opts: { site: string; fetchImpl?: FetchLike } & Credentials): PageCreator {
  const http = new AtlassianClient(opts);
  return async ({ spaceId, parentId, title, adf }) => {
    const res = await http.send('POST', '/wiki/api/v2/pages', { spaceId, status: 'current', title, parentId, body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) } });
    return { id: String(res.id), version: res.version };
  };
}

// Same interface, backed by a JSON file. Used by tests and for offline dry runs.
// Shape: { spaces: { <spaceId>: <key> }, content: { <id>: { type, title, parentId, spaceId, status,
//          version, adf, attachments: [{ title, fileId, fileSize, mediaType, downloadLink, base64 }] } } }
export interface FixtureData {
  spaces: Record<string, string>;
  content: Record<
    string,
    {
      type: string;
      title: string;
      parentId?: string;
      spaceId: string;
      status?: string;
      version?: number;
      createdAt?: string;
      adf?: AdfNode;
      attachments?: (Attachment & { base64?: string })[];
    }
  >;
}

export class FixtureApi implements ConfluenceReader {
  data: FixtureData;
  calls: [string, string][] = [];

  constructor(data: FixtureData) {
    this.data = data;
  }

  private item(id: string) {
    const c = this.data.content[id];
    if (!c) throw new Error(`fixture: no content ${id}`);
    return c;
  }

  async page(id: string): Promise<PageMeta> {
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

  async folder(id: string): Promise<FolderMeta> {
    const c = this.item(id);
    return { id, type: 'folder', title: c.title, parentId: c.parentId || null, spaceId: c.spaceId };
  }

  async spaceKey(spaceId: string): Promise<string> {
    return this.data.spaces[spaceId];
  }

  async children(id: string): Promise<ChildRef[]> {
    return Object.entries(this.data.content)
      .filter(([, c]) => c.parentId === id)
      .map(([cid, c]) => ({ id: cid, type: c.type, title: c.title, status: c.status || 'current' }));
  }

  async cql(cql: string): Promise<ChildRef[]> {
    const roots = [...cql.matchAll(/ancestor = (\d+)/g)].map((m) => m[1]);
    const under = (id: string) => {
      for (let p = this.data.content[id].parentId; p; p = this.data.content[p] && this.data.content[p].parentId) if (roots.includes(p)) return true;
      return false;
    };
    const only = /\bid = (\d+)/.exec(cql);
    return Object.entries(this.data.content)
      .filter(([id, c]) => (c.status || 'current') === 'current' && under(id) && (!only || only[1] === id))
      .map(([id, c]) => ({ id, type: c.type, title: c.title }));
  }

  async attachments(pageId: string): Promise<Attachment[]> {
    return (this.item(pageId).attachments || []).map((a) => ({ ...a, base64: undefined }));
  }

  async download(link: string): Promise<Buffer> {
    this.calls.push(['download', link]);
    for (const c of Object.values(this.data.content)) for (const a of c.attachments || []) if (a.downloadLink === link) return Buffer.from(a.base64 || '', 'base64');
    throw new Error(`fixture: no attachment ${link}`);
  }
}
