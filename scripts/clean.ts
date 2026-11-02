// Remove dist/ before a build so deleted sources do not leave stale files behind.
import fs from 'node:fs';

fs.rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
