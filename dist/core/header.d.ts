export interface Header {
    title: string;
    attrs: Record<string, string>;
    body: string;
}
export declare function hash(body: string): string;
export declare function render(title: string, attrs: [string, string | number | boolean | null | undefined][], body: string): string;
export declare function parse(text: string): Header | null;
