export type Attrs = Record<string, any>;
export interface AdfMark {
    type: string;
    attrs?: Attrs;
}
export interface AdfNode {
    type: string;
    attrs?: Attrs;
    content?: AdfNode[];
    marks?: AdfMark[];
    text?: string;
    version?: number;
}
export interface AdfDoc extends AdfNode {
    type: 'doc';
    content: AdfNode[];
}
export declare function walk(n: AdfNode | null | undefined, fn: (n: AdfNode) => void): void;
export declare function parseAdf(value: string | null | undefined): AdfDoc;
