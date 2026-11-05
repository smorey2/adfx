export interface Credentials {
    email: string;
    token: string;
}
export type FetchLike = typeof globalThis.fetch;
export declare class AtlassianClient {
    readonly site: string;
    readonly origin: string;
    private readonly auth;
    private readonly fetch;
    constructor({ site, email, token, fetchImpl }: {
        site: string;
        fetchImpl?: FetchLike;
    } & Credentials);
    get(path: string): Promise<any>;
    get(path: string, opts: {
        binary: true;
    }): Promise<Buffer>;
    send(method: 'PUT' | 'POST', path: string, body: unknown, hint409?: string): Promise<any>;
}
