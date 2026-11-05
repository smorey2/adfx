// AsciiDoc document header with sync attributes (ADR-0005 §1, §5).
import crypto from 'node:crypto';
export function hash(body) {
    return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}
// attrs: [name, value] pairs; a null, undefined or false value is omitted
export function render(title, attrs, body) {
    const lines = ['= ' + String(title).replace(/\s+/g, ' ').trim()];
    for (const [k, v] of attrs)
        if (v !== null && v !== undefined && v !== false)
            lines.push(`:${k}:${v === true ? '' : ' ' + v}`);
    return lines.join('\n') + '\n\n' + body;
}
// The header runs from the "= Title" line to the first blank line.
export function parse(text) {
    const t = text.replace(/\r\n/g, '\n');
    const lines = t.split('\n');
    if (!lines[0] || !lines[0].startsWith('= '))
        return null;
    const attrs = {};
    let i = 1;
    for (; i < lines.length && lines[i] !== ''; i++) {
        const m = /^:([\w-]+):\s*(.*)$/.exec(lines[i]);
        if (m)
            attrs[m[1]] = m[2];
    }
    const body = lines.slice(i + 1).join('\n');
    return { title: lines[0].slice(2), attrs, body };
}
