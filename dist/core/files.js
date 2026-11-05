import fs from 'node:fs';
import path from 'node:path';
// Write via a temp file and rename, so an interrupted run never leaves half a file.
export function writeFile(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}
// Relative path with forward slashes, as used in mirrors and links on every OS.
export function relPosix(from, to) {
    return path.relative(from, to).split(path.sep).join('/');
}
// Walk up from `start` to the first directory containing one of `names`.
export function findUp(start, names) {
    let dir = path.resolve(start);
    for (;;) {
        for (const n of names) {
            const f = path.join(dir, n);
            if (fs.existsSync(f))
                return f;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
