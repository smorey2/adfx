import { type AdfNode, type Attrs } from './adf.ts';
export interface LinkResolution {
    url?: string;
    anchor?: string;
    xref?: string;
    fragment?: string;
    outOfScope?: boolean;
}
export interface MediaResolution {
    url?: string;
    path?: string;
    expected?: string;
    title?: string;
}
export interface ConvertReport {
    unsupported: Record<string, number>;
    missingMedia: string[];
    outOfScopeLinks: number;
    cellBackgrounds: number;
}
export interface Refs {
    links: Map<string, Set<string>>;
    media: Map<string, AdfNode>;
    mentions: Map<string, Attrs>;
}
export interface Chunk {
    node: AdfNode;
    text: string;
}
export interface ConvertOptions {
    resolveLink?: (href: string) => LinkResolution;
    resolveMedia?: (attrs: Attrs) => MediaResolution;
}
export interface ConvertResult {
    body: string;
    toc: boolean;
    headingOffset: number;
    report: ConvertReport;
    chunks: Chunk[];
    refs: Refs;
}
export declare function convert(adf: AdfNode, opts?: ConvertOptions): ConvertResult;
export declare function placeholderLabel(n: AdfNode, key: string): string;
export declare function anchorId(s: string): string;
export declare function buildShortIds(adf: AdfNode): Map<string, string>;
export declare function isEmptyDoc(adf: AdfNode | null | undefined): boolean;
