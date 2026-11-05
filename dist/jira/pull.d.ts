import { type LinkResolution } from '../core/adoc.ts';
import { type Board, type BoardColumn, type Issue, type JiraReader, type Sprint } from './api.ts';
import type { JiraConfig, Include } from './config.ts';
export type Log = (line: string) => void;
export interface JiraPullReport {
    written: string[];
    unchanged: string[];
    deleted: string[];
    issues: number;
}
interface BoardView {
    board: Board;
    file: string;
    columns: BoardColumn[];
    sprints: {
        sprint: Sprint | null;
        keys: string[];
    }[];
}
export declare function pullJira({ api, config, dryRun, log }: {
    api: JiraReader;
    config: JiraConfig;
    dryRun?: boolean;
    log?: Log;
}): Promise<JiraPullReport>;
export declare function renderIssue(issue: Issue, opts: {
    site: string;
    include: Include[];
    sprint?: string;
    resolveLink: (href: string) => LinkResolution;
}): string;
export declare function renderBoard(view: BoardView, issues: Map<string, Issue>, opts: {
    site: string;
    resolveLink: (href: string) => LinkResolution;
}): string;
export {};
