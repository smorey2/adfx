export declare const JIRA_CONFIG_NAMES: string[];
export declare const INCLUDE: readonly ["description", "comments", "subtasks", "links"];
export type Include = (typeof INCLUDE)[number];
export interface JiraConfig {
    file: string | null;
    root: string;
    site: string;
    out: string;
    boards: {
        id: string;
        sprints: 'active';
    }[];
    projects: {
        key: string;
        jql?: string;
    }[];
    include: Include[];
}
export declare function parseJiraConfig(text: string, { file, root }?: {
    file?: string | null;
    root?: string;
}): JiraConfig;
export declare function loadJiraConfig({ start, explicit }?: {
    start?: string;
    explicit?: string;
}): JiraConfig;
