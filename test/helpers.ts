import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfluenceConfig } from '../src/confluence/config.ts';

export const tmp = (prefix = 'adfx-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const scopeOf = (yaml: string) => parseConfluenceConfig(yaml, { root: tmp() });

export const quiet = () => {};
