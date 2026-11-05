import { type LinkResolution, type MediaResolution } from '../core/adoc.ts';
import { type AdfNode, type Attrs } from '../core/adf.ts';
import { type TreeNode } from './layout.ts';
import type { Attachment, ConfluenceReader, PageMeta } from './api.ts';
import type { Scope } from './config.ts';
export type Log = (line: string) => void;
export interface PullReport {
    written: string[];
    upToDate: string[];
    localEdits: string[];
    conflicts: string[];
    moved: string[];
    empty: string[];
    orphans: string[];
    excluded: string[];
    skippedTypes: string[];
    pages: Record<string, unknown>;
}
export interface PullOptions {
    api: ConfluenceReader;
    scope: Scope;
    outDir: string;
    dryRun?: boolean;
    force?: boolean;
    only?: string[];
    log?: Log;
}
export declare function pull({ api, scope, outDir, dryRun, force, only, log }: PullOptions): Promise<PullReport>;
export interface Discovered {
    nodes: Map<string, TreeNode>;
    roots: {
        id: string;
        spaceKey: string;
    }[];
    pageCache: Map<string, PageMeta>;
}
export declare function discover(api: ConfluenceReader, scope: Scope, report?: {
    excluded: string[];
    skippedTypes: string[];
}): Promise<Discovered>;
export declare function mediaResolver(attachments: Attachment[] | null, attDir: string): {
    resolveMedia: (a: Attrs) => MediaResolution;
    downloads: Map<string, Attachment>;
};
export declare function makeLinkResolver(site: string, pageId: string, fromRel: string, fileOf: (id: string) => string | null, nodes: Map<string, TreeNode>): (href: string) => LinkResolution;
export declare function hasMedia(adf: AdfNode): boolean;
export interface ExistingFile {
    rel: string;
    title: string;
    version: string;
    localEdits: boolean;
}
export declare function indexExisting(outDir: string): Map<string, ExistingFile>;
export interface DraftFile {
    rel: string;
    title: string;
    parentId: string;
}
export declare function indexDrafts(outDir: string): Map<string, DraftFile>;
