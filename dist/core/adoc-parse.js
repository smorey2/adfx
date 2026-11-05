// AsciiDoc -> ADF parser for the subset written by adoc.ts (ADR-0005 §2, §4). It is the inverse of
// convert(): what AsciiDoc does not carry (local IDs, cell colours, macro settings) is recovered from
// the live page by patch.ts. Links, images and mentions are mapped back through convert()'s refs.
//
//   parse(body, { headingOffset, refs, resolveXref }) -> { blocks: [{ node, text }], errors }
const info = new WeakMap();
const tag = (node, data) => (info.set(node, { ...(info.get(node) || {}), ...data }), node);
export const meta = (node) => (node && info.get(node)) || {};
const LIST_LINE = /^(\*+|\.+) (.*)$/;
const ATTR_LINE = /^\[(?!\[).*\]$/;
const PANEL_OF_STYLE = { NOTE: 'info', TIP: 'success', WARNING: 'warning', CAUTION: 'error', IMPORTANT: 'warning' };
const ALIGN = /^\.text-(left|center|right|start|end)$/;
export function parse(body, opts = {}) {
    const env = { opts, errors: [] };
    const p = new Parser(body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n'), env, '');
    const blocks = p.blocks({ top: true });
    return { blocks: blocks.map((b) => ({ node: b.node, text: p.lines.slice(b.start, b.end).join('\n') })), errors: env.errors };
}
class Parser {
    lines;
    env;
    seps; // active table separators, outermost first
    i;
    constructor(lines, env, seps) {
        this.lines = lines;
        this.env = env;
        this.seps = seps;
        this.i = 0;
    }
    error(msg) {
        this.env.errors.push(msg);
    }
    get line() {
        return this.lines[this.i];
    }
    skipBlank() {
        while (this.i < this.lines.length && this.lines[this.i] === '')
            this.i++;
    }
    // Blocks until the end, or until ctx.stop (a closing delimiter) or a layout marker at a block boundary.
    blocks(ctx) {
        const out = [];
        for (;;) {
            this.skipBlank();
            const l = this.line;
            if (l === undefined || (ctx.stop !== undefined && l === ctx.stop))
                break;
            if (ctx.layout && /^\/\/ confluence:layout-(column|end)\b/.test(l))
                break;
            if (l === '//-') {
                this.i++;
                continue;
            }
            const start = this.i;
            const node = this.block(ctx);
            let end = this.i;
            while (end > start && this.lines[end - 1] === '')
                end--;
            if (node)
                out.push({ node, start, end });
            else if (this.i === start)
                this.i++; // never stall
        }
        return out;
    }
    block(ctx) {
        let title = null;
        let attrs = null;
        for (;;) {
            const l = this.line;
            if (l === undefined)
                return null;
            if (l.startsWith('// confluence: image not attached'))
                this.i++;
            else if (/^\/\/ confluence:layout-section\b/.test(l))
                return this.layout(ctx);
            else if (/^\/{4,}$/.test(l)) {
                const close = l;
                this.i++;
                while (this.i < this.lines.length && this.line !== close)
                    this.i++;
                this.i++;
                return null;
            }
            else if (/^\/\/(?!\/)/.test(l) && !/^\/\/ confluence:layout-/.test(l) && l !== '//-') {
                this.i++;
                if (this.line === undefined || this.line === '')
                    return null;
            }
            else if (/^\.(?:[^\s.]|\{empty\})/.test(l) && !LIST_LINE.test(l)) {
                title = l.slice(1);
                this.i++;
            }
            else if (ATTR_LINE.test(l) && this.lines[this.i + 1] !== undefined && this.lines[this.i + 1] !== '') {
                attrs = parseAttrs(l.slice(1, -1));
                this.i++;
            }
            else
                break;
        }
        const a = attrs || parseAttrs('');
        const l = this.line;
        let m;
        if (l === undefined)
            return null;
        if ((m = /^(={2,7}) (.*)$/.exec(l)))
            return this.heading(m, a);
        if (l === "'''") {
            this.i++;
            return tag({ type: 'rule' }, { adf: a.adf });
        }
        if ((m = /^toc::\[(.*)\]$/.exec(l))) {
            this.i++;
            return tag({ type: 'extension', attrs: { extensionKey: 'toc' } }, { adf: parseAttrs(m[1]).adf, macro: 'toc' });
        }
        if ((m = /^image::(.*?)\[(.*)\]$/.exec(l))) {
            this.i++;
            return this.image(m[1], parseAttrs(m[2]), a, title);
        }
        if (/^-{4,}$/.test(l))
            return this.code(l, a);
        if (/^_{4,}$/.test(l))
            return tag({ type: 'blockquote', content: this.delimited(l, ctx) }, { adf: a.adf });
        if (/^={4,}$/.test(l))
            return this.example(l, a, title, ctx);
        if (l === '--')
            return this.open(a, ctx);
        if (/^\.{4,}$/.test(l))
            return this.literal(l, a);
        if ((m = /^([|!])===$/.exec(l)))
            return this.table(m[1], a);
        if (a.named.confluence === 'blockCard' || a.named.confluence === 'embedCard') {
            const c = /^link:(\S+)\[\]$/.exec(l);
            if (c) {
                this.i++;
                const r = this.linkTarget('link:' + c[1]);
                return tag({ type: a.named.confluence, attrs: { url: r.href } }, { adf: a.adf });
            }
        }
        if (LIST_LINE.test(l))
            return this.list(a, ctx);
        return this.paragraph(a, ctx);
    }
    heading(m, attrs) {
        this.i++;
        const level = Math.min(6, Math.max(1, m[1].length - 1 + (this.env.opts.headingOffset || 0)));
        const node = { type: 'heading', attrs: { level } };
        const content = this.inline(m[2]);
        if (content.length)
            node.content = content;
        const marks = blockMarks(attrs);
        if (marks.length)
            node.marks = marks;
        return tag(node, { adf: attrs.adf });
    }
    paragraph(attrs, ctx) {
        const lines = [];
        while (this.i < this.lines.length) {
            const l = this.lines[this.i];
            if (l === '' || (ctx.stop !== undefined && l === ctx.stop))
                break;
            if (lines.length && ctx.inList && (l === '+' || LIST_LINE.test(l)))
                break;
            if (lines.length && /^\/\/ confluence:layout-/.test(l))
                break;
            lines.push(l);
            this.i++;
        }
        return this.paragraphNode(lines.join('\n'), attrs);
    }
    paragraphNode(text, attrs) {
        const node = { type: 'paragraph' };
        const content = this.inline(text);
        if (content.length)
            node.content = content;
        const marks = blockMarks(attrs);
        if (marks.length)
            node.marks = marks;
        return tag(node, { adf: attrs.adf });
    }
    // Content between an opening delimiter line and the identical closing line.
    delimited(open, _ctx) {
        this.i++;
        const kids = this.blocks({ stop: open, top: true, inList: false, layout: false });
        if (this.line === open)
            this.i++;
        else
            this.error(`unclosed block "${open}"`);
        return kids.map((b) => b.node);
    }
    code(open, attrs) {
        this.i++;
        const lines = [];
        while (this.i < this.lines.length && this.line !== open)
            lines.push(this.lines[this.i++]);
        if (this.line === open)
            this.i++;
        else
            this.error(`unclosed code block "${open}"`);
        const lang = attrs.positional[0] === 'source' ? attrs.positional[1] : undefined;
        const node = { type: 'codeBlock', attrs: { language: lang || undefined } };
        const text = lines.join('\n');
        if (text)
            node.content = [{ type: 'text', text }];
        return tag(node, { adf: attrs.adf });
    }
    literal(open, attrs) {
        this.i++;
        const lines = [];
        while (this.i < this.lines.length && this.line !== open)
            lines.push(this.lines[this.i++]);
        if (this.line === open)
            this.i++;
        if (attrs.named.confluence) {
            // read-only placeholder for a macro the converter does not handle; patch.ts copies the live node
            return tag({ type: attrs.named.confluence }, { adf: attrs.adf, placeholder: attrs.named.key || attrs.named.confluence, label: lines.join('\n') });
        }
        const node = { type: 'codeBlock', attrs: { language: undefined } };
        if (lines.length)
            node.content = [{ type: 'text', text: lines.join('\n') }];
        return tag(node, { adf: attrs.adf });
    }
    example(open, attrs, title, ctx) {
        const kind = attrs.named.confluence;
        if (kind === 'details' || kind === 'excerpt' || kind === 'bodied-extension') {
            const key = kind === 'bodied-extension' ? attrs.named.key : kind;
            return tag({ type: 'bodiedExtension', attrs: { extensionKey: key }, content: this.delimited(open, ctx) }, { adf: attrs.adf, macro: key });
        }
        if (attrs.options.includes('collapsible')) {
            const type = attrs.named.expand === 'nested' ? 'nestedExpand' : 'expand';
            const t = title === null ? '' : plain(this.inline(title));
            return tag({ type, attrs: { title: t }, content: this.delimited(open, ctx) }, { adf: attrs.adf });
        }
        const style = attrs.positional[0] && attrs.positional[0].split(/[#.%]/)[0];
        if (attrs.named.panel || PANEL_OF_STYLE[style]) {
            return tag({ type: 'panel', attrs: { panelType: attrs.named.panel || PANEL_OF_STYLE[style] }, content: this.delimited(open, ctx) }, { adf: attrs.adf });
        }
        this.error(`line ${this.i + 1}: example blocks ("${open}") without a panel or collapsible style are not supported`);
        return tag({ type: 'panel', attrs: { panelType: 'info' }, content: this.delimited(open, ctx) }, { adf: attrs.adf });
    }
    open(attrs, ctx) {
        const kind = attrs.named.confluence;
        const key = kind === 'bodied-extension' ? attrs.named.key : kind;
        if (!key)
            this.error(`line ${this.i + 1}: open blocks ("--") are only used for Confluence macros`);
        return tag({ type: 'bodiedExtension', attrs: { extensionKey: key }, content: this.delimited('--', ctx) }, { adf: attrs.adf, macro: key });
    }
    image(target, macro, attrs, title) {
        const live = this.env.opts.refs && this.env.opts.refs.media.get(target);
        if (!live)
            this.error(`new image "${target}": images cannot be uploaded from the repo yet; add it in Confluence`);
        const media = live ? cloneRef(live) : { type: 'media', attrs: { type: 'file', alt: macro.positional[0] } };
        const node = { type: 'mediaSingle', attrs: {}, content: [media] };
        if (macro.named.width)
            Object.assign(node.attrs, { width: Number(macro.named.width), widthType: 'pixel' });
        const layout = macro.named.align === 'center' ? 'center' : macro.named.float === 'left' ? 'wrap-left' : macro.named.float === 'right' ? 'wrap-right' : undefined;
        if (layout)
            node.attrs.layout = layout;
        if (title !== null) {
            const content = this.inline(title);
            node.content.push(content.length ? { type: 'caption', content } : { type: 'caption' });
        }
        return tag(node, { adf: attrs.adf, layout });
    }
    layout(ctx) {
        const kv = (s) => Object.fromEntries([...s.matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
        const section = tag({ type: 'layoutSection', content: [] }, { adf: kv(this.line).adf });
        this.i++;
        for (;;) {
            this.skipBlank();
            const l = this.line;
            if (l === undefined) {
                this.error('layout section without "// confluence:layout-end"');
                break;
            }
            if (/^\/\/ confluence:layout-end\b/.test(l)) {
                this.i++;
                break;
            }
            if (/^\/\/ confluence:layout-column\b/.test(l)) {
                const a = kv(l);
                this.i++;
                const content = this.blocks({ ...ctx, layout: true, top: true }).map((b) => b.node);
                section.content.push(tag({ type: 'layoutColumn', attrs: { width: a.width ? Number(a.width) : undefined }, content }, { adf: a.adf }));
                continue;
            }
            this.error(`line ${this.i + 1}: expected a layout column marker`);
            this.i++;
        }
        return section;
    }
    // ---------- lists ----------
    list(attrs, ctx) {
        const first = LIST_LINE.exec(this.line);
        const root = this.newList(first, attrs);
        const stack = [{ list: root, depth: first[1].length, kind: first[1][0], item: null }];
        let pending = null;
        for (;;) {
            const l = this.line;
            if (l === undefined || (ctx.stop !== undefined && l === ctx.stop))
                break;
            const m = LIST_LINE.exec(l);
            if (m) {
                const depth = m[1].length;
                const kind = m[1][0];
                while (stack.length > 1 && stack[stack.length - 1].depth > depth)
                    stack.pop();
                let top = stack[stack.length - 1];
                if (depth < top.depth)
                    break;
                if (depth > top.depth || kind !== top.kind) {
                    const parent = depth > top.depth ? top : stack[stack.length - 2];
                    if (!parent || !parent.item)
                        break; // a different list at the top level
                    if (depth === top.depth)
                        stack.pop();
                    const list = this.newList(m, pending || parseAttrs(''));
                    parent.item.content.push(list);
                    top = { list, depth, kind, item: null };
                    stack.push(top);
                }
                pending = null;
                this.i++;
                const text = [m[2]];
                while (this.i < this.lines.length) {
                    const n = this.lines[this.i];
                    if (n === '' || n === '+' || n === '//-' || LIST_LINE.test(n) || (ctx.stop !== undefined && n === ctx.stop))
                        break;
                    if (ATTR_LINE.test(n) && LIST_LINE.test(this.lines[this.i + 1] || ''))
                        break;
                    text.push(n);
                    this.i++;
                }
                top.item = this.newItem(top.list, text.join('\n'));
                continue;
            }
            if (l === '+' || l === '') {
                let j = this.i;
                while (this.lines[j] === '')
                    j++;
                const ups = j - this.i;
                if (this.lines[j] === '+') {
                    const target = stack[Math.max(0, stack.length - 1 - ups)];
                    this.i = j + 1;
                    if (ups)
                        stack.length = Math.max(1, stack.length - ups);
                    const b = this.block({ ...ctx, inList: true, top: false });
                    if (b && target.item)
                        target.item.content.push(b);
                    continue;
                }
                if (ups && this.lines[j] !== undefined && LIST_LINE.test(this.lines[j])) {
                    this.i = j;
                    continue;
                }
                break;
            }
            if (ATTR_LINE.test(l) && LIST_LINE.test(this.lines[this.i + 1] || '') && stack[stack.length - 1].item) {
                pending = parseAttrs(l.slice(1, -1));
                this.i++;
                continue;
            }
            break;
        }
        finishList(root);
        return root;
    }
    newList(m, attrs) {
        const marker = m[1][0];
        let type = marker === '.' ? 'orderedList' : 'bulletList';
        if (attrs.roles.includes('decisions'))
            type = 'decisionList';
        else if (marker === '*' && /^\[[ x]\] /.test(m[2]))
            type = 'taskList';
        const node = { type, content: [] };
        if (type === 'orderedList')
            node.attrs = { order: attrs.named.start ? Number(attrs.named.start) : 1 };
        return tag(node, { adf: attrs.adf });
    }
    newItem(list, text) {
        if (list.type === 'taskList' || list.type === 'decisionList') {
            const done = /^\[x\] /.test(text);
            const body = list.type === 'taskList' ? text.replace(/^\[[ x]\] /, '') : text;
            const item = list.type === 'taskList' ? { type: 'taskItem', attrs: { state: done ? 'DONE' : 'TODO' } } : { type: 'decisionItem', attrs: { state: 'DECIDED' } };
            item.content = body === '{empty}' ? [] : this.inline(body);
            list.content.push(item);
            return { content: [] }; // continuation blocks cannot attach to task items
        }
        const item = tag({ type: 'listItem', content: [this.paragraphNode(text, parseAttrs(''))] }, { head: text === '{empty}' });
        list.content.push(item);
        return item;
    }
    // ---------- tables ----------
    table(sep, attrs) {
        const open = sep + '===';
        this.i++;
        const start = this.i;
        while (this.i < this.lines.length && this.line !== open)
            this.i++;
        const body = this.lines.slice(start, this.i);
        if (this.line === open)
            this.i++;
        else
            this.error(`unclosed table "${open}"`);
        const widths = String(attrs.named.cols || '1')
            .split(',')
            .map((w) => Number(w) || 1);
        const ncols = widths.length;
        const cellRe = new RegExp('^(?:(\\d+)?(?:\\.(\\d+))?\\+)?([ah]?)' + (sep === '|' ? '\\|' : '!') + '(.*)$');
        const cells = [];
        for (const l of body) {
            const m = cellRe.exec(l);
            if (m)
                cells.push({ colspan: Number(m[1]) || 1, rowspan: Number(m[2]) || 1, style: m[3], lines: [m[4]], col: 0 });
            else if (cells.length)
                cells[cells.length - 1].lines.push(l);
            else if (l !== '')
                this.error(`table text before the first cell: "${l.slice(0, 40)}"`);
        }
        const rows = [];
        const busy = new Array(ncols).fill(0);
        let row = null;
        let col = 0;
        const skip = () => {
            while (col < ncols && busy[col] > 0)
                col++;
        };
        for (const c of cells) {
            if (!row || col >= ncols) {
                if (row)
                    for (let k = 0; k < ncols; k++)
                        busy[k] = Math.max(0, busy[k] - 1);
                row = [];
                rows.push(row);
                col = 0;
                skip();
            }
            c.col = col;
            row.push(c);
            for (let k = col; k < Math.min(ncols, col + c.colspan); k++)
                busy[k] = c.rowspan;
            col += c.colspan;
            skip();
        }
        const header = attrs.options.includes('header');
        const custom = widths.some((w) => w !== 1);
        const unesc = (s) => s.split('\\' + sep).join(sep);
        const table = {
            type: 'table',
            content: rows.map((r, ri) => ({
                type: 'tableRow',
                content: r.map((c) => {
                    const lines = c.lines.slice();
                    while (lines.length > 1 && lines[lines.length - 1] === '')
                        lines.pop();
                    const isHeader = c.style === 'h' || (ri === 0 && header);
                    const node = { type: isHeader ? 'tableHeader' : 'tableCell', attrs: { colspan: c.colspan, rowspan: c.rowspan } };
                    if (c.style === 'a') {
                        if (lines[0] === '')
                            lines.shift();
                        const sub = new Parser(unesc(lines.join('\n')).split('\n'), this.env, this.seps + sep);
                        node.content = sub.blocks({ top: false }).map((b) => b.node);
                    }
                    else {
                        node.content = [this.paragraphNode(unesc(lines.join('\n')), parseAttrs(''))];
                    }
                    // widths only matter for new cells; paired cells keep their live widths
                    const colwidth = custom ? widths.slice(c.col, c.col + c.colspan) : undefined;
                    return tag(node, { cellStyle: c.style, colwidth });
                }),
            })),
        };
        if (attrs.named.confluence === 'nested-table') {
            return tag({ type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.migration', extensionKey: 'nested-table', parameters: { adf: JSON.stringify({ type: 'doc', content: [table], version: 1 }) } } }, { adf: attrs.adf, nestedTable: table });
        }
        return tag(table, { adf: attrs.adf });
    }
    // ---------- inlines ----------
    inline(s) {
        return mergeText(parseInline(s, this, []));
    }
    linkTarget(key) {
        const refs = this.env.opts.refs;
        const known = refs && refs.links.get(key);
        if (known)
            return { href: [...known][0], key };
        if (key.startsWith('link:'))
            return { href: key.slice(5), key };
        if (key.startsWith('<<'))
            return { href: '#' + key.slice(2), key };
        const [file, frag] = key.slice(5).split('#');
        const url = this.env.opts.resolveXref && this.env.opts.resolveXref(file);
        if (!url) {
            this.error(`link to "${file}": not a page in the mirror`);
            return { href: key.slice(5), key };
        }
        return { href: url + (frag ? '#' + frag : ''), key };
    }
}
// List items: "{empty}" as the item text only stands in for "no paragraph" when blocks follow.
function finishList(list) {
    for (const item of list.content || []) {
        if (item.type !== 'listItem')
            continue;
        const content = item.content;
        if (meta(item).head && content.length > 1)
            content.shift();
        for (const k of content)
            if (/List$/.test(k.type))
                finishList(k);
    }
}
function parseInline(s, p, marks) {
    const out = [];
    let buf = '';
    const flush = () => {
        if (buf)
            out.push(text(buf, marks));
        buf = '';
    };
    const add = (nodes) => {
        flush();
        out.push(...nodes);
    };
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === ' ' && s[i + 1] === '+' && (s[i + 2] === '\n' || i + 2 === s.length)) {
            add([{ type: 'hardBreak' }]);
            i += s[i + 2] === '\n' ? 3 : 2;
            continue;
        }
        if (c === '{') {
            if (s.startsWith('{empty}', i)) {
                i += 7;
                continue;
            }
            if (s.startsWith('{plus}', i)) {
                buf += '+';
                i += 6;
                continue;
            }
        }
        if (c === '+' && s[i + 1] === '+') {
            const j = s.indexOf('++', i + 2);
            if (j > i + 2) {
                buf += s.slice(i + 2, j);
                i = j + 2;
                continue;
            }
        }
        if (c === 'p' && s.startsWith('pass:c[', i)) {
            const j = closeBracket(s, i + 6);
            if (j > 0) {
                buf += s.slice(i + 7, j).replace(/\\]/g, ']');
                i = j + 1;
                continue;
            }
        }
        if (c === '`' && s[i + 1] === '`') {
            const r = codeSpan(s, i + 2, '``');
            if (r) {
                add([text(r.text, [...marks, { type: 'code' }])]);
                i = r.end;
                continue;
            }
        }
        if ((c === '*' && s[i + 1] === '*') || (c === '_' && s[i + 1] === '_')) {
            const j = findClose(s, c + c, i + 2);
            if (j > i + 2) {
                add(parseInline(s.slice(i + 2, j), p, [...marks, { type: c === '*' ? 'strong' : 'em' }]));
                i = j + 2;
                continue;
            }
        }
        if (c === '[' && s[i + 1] === '.') {
            const m = /^\[\.([\w.-]+)\]##/.exec(s.slice(i, i + 200));
            if (m) {
                const j = findClose(s, '##', i + m[0].length);
                if (j >= 0) {
                    add(roleNodes(m[1], s.slice(i + m[0].length, j), p, marks));
                    i = j + 2;
                    continue;
                }
            }
        }
        if ((c === '^' || c === '~') && s[i + 1] && !/\s/.test(s[i + 1])) {
            const j = s.indexOf(c, i + 1);
            if (j > i + 1 && !/\s/.test(s.slice(i + 1, j))) {
                add(parseInline(s.slice(i + 1, j), p, [...marks, { type: 'subsup', attrs: { type: c === '^' ? 'sup' : 'sub' } }]));
                i = j + 1;
                continue;
            }
        }
        const boundary = i === 0 || !/\w/.test(s[i - 1]);
        if (boundary && (s.startsWith('link:', i) || s.startsWith('xref:', i))) {
            const lb = s.indexOf('[', i + 5);
            if (lb > i + 5 && !/\s/.test(s.slice(i + 5, lb))) {
                const r = readLinkText(s, lb);
                if (r) {
                    const key = s.slice(i, lb);
                    add(linkNodes(p.linkTarget(key), r.text || key.slice(5), p, marks));
                    i = r.end;
                    continue;
                }
            }
        }
        if (c === '<' && s[i + 1] === '<') {
            const j = s.indexOf('>>', i + 2);
            if (j > i + 2) {
                const inner = s.slice(i + 2, j);
                const comma = inner.indexOf(',');
                const id = comma < 0 ? inner : inner.slice(0, comma);
                const label = comma < 0 ? id : inner.slice(comma + 1).replace(/&gt;&gt;/g, '>>');
                add(linkNodes(p.linkTarget('<<' + id), label, p, marks));
                i = j + 2;
                continue;
            }
        }
        if (boundary && s.startsWith('image:', i) && s[i + 6] !== ':') {
            const lb = s.indexOf('[', i + 6);
            const rb = lb > 0 ? closeBracket(s, lb) : -1;
            if (rb > 0) {
                const target = s.slice(i + 6, lb);
                const live = p.env.opts.refs && p.env.opts.refs.media.get(target);
                if (!live)
                    p.error(`new image "${target}": images cannot be uploaded from the repo yet`);
                add([live ? cloneRef(live) : { type: 'mediaInline', attrs: { alt: target } }]);
                i = rb + 1;
                continue;
            }
        }
        if (c === '\\' && /[*_`#^~+[\]{}<|!]/.test(s[i + 1] || '')) {
            buf += s[i + 1];
            i += 2;
            continue;
        }
        // constrained forms people type by hand: *bold*, _italic_, `code`
        if ((c === '*' || c === '_' || c === '`') && boundary && s[i + 1] && !/\s/.test(s[i + 1]) && s[i + 1] !== c) {
            const j = constrainedClose(s, c, i + 1);
            if (j > 0) {
                if (c === '`')
                    add([text(s.slice(i + 1, j), [...marks, { type: 'code' }])]);
                else
                    add(parseInline(s.slice(i + 1, j), p, [...marks, { type: c === '*' ? 'strong' : 'em' }]));
                i = j + 1;
                continue;
            }
        }
        buf += c;
        i++;
    }
    flush();
    return out;
}
// A copy of a live node found through refs, without its local ID (that belongs to the original spot).
function cloneRef(node) {
    const c = JSON.parse(JSON.stringify(node));
    if (c.attrs)
        delete c.attrs.localId;
    return c;
}
function text(t, marks) {
    const n = { type: 'text', text: t };
    if (marks.length)
        n.marks = marks.map((m) => ({ ...m }));
    return n;
}
function roleNodes(roleStr, inner, p, marks) {
    const roles = roleStr.split('.');
    const one = roles.length === 1 ? roles[0] : null;
    const plainInner = () => plain(parseInline(inner, p, []));
    if (one === 'mention') {
        const t = plainInner();
        const live = p.env.opts.refs && p.env.opts.refs.mentions.get(t);
        if (!live)
            p.error(`mention "${t}" is not on this page yet; add new mentions in Confluence`);
        const attrs = { id: live ? live.id : undefined, text: t };
        if (live && live.accessLevel !== undefined)
            attrs.accessLevel = live.accessLevel;
        return [{ type: 'mention', attrs }];
    }
    if (one && one.startsWith('status-'))
        return [{ type: 'status', attrs: { text: plainInner(), color: one.slice(7) } }];
    if (one === 'date') {
        const d = Date.parse(plainInner());
        return [tag({ type: 'date', attrs: { timestamp: isNaN(d) ? plainInner() : String(d) } }, { day: plainInner() })];
    }
    if (one === 'card') {
        const m = /^(link|xref):(\S*?)\[\]$/.exec(inner);
        if (m)
            return [{ type: 'inlineCard', attrs: { url: p.linkTarget(m[1] + ':' + m[2]).href } }];
    }
    if (one === 'confluence-extension' || one === 'confluence-unsupported') {
        p.error(`inline Confluence ${one === 'confluence-extension' ? 'macro' : 'content'} "${plainInner()}" can only be edited in Confluence`);
        return [tag({ type: 'text', text: '' }, { placeholder: one })];
    }
    const add = [];
    for (const r of roles) {
        if (r === 'line-through')
            add.push({ type: 'strike' });
        else if (r === 'underline')
            add.push({ type: 'underline' });
        else if (r === 'sup' || r === 'sub')
            add.push({ type: 'subsup', attrs: { type: r } });
        else if (r.startsWith('text-color-'))
            add.push({ type: 'textColor', attrs: { color: '#' + r.slice(11) } });
        else if (r.startsWith('bg-color-'))
            add.push({ type: 'backgroundColor', attrs: { color: '#' + r.slice(9) } });
    }
    return parseInline(inner, p, [...marks, ...add]);
}
function linkNodes(target, label, p, marks) {
    const mark = tag({ type: 'link', attrs: { href: target.href } }, { key: target.key });
    return parseInline(label, p, [...marks, mark]).map((n) => {
        if (n.type === 'text' && n.marks)
            n.marks = n.marks.map((m) => (m.type === 'link' ? tag({ ...m, attrs: { ...m.attrs } }, meta(mark)) : m));
        return n;
    });
}
// ``...`` with an optional ++...++ or pass:c[...] inside.
function codeSpan(s, from, close) {
    if (s.startsWith('++', from)) {
        const k = s.indexOf('++', from + 2);
        if (k > 0 && s.startsWith(close, k + 2))
            return { text: s.slice(from + 2, k), end: k + 2 + close.length };
    }
    if (s.startsWith('pass:c[', from)) {
        const k = closeBracket(s, from + 6);
        if (k > 0 && s.startsWith(close, k + 1))
            return { text: s.slice(from + 7, k).replace(/\\]/g, ']'), end: k + 1 + close.length };
    }
    const j = s.indexOf(close, from);
    if (j <= from)
        return null;
    return { text: s.slice(from, j), end: j + close.length };
}
// Index of `delim` after `from`, skipping passthroughs and code spans.
function findClose(s, delim, from) {
    for (let i = from; i < s.length; i++) {
        if (s.startsWith('++', i)) {
            const j = s.indexOf('++', i + 2);
            if (j > i + 2) {
                i = j + 1;
                continue;
            }
        }
        if (s.startsWith('pass:c[', i)) {
            const j = closeBracket(s, i + 6);
            if (j > 0) {
                i = j;
                continue;
            }
        }
        if (s.startsWith('``', i) && delim !== '``') {
            const r = codeSpan(s, i + 2, '``');
            if (r) {
                i = r.end - 1;
                continue;
            }
        }
        if (s.startsWith(delim, i))
            return i;
    }
    return -1;
}
function constrainedClose(s, c, from) {
    for (let j = from + 1; j < s.length; j++) {
        if (s[j] === '\n' && s[j + 1] === '\n')
            return -1;
        if (s[j] === c && !/\s/.test(s[j - 1]) && (j + 1 === s.length || !/\w/.test(s[j + 1])) && s[j + 1] !== c)
            return j;
    }
    return -1;
}
// Index of the "]" closing the "[" at `open`, honouring backslash escapes.
function closeBracket(s, open) {
    for (let i = open + 1; i < s.length; i++) {
        if (s[i] === '\\') {
            i++;
            continue;
        }
        if (s[i] === ']')
            return i;
    }
    return -1;
}
function readLinkText(s, open) {
    if (s[open + 1] === '"') {
        for (let i = open + 2; i < s.length; i++) {
            if (s[i] === '\\') {
                i++;
                continue;
            }
            if (s[i] === '"' && s[i + 1] === ']')
                return { text: s.slice(open + 2, i).replace(/\\"/g, '"').replace(/\\]/g, ']'), end: i + 2 };
        }
    }
    const j = closeBracket(s, open);
    if (j < 0)
        return null;
    return { text: s.slice(open + 1, j).replace(/\\]/g, ']'), end: j + 1 };
}
function mergeText(nodes) {
    const out = [];
    for (const n of nodes) {
        if (n.type === 'text' && n.text === '' && !meta(n).placeholder)
            continue;
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text' && n.type === 'text' && sameMarks(prev.marks, n.marks) && !meta(prev).placeholder && !meta(n).placeholder) {
            prev.text += n.text || '';
            continue;
        }
        out.push(n);
    }
    return out;
}
function sameMarks(a, b) {
    const k = (m) => JSON.stringify(m || []);
    return k(a) === k(b);
}
function plain(nodes) {
    return nodes.map((n) => (n.type === 'text' ? n.text : n.attrs && n.attrs.text ? n.attrs.text : '')).join('');
}
function blockMarks(attrs) {
    const marks = [];
    for (const r of attrs.roles) {
        const a = ALIGN.exec('.' + r);
        if (a)
            marks.push({ type: 'alignment', attrs: { align: a[1] } });
        const ind = /^indent-(\d+)$/.exec(r);
        if (ind)
            marks.push({ type: 'indentation', attrs: { level: Number(ind[1]) } });
    }
    return marks;
}
// "[style#id.role%option,name=value,"quoted"]" -> { positional, named, roles, options, adf }
export function parseAttrs(str) {
    const items = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\\' && q) {
            cur += ch + (str[i + 1] || '');
            i++;
        }
        else if (ch === '"') {
            q = !q;
            cur += ch;
        }
        else if (ch === ',' && !q) {
            items.push(cur);
            cur = '';
        }
        else
            cur += ch;
    }
    if (cur !== '' || items.length)
        items.push(cur);
    const unq = (v) => (/^".*"$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"') : v);
    const out = { positional: [], named: {}, roles: [], options: [], adf: undefined };
    for (const raw of items) {
        const it = raw.trim();
        const m = /^([\w-]+)=(.*)$/.exec(it);
        if (m)
            out.named[m[1]] = unq(m[2]);
        else
            out.positional.push(unq(it));
    }
    const first = out.positional[0] || '';
    if (!/^"/.test((items[0] || '').trim())) {
        for (const seg of first.match(/[.%][\w-]+/g) || [])
            (seg[0] === '.' ? out.roles : out.options).push(seg.slice(1));
    }
    out.adf = out.named.adf;
    return out;
}
