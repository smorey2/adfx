export declare const CONFIG_NAMES: string[];
export interface Root {
    id: string;
    type: 'page' | 'folder';
    space?: string;
    title?: string;
}
export interface Scope {
    site: string;
    roots: Root[];
    exclude: string[];
}
export interface ConfluenceConfig extends Scope {
    file: string | null;
    root: string;
    out: string;
    message: string;
    main: {
        wording: string[];
    };
    templates: Record<string, string>;
}
export declare function parseConfluenceConfig(text: string, { file, root }?: {
    file?: string | null;
    root?: string;
}): ConfluenceConfig;
export declare function loadConfluenceConfig({ start, explicit }?: {
    start?: string;
    explicit?: string;
}): ConfluenceConfig;
