import type { Credentials } from './http.ts';
export interface Resolved extends Credentials {
    source: string;
}
export declare function configDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export declare function credentialsFile(env?: NodeJS.ProcessEnv): string;
export declare function resolveCredentials(site: string, env?: NodeJS.ProcessEnv): Resolved | null;
export declare function requireCredentials(site: string, env?: NodeJS.ProcessEnv): Resolved;
export declare function saveCredentials(site: string | null, creds: Credentials, env?: NodeJS.ProcessEnv): string;
export declare function removeCredentials(site: string | null, env?: NodeJS.ProcessEnv): boolean;
