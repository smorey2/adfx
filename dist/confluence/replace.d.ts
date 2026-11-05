import { type AdfNode } from '../core/adf.ts';
import type { ConfluenceReader, PageWriter } from './api.ts';
import type { Scope } from './config.ts';
import type { Log } from './pull.ts';
export interface CellChange {
    from: string;
    to: string;
    row: string;
}
export declare function replaceInCells(adf: AdfNode, mapping: Record<string, string>): {
    adf: AdfNode;
    counts: Record<string, number>;
    changes: CellChange[];
    leftovers: Record<string, number>;
};
export interface ReplaceMap {
    message?: string;
    pages?: Record<string, Record<string, string>>;
}
export interface ReplaceResult {
    id: string;
    title: string;
    version: number;
    changes: number;
    written: boolean;
    newVersion?: number;
}
export declare function replaceText({ api, scope, map, apply, write, log }: {
    api: ConfluenceReader;
    scope: Scope;
    map: ReplaceMap;
    apply?: boolean;
    write?: PageWriter;
    log?: Log;
}): Promise<ReplaceResult[]>;
