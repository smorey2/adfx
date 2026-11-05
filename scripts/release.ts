// npm run release <version>
// Checks, builds dist/, commits it with the new version, and tags v<version>. dist/ only changes here,
// so installs from a tag never need a build. Pushing is left to you:
//   git push origin HEAD --follow-tags && npm publish

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: npm run release <version>   e.g. npm run release 0.2.0');
  process.exit(1);
}

// npm is npm.cmd on Windows and needs a shell there; git does not, and a shell would split "Release vX".
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit', shell: cmd === 'npm' && process.platform === 'win32' });
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

// The package, the plugin (users only get plugin updates when its version changes) and the install
// line the plugin suggests all move to the new version together.
const setJsonVersion = (rel: string) => {
  const file = new URL(rel, import.meta.url);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
};
setJsonVersion('../package.json');
setJsonVersion('../plugins/adfx/.claude-plugin/plugin.json');
const skills = fs.readdirSync(new URL('../plugins/adfx/skills', import.meta.url)).map((s) => `../plugins/adfx/skills/${s}/SKILL.md`);
for (const rel of [...skills, '../README.md']) {
  const file = new URL(rel, import.meta.url);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/smorey2\/adfx#v\d+\.\d+\.\d+(-[\w.]+)?/g, `smorey2/adfx#v${version}`));
}

sh('npm', ['run', 'build']);
sh('git', ['add', '--all', 'package.json', 'plugins', 'README.md', 'dist']);
sh('git', ['commit', '-m', `Release v${version}`]);
sh('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);
console.log(`\nreleased v${version}. Push it with:\n  git push origin HEAD --follow-tags`);
