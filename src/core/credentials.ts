// Where each person's Atlassian email and API token live (ADR-0006 §3).
//
// Resolution order for a site:
//   1. ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN (CI, or anyone who prefers env vars)
//   2. CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN (older setups)
//   3. the credentials file, entry for that site, then the default entry
//
// The file is per user and outside every repo: %APPDATA%\adf-bridge\credentials.json on Windows,
// $XDG_CONFIG_HOME/adf-bridge/credentials.json (default ~/.config) elsewhere, readable only by the
// user. The token is never printed or logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Credentials } from './http.ts';

interface StoreFile {
  default?: Credentials;
  sites?: Record<string, Credentials>;
}

export interface Resolved extends Credentials {
  source: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ADF_BRIDGE_CONFIG_DIR) return env.ADF_BRIDGE_CONFIG_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'adf-bridge');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'adf-bridge');
}

export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'credentials.json');
}

function readStore(file: string): StoreFile {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it or run "adf-bridge logout" and log in again`);
  }
}

function writeStore(file: string, store: StoreFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function resolveCredentials(site: string, env: NodeJS.ProcessEnv = process.env): Resolved | null {
  if (env.ATLASSIAN_EMAIL && env.ATLASSIAN_API_TOKEN) return { email: env.ATLASSIAN_EMAIL, token: env.ATLASSIAN_API_TOKEN, source: 'ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN' };
  if (env.CONFLUENCE_EMAIL && env.CONFLUENCE_API_TOKEN) return { email: env.CONFLUENCE_EMAIL, token: env.CONFLUENCE_API_TOKEN, source: 'CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN' };
  const file = credentialsFile(env);
  const store = readStore(file);
  const hit = (store.sites && store.sites[site]) || store.default;
  if (hit && hit.email && hit.token) return { email: hit.email, token: hit.token, source: file };
  return null;
}

export function requireCredentials(site: string, env: NodeJS.ProcessEnv = process.env): Resolved {
  const c = resolveCredentials(site, env);
  if (!c) throw new Error(`no Atlassian credentials for ${site}: run "adf-bridge login" (or set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN)`);
  return c;
}

export function saveCredentials(site: string | null, creds: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsFile(env);
  const store = readStore(file);
  if (site) store.sites = { ...(store.sites || {}), [site]: creds };
  else store.default = creds;
  writeStore(file, store);
  return file;
}

export function removeCredentials(site: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsFile(env);
  const store = readStore(file);
  let removed = false;
  if (site && store.sites && store.sites[site]) {
    delete store.sites[site];
    removed = true;
  } else if (!site && store.default) {
    delete store.default;
    removed = true;
  }
  if (removed) writeStore(file, store);
  return removed;
}
