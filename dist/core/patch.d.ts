import type { AdfNode } from './adf.ts';
import { type ParseOptions } from './adoc-parse.ts';
import { type ConvertResult, type Refs } from './adoc.ts';
interface Env {
    refs: Refs;
    shortIds: Map<string, string>;
    errors: string[];
    newMacros?: boolean;
}
export interface Change {
    kind: 'changed' | 'added' | 'removed';
    old?: number;
    new?: number;
}
export interface Patch {
    adf: AdfNode;
    changes: Change[];
    moved: boolean;
    errors: string[];
    losses: string[];
    oldText: (j: number) => string;
    newText: (i: number) => string;
    describeOld: (j: number) => string;
}
export interface PatchInput {
    liveAdf: AdfNode;
    conv: ConvertResult;
    body: string;
    parseOpts: ParseOptions;
    shortIds: Map<string, string>;
    newPage?: boolean;
}
export declare function buildPatch({ liveAdf, conv, body, parseOpts, shortIds, newPage }: PatchInput): Patch;
export declare function gate(node: AdfNode, chunkText: string, parseOpts: ParseOptions, env: {
    refs: Refs;
    shortIds: Map<string, string>;
}): {
    ok: boolean;
    why?: string | null;
};
export declare function recover(n: AdfNode, o: AdfNode | null | undefined, env: Env): AdfNode | null;
export declare function lcs<T>(a: T[], b: T[]): [number, number][];
export declare function same(a: unknown, b: unknown): boolean;
export declare function norm(n: unknown): any;
export declare function adfChanges(a: any, b: any, path?: string, out?: string[]): string[];
export {};
