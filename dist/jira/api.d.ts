import { type Credentials, type FetchLike } from '../core/http.ts';
import type { AdfNode } from '../core/adf.ts';
export interface Board {
    id: number | string;
    name: string;
    type: string;
    location?: {
        projectKey?: string;
        projectName?: string;
    };
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
    statuses: {
        id: string;
    }[];
}
export interface IssueRef {
    key: string;
    fields?: {
        summary?: string;
        status?: {
            name?: string;
        };
    };
}
export interface Comment {
    id: string;
    author?: {
        displayName?: string;
    };
    created: string;
    body?: AdfNode | null;
}
export interface Issue {
    id: string;
    key: string;
    fields: {
        summary?: string;
        status?: {
            id?: string;
            name?: string;
        };
        issuetype?: {
            name?: string;
        };
        priority?: {
            name?: string;
        } | null;
        assignee?: {
            displayName?: string;
        } | null;
        reporter?: {
            displayName?: string;
        } | null;
        labels?: string[];
        created?: string;
        updated?: string;
        parent?: IssueRef | null;
        subtasks?: IssueRef[];
        issuelinks?: {
            type: {
                inward: string;
                outward: string;
            };
            inwardIssue?: IssueRef;
            outwardIssue?: IssueRef;
        }[];
        description?: AdfNode | null;
        comment?: {
            comments: Comment[];
            total?: number;
        };
        attachment?: {
            filename: string;
            content: string;
        }[];
    };
}
export declare const ISSUE_FIELDS: string[];
export interface JiraReader {
    board(id: string): Promise<Board>;
    boardColumns(id: string): Promise<BoardColumn[]>;
    activeSprints(boardId: string): Promise<Sprint[]>;
    sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]>;
    boardIssueKeys(boardId: string, jql: string): Promise<string[]>;
    search(jql: string): Promise<Issue[]>;
    comments(key: string): Promise<Comment[]>;
}
export declare class JiraApi implements JiraReader {
    private readonly http;
    constructor(opts: {
        site: string;
        fetchImpl?: FetchLike;
    } & Credentials);
    private agile;
    board(id: string): Promise<Board>;
    boardColumns(id: string): Promise<BoardColumn[]>;
    activeSprints(boardId: string): Promise<Sprint[]>;
    sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]>;
    boardIssueKeys(boardId: string, jql: string): Promise<string[]>;
    search(jql: string): Promise<Issue[]>;
    comments(key: string): Promise<Comment[]>;
}
export interface JiraFixture {
    boards: Record<string, {
        name: string;
        type: string;
        projectKey?: string;
        columns?: {
            name: string;
            statuses: string[];
        }[];
        sprints?: (Sprint & {
            issues: string[];
        })[];
        issues?: string[];
    }>;
    issues: Record<string, Issue>;
}
export declare class JiraFixtureApi implements JiraReader {
    data: JiraFixture;
    queries: string[];
    constructor(data: JiraFixture);
    private b;
    board(id: string): Promise<Board>;
    boardColumns(id: string): Promise<BoardColumn[]>;
    activeSprints(boardId: string): Promise<Sprint[]>;
    sprintIssueKeys(boardId: string, sprintId: string): Promise<string[]>;
    boardIssueKeys(boardId: string, jql: string): Promise<string[]>;
    search(jql: string): Promise<Issue[]>;
    comments(key: string): Promise<Comment[]>;
}
