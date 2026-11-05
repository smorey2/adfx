import { type Log } from './pull.ts';
import type { ConfluenceReader, PageCreator, PageWriter } from './api.ts';
import type { Scope } from './config.ts';
export type PublishStatus = 'unchanged' | 'refused' | 'conflict' | 'needs --accept-loss' | 'ready' | 'published' | 'created' | 'ok' | 'pull-only blocks';
export interface PublishResult {
    id: string;
    rel: string;
    status: PublishStatus;
    errors: string[];
    losses: string[];
    newVersion?: number;
}
export interface PublishOptions {
    api: ConfluenceReader;
    scope: Scope;
    outDir: string;
    files?: string[];
    pages?: string[];
    apply?: boolean;
    acceptLoss?: boolean;
    check?: boolean;
    message?: string | null;
    write?: PageWriter;
    create?: PageCreator;
    repull?: (id: string) => Promise<unknown>;
    log?: Log;
}
export declare function publish({ api, scope, outDir, files, pages, apply, acceptLoss, check, message, write, create, repull, log }: PublishOptions): Promise<PublishResult[]>;
export declare function lineDiff(a: string, b: string): string;
