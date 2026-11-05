import { type FetchLike, type Credentials } from '../core/http.ts';
import type { AdfNode } from '../core/adf.ts';
export interface PageMeta {
    id: string;
    type?: string;
    status?: string;
    title: string;
    parentId?: string | null;
    spaceId: string;
    version: {
        number: number;
        createdAt?: string;
    };
    body?: {
        atlas_doc_format?: {
            value: string;
        };
    };
}
export interface FolderMeta {
    id: string;
    type?: string;
    title: string;
    parentId?: string | null;
    spaceId: string;
}
export interface ChildRef {
    id: string | number;
    type: string;
    title: string;
    status?: string;
}
export interface Attachment {
    id?: string;
    title: string;
    fileId?: string;
    fileSize?: number;
    mediaType?: string;
    downloadLink: string;
}
export interface ConfluenceReader {
    page(id: string): Promise<PageMeta>;
    folder(id: string): Promise<FolderMeta>;
    spaceKey(spaceId: string): Promise<string>;
    children(id: string, type: string): Promise<ChildRef[]>;
    cql(cql: string): Promise<ChildRef[]>;
    attachments(pageId: string): Promise<Attachment[]>;
    download(downloadLink: string): Promise<Buffer>;
}
export interface PageUpdate {
    id: string;
    title: string;
    adf: AdfNode;
    version: number;
    message: string;
}
export type PageWriter = (u: PageUpdate) => Promise<{
    version?: {
        number: number;
    };
} | undefined>;
export declare class ConfluenceApi implements ConfluenceReader {
    private readonly http;
    private readonly spaceKeys;
    constructor(opts: {
        site: string;
        fetchImpl?: FetchLike;
    } & Credentials);
    private paged;
    page(id: string): Promise<PageMeta>;
    folder(id: string): Promise<FolderMeta>;
    spaceKey(spaceId: string): Promise<string>;
    children(id: string, type: string): Promise<ChildRef[]>;
    cql(cql: string): Promise<ChildRef[]>;
    attachments(pageId: string): Promise<Attachment[]>;
    download(downloadLink: string): Promise<Buffer>;
    currentUser(): Promise<{
        displayName?: string;
        email?: string;
    }>;
}
export declare function pageWriter(opts: {
    site: string;
    fetchImpl?: FetchLike;
} & Credentials): PageWriter;
export interface NewPage {
    spaceId: string;
    parentId: string;
    title: string;
    adf: AdfNode;
}
export type PageCreator = (p: NewPage) => Promise<{
    id: string;
    version?: {
        number: number;
    };
}>;
export declare function pageCreator(opts: {
    site: string;
    fetchImpl?: FetchLike;
} & Credentials): PageCreator;
export interface FixtureData {
    spaces: Record<string, string>;
    content: Record<string, {
        type: string;
        title: string;
        parentId?: string;
        spaceId: string;
        status?: string;
        version?: number;
        createdAt?: string;
        adf?: AdfNode;
        attachments?: (Attachment & {
            base64?: string;
        })[];
    }>;
}
export declare class FixtureApi implements ConfluenceReader {
    data: FixtureData;
    calls: [string, string][];
    constructor(data: FixtureData);
    private item;
    page(id: string): Promise<PageMeta>;
    folder(id: string): Promise<FolderMeta>;
    spaceKey(spaceId: string): Promise<string>;
    children(id: string): Promise<ChildRef[]>;
    cql(cql: string): Promise<ChildRef[]>;
    attachments(pageId: string): Promise<Attachment[]>;
    download(link: string): Promise<Buffer>;
}
