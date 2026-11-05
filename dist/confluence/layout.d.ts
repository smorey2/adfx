export interface TreeNode {
    id: string;
    type: 'page' | 'folder';
    title: string;
    parentId: string | null;
    rootId: string;
    children: string[];
    excluded: boolean;
}
export declare function slug(title: string): string;
export declare function layoutTree(nodes: Map<string, TreeNode>, roots: {
    id: string;
    spaceKey: string;
}[]): Map<string, {
    dir: string;
    file: string;
}>;
export declare function safeFileName(name: string): string;
