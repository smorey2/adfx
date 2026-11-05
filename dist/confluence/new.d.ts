import { type Log } from './pull.ts';
import type { ConfluenceReader } from './api.ts';
import type { ConfluenceConfig } from './config.ts';
export interface NewPageOptions {
    api: ConfluenceReader;
    config: ConfluenceConfig;
    outDir: string;
    title: string;
    parentId: string;
    template?: string;
    log?: Log;
}
export declare function newPage({ api, config, outDir, title, parentId, template, log }: NewPageOptions): Promise<string>;
