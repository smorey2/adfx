// Jira Cloud REST access, GET only (ADR-0008). Board traversal uses the Agile API; issue details come
// from the v3 search, which returns descriptions and comments as ADF.

import { AtlassianClient, type Credentials, type FetchLike } from '../core/http.ts';
import type { AdfNode } from '../core/adf.ts';

export interface Board {
  id: number | string;
  name: string;
  type: string; // scrum | kanban | simple
  location?: { projectKey?: string; projectName?: string };
}

export interface Sprint {
  id: number | string;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}

export interface BoardColumn {
  name: string;
  statuses: { id: string }[];
}

export interface IssueRef {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

export interface Comment {
  id: string;
  author?: { displayName?: string };
  created: string;
  body?: AdfNode | null;
}

export interface Issue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    status?: { id?: string; name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    labels?: string[];
    created?: string;
    updated?: string;
    parent?: IssueRef | null;
    subtasks?: IssueRef[];
    issuelinks?: { type: { inward: string; outward: string }; inwardIssue?: IssueRef; outwardIssue?: IssueRef }[];
    description?: AdfNode | null;
    comment?: { comments: Comment[]; total?: number };
    attachment?: { filename: string; content: string }[];
  };
}

export const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'parent', 'subtasks', 'issuelinks', 'description', 'comment', 'attachment'];

export interface JiraReader {
  board(id: string): Promise<Board>;
  boardColumns(id: string): Promise<BoardColumn[]>;
  activeSprints(boardId: string): Promise<Sprint[]>;
  sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]>;
  boardIssueKeys(boardId: string, jql: string): Promise<string[]>;
  search(jql: string): Promise<Issue[]>;
  comments(key: string): Promise<Comment[]>;
}

export class JiraApi implements JiraReader {
  private readonly http: AtlassianClient;

  constructor(opts: { site: string; fetchImpl?: FetchLike } & Credentials) {
    this.http = new AtlassianClient(opts);
  }

  // Agile API pages with startAt / isLast (or total).
  private async agile<T>(path: string, key: 'values' | 'issues'): Promise<T[]> {
    const out: T[] = [];
    for (let startAt = 0; ; ) {
      const sep = path.includes('?') ? '&' : '?';
      const j: any = await this.http.get(`${path}${sep}startAt=${startAt}&maxResults=100`);
      const page: T[] = j[key] || [];
      out.push(...page);
      startAt += page.length;
      if (!page.length || j.isLast === true || (typeof j.total === 'number' && startAt >= j.total)) return out;
    }
  }

  board(id: string): Promise<Board> {
    return this.http.get(`/rest/agile/1.0/board/${id}`);
  }

  async boardColumns(id: string): Promise<BoardColumn[]> {
    const c = await this.http.get(`/rest/agile/1.0/board/${id}/configuration`);
    return (c.columnConfig && c.columnConfig.columns) || [];
  }

  activeSprints(boardId: string): Promise<Sprint[]> {
    return this.agile(`/rest/agile/1.0/board/${boardId}/sprint?state=active`, 'values');
  }

  async sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]> {
    return (await this.agile<IssueRef>(`/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue?fields=status`, 'issues')).map((i) => i.key);
  }

  async boardIssueKeys(boardId: string, jql: string): Promise<string[]> {
    return (await this.agile<IssueRef>(`/rest/agile/1.0/board/${boardId}/issue?fields=status&jql=${encodeURIComponent(jql)}`, 'issues')).map((i) => i.key);
  }

  async search(jql: string): Promise<Issue[]> {
    const out: Issue[] = [];
    let token: string | undefined;
    do {
      const q = `jql=${encodeURIComponent(jql)}&fields=${ISSUE_FIELDS.join(',')}&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`;
      const j: any = await this.http.get(`/rest/api/3/search/jql?${q}`);
      out.push(...(j.issues || []));
      token = j.isLast === false || j.nextPageToken ? j.nextPageToken : undefined;
    } while (token);
    return out;
  }

  async comments(key: string): Promise<Comment[]> {
    const out: Comment[] = [];
    for (let startAt = 0; ; ) {
      const j: any = await this.http.get(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
      const page: Comment[] = j.comments || [];
      out.push(...page);
      startAt += page.length;
      if (!page.length || startAt >= (j.total ?? 0)) return out;
    }
  }
}

// Same interface, backed by a JSON file, for tests and offline runs.
// Shape: { boards: { <id>: { name, type, projectKey, columns: [{ name, statuses: [id] }],
//          sprints: [{ id, name, state, issues: [keys] }], issues: [keys] } }, issues: { <KEY>: Issue } }
export interface JiraFixture {
  boards: Record<string, { name: string; type: string; projectKey?: string; columns?: { name: string; statuses: string[] }[]; sprints?: (Sprint & { issues: string[] })[]; issues?: string[] }>;
  issues: Record<string, Issue>;
}

export class JiraFixtureApi implements JiraReader {
  data: JiraFixture;
  queries: string[] = [];

  constructor(data: JiraFixture) {
    this.data = data;
  }

  private b(id: string) {
    const b = this.data.boards[id];
    if (!b) throw new Error(`GET /rest/agile/1.0/board/${id} -> 404`);
    return b;
  }

  async board(id: string): Promise<Board> {
    const b = this.b(id);
    return { id, name: b.name, type: b.type, location: b.projectKey ? { projectKey: b.projectKey } : undefined };
  }

  async boardColumns(id: string): Promise<BoardColumn[]> {
    return (this.b(id).columns || []).map((c) => ({ name: c.name, statuses: c.statuses.map((s) => ({ id: s })) }));
  }

  async activeSprints(boardId: string): Promise<Sprint[]> {
    const b = this.b(boardId);
    if (!b.sprints && b.type !== 'scrum') throw new Error(`GET /rest/agile/1.0/board/${boardId}/sprint -> 400 The board does not support sprints`);
    return (b.sprints || []).filter((s) => s.state === 'active').map(({ issues: _issues, ...s }) => s);
  }

  async sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]> {
    return (this.b(boardId).sprints || []).find((s) => String(s.id) === sprintId)?.issues || [];
  }

  async boardIssueKeys(boardId: string, jql: string): Promise<string[]> {
    const keys = this.b(boardId).issues || [];
    return /statusCategory != Done/.test(jql) ? keys.filter((k) => !/done/i.test(this.data.issues[k]?.fields.status?.name || '')) : keys;
  }

  async search(jql: string): Promise<Issue[]> {
    this.queries.push(jql);
    const keyList = /key in \(([^)]*)\)/.exec(jql);
    if (keyList) {
      const keys = keyList[1].split(',').map((k) => k.trim().replace(/"/g, ''));
      return keys.map((k) => this.data.issues[k]).filter(Boolean);
    }
    const project = /project = "?([A-Z0-9_]+)"?/.exec(jql);
    return Object.values(this.data.issues).filter((i) => !project || i.key.startsWith(project[1] + '-'));
  }

  async comments(key: string): Promise<Comment[]> {
    return this.data.issues[key]?.fields.comment?.comments || [];
  }
}
