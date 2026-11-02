// npm run release <version>
// Checks, builds dist/, commits it with the new version, and tags v<version>. dist/ only changes here,
// so installs from a tag never need a build. Pushing is left to you:
//   git push origin HEAD --follow-tags

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: npm run release <version>   e.g. npm run release 0.2.0');
  process.exit(1);
}

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const out = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

if (out('git', ['status', '--porcelain'])) {
  console.error('commit or stash your changes first; a release must build from a clean tree');
  process.exit(1);
}
if (out('git', ['tag', '--list', `v${version}`])) {
  console.error(`tag v${version} already exists`);
  process.exit(1);
}

sh('npm', ['run', 'typecheck']);
sh('npm', ['test']);

const pkgFile = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

sh('npm', ['run', 'build']);
sh('git', ['add', '--all', 'package.json', 'dist']);
sh('git', ['commit', '-m', `Release v${version}`]);
sh('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);
console.log(`\nreleased v${version}. Push it with:\n  git push origin HEAD --follow-tags`);
