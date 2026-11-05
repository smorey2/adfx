import type { AdfNode } from './adf.ts';
import type { Refs } from './adoc.ts';
export interface Meta {
    adf?: string;
    macro?: string;
    placeholder?: string;
    label?: string;
    nestedTable?: AdfNode;
    cellStyle?: string;
    colwidth?: number[];
    layout?: string;
    head?: boolean;
    key?: string;
    day?: string;
}
export interface ParseOptions {
    headingOffset?: number;
    refs?: Refs;
    resolveXref?: (file: string) => string | null | undefined;
}
export interface ParsedBlock {
    node: AdfNode;
    text: string;
}
export interface ParseResult {
    blocks: ParsedBlock[];
    errors: string[];
}
interface BlockAttrs {
    positional: string[];
    named: Record<string, string>;
    roles: string[];
    options: string[];
    adf: string | undefined;
}
export declare const meta: (node: object | null | undefined) => Meta;
export declare function parse(body: string, opts?: ParseOptions): ParseResult;
export declare function parseAttrs(str: string): BlockAttrs;
export {};
