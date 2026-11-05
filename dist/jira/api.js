// Jira Cloud REST access, GET only (ADR-0008). Board traversal uses the Agile API; issue details come
// from the v3 search, which returns descriptions and comments as ADF.
import { AtlassianClient } from "../core/http.js";
export const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'parent', 'subtasks', 'issuelinks', 'description', 'comment', 'attachment'];
export class JiraApi {
    http;
    constructor(opts) {
        this.http = new AtlassianClient(opts);
    }
    // Agile API pages with startAt / isLast (or total).
    async agile(path, key) {
        const out = [];
        for (let startAt = 0;;) {
            const sep = path.includes('?') ? '&' : '?';
            const j = await this.http.get(`${path}${sep}startAt=${startAt}&maxResults=100`);
            const page = j[key] || [];
            out.push(...page);
            startAt += page.length;
            if (!page.length || j.isLast === true || (typeof j.total === 'number' && startAt >= j.total))
                return out;
        }
    }
    board(id) {
        return this.http.get(`/rest/agile/1.0/board/${id}`);
    }
    async boardColumns(id) {
        const c = await this.http.get(`/rest/agile/1.0/board/${id}/configuration`);
        return (c.columnConfig && c.columnConfig.columns) || [];
    }
    activeSprints(boardId) {
        return this.agile(`/rest/agile/1.0/board/${boardId}/sprint?state=active`, 'values');
    }
    async sprintIssueKeys(boardId, sprintId) {
        return (await this.agile(`/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue?fields=status`, 'issues')).map((i) => i.key);
    }
    async boardIssueKeys(boardId, jql) {
        return (await this.agile(`/rest/agile/1.0/board/${boardId}/issue?fields=status&jql=${encodeURIComponent(jql)}`, 'issues')).map((i) => i.key);
    }
    async search(jql) {
        const out = [];
        let token;
        do {
            const q = `jql=${encodeURIComponent(jql)}&fields=${ISSUE_FIELDS.join(',')}&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`;
            const j = await this.http.get(`/rest/api/3/search/jql?${q}`);
            out.push(...(j.issues || []));
            token = j.isLast === false || j.nextPageToken ? j.nextPageToken : undefined;
        } while (token);
        return out;
    }
    async comments(key) {
        const out = [];
        for (let startAt = 0;;) {
            const j = await this.http.get(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
            const page = j.comments || [];
            out.push(...page);
            startAt += page.length;
            if (!page.length || startAt >= (j.total ?? 0))
                return out;
        }
    }
}
export class JiraFixtureApi {
    data;
    queries = [];
    constructor(data) {
        this.data = data;
    }
    b(id) {
        const b = this.data.boards[id];
        if (!b)
            throw new Error(`GET /rest/agile/1.0/board/${id} -> 404`);
        return b;
    }
    async board(id) {
        const b = this.b(id);
        return { id, name: b.name, type: b.type, location: b.projectKey ? { projectKey: b.projectKey } : undefined };
    }
    async boardColumns(id) {
        return (this.b(id).columns || []).map((c) => ({ name: c.name, statuses: c.statuses.map((s) => ({ id: s })) }));
    }
    async activeSprints(boardId) {
        const b = this.b(boardId);
        if (!b.sprints && b.type !== 'scrum')
            throw new Error(`GET /rest/agile/1.0/board/${boardId}/sprint -> 400 The board does not support sprints`);
        return (b.sprints || []).filter((s) => s.state === 'active').map(({ issues: _issues, ...s }) => s);
    }
    async sprintIssueKeys(boardId, sprintId) {
        return (this.b(boardId).sprints || []).find((s) => String(s.id) === sprintId)?.issues || [];
    }
    async boardIssueKeys(boardId, jql) {
        const keys = this.b(boardId).issues || [];
        return /statusCategory != Done/.test(jql) ? keys.filter((k) => !/done/i.test(this.data.issues[k]?.fields.status?.name || '')) : keys;
    }
    async search(jql) {
        this.queries.push(jql);
        const keyList = /key in \(([^)]*)\)/.exec(jql);
        if (keyList) {
            const keys = keyList[1].split(',').map((k) => k.trim().replace(/"/g, ''));
            return keys.map((k) => this.data.issues[k]).filter(Boolean);
        }
        const project = /project = "?([A-Z0-9_]+)"?/.exec(jql);
        return Object.values(this.data.issues).filter((i) => !project || i.key.startsWith(project[1] + '-'));
    }
    async comments(key) {
        return this.data.issues[key]?.fields.comment?.comments || [];
    }
}
