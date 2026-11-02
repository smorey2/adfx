// A small, strict YAML subset for adf-bridge config files: block mappings and sequences, plain and
// quoted scalars, flow lists like [a, "b"], [] and {}, and # comments. Every scalar is read as a
// string (no implicit numbers, booleans or dates), so page IDs and keys are never mangled. Anything
// outside the subset (anchors, tags, block scalars, multiple documents, tabs) is an error with a line
// number, so a typo fails loudly instead of silently changing what gets synced.

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  no: number; // 1-based line number
  indent: number;
  text: string; // without indentation and comment
}

export class YamlError extends Error {}

export function parseYaml(source: string, file = 'config'): YamlValue {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    if (/^\s*\t/.test(raw)) throw new YamlError(`${file} line ${no}: tabs are not allowed for indentation`);
    const text = stripComment(raw, file, no).trimEnd();
    if (!text.trim()) return;
    if (/^(---|\.\.\.)\s*$/.test(text)) throw new YamlError(`${file} line ${no}: only one document per file`);
    const indent = text.length - text.trimStart().length;
    lines.push({ no, indent, text: text.trimStart() });
  });
  if (!lines.length) return null;
  const p = { lines, i: 0, file };
  const value = parseBlock(p, lines[0].indent);
  if (p.i < lines.length) fail(p, lines[p.i], 'unexpected indentation');
  return value;
}

interface P {
  lines: Line[];
  i: number;
  file: string;
}

function fail(p: { file: string }, line: Line | { no: number }, msg: string): never {
  throw new YamlError(`${p.file} line ${line.no}: ${msg}`);
}

function parseBlock(p: P, indent: number): YamlValue {
  const first = p.lines[p.i];
  return isItem(first.text) ? parseSeq(p, indent) : parseMap(p, indent);
}

function isItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseSeq(p: P, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (p.i < p.lines.length) {
    const line = p.lines[p.i];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(p, line, 'unexpected indentation');
    if (!isItem(line.text)) break;
    const rest = line.text.slice(1).trimStart();
    p.i++;
    if (!rest) {
      out.push(nested(p, indent));
      continue;
    }
    if (keyOf(rest)) {
      // "- key: value" starts a mapping whose other keys line up with "key"
      const childIndent = indent + (line.text.length - rest.length);
      p.i--;
      p.lines[p.i] = { no: line.no, indent: childIndent, text: rest };
      out.push(parseMap(p, childIndent));
      continue;
    }
    out.push(scalar(p, line, rest));
  }
  return out;
}

function parseMap(p: P, indent: number): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {};
  while (p.i < p.lines.length) {
    const line = p.lines[p.i];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(p, line, 'unexpected indentation');
    if (isItem(line.text)) fail(p, line, 'a list item cannot appear here');
    const k = keyOf(line.text);
    if (!k) fail(p, line, `expected "key: value", found "${line.text}"`);
    if (Object.prototype.hasOwnProperty.call(out, k.key)) fail(p, line, `duplicate key "${k.key}"`);
    p.i++;
    out[k.key] = k.rest ? scalar(p, line, k.rest) : nested(p, indent);
  }
  return out;
}

// The block under "key:" or "-": more indented lines, or a list at the same indent under a key.
function nested(p: P, indent: number): YamlValue {
  const next = p.lines[p.i];
  if (!next) return null;
  if (next.indent > indent) return parseBlock(p, next.indent);
  if (next.indent === indent && isItem(next.text)) {
    // "key:" followed by "- item" at the same indent (common YAML style)
    const prev = p.lines[p.i - 1];
    if (prev && !isItem(prev.text)) return parseSeq(p, indent);
  }
  return null;
}

function keyOf(text: string): { key: string; rest: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/.exec(text);
  if (quoted) return { key: unquote(quoted[1]), rest: (quoted[2] || '').trim() };
  const m = /^([^\s"'#[\]{},:][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return { key: m[1], rest: (m[2] || '').trim() };
}

function scalar(p: P, line: Line, text: string): YamlValue {
  if (/^[&*!]/.test(text)) fail(p, line, 'anchors, aliases and tags are not supported');
  if (/^[|>]/.test(text)) fail(p, line, 'block scalars (| and >) are not supported; use a quoted string');
  if (text.startsWith('[')) return flowList(p, line, text);
  if (text === '{}') return {};
  if (text.startsWith('{')) fail(p, line, 'flow mappings are not supported; use one "key: value" per line');
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quoteEnd(text, 0);
    if (end !== text.length - 1) fail(p, line, `cannot parse ${text}`);
    return unquote(text);
  }
  if (text === '~' || text === 'null') return null;
  if (/:\s|\s#/.test(text)) fail(p, line, `quote this value: ${text}`);
  return text;
}

function flowList(p: P, line: Line, text: string): YamlValue[] {
  if (!text.endsWith(']')) fail(p, line, 'unclosed [ list; flow lists must fit on one line');
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const out: YamlValue[] = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === ' ') i++;
    let item: string;
    if (inner[i] === '"' || inner[i] === "'") {
      const end = quoteEnd(inner, i);
      if (end < 0) fail(p, line, 'unclosed quote');
      item = unquote(inner.slice(i, end + 1));
      i = end + 1;
    } else {
      const comma = inner.indexOf(',', i);
      const raw = (comma < 0 ? inner.slice(i) : inner.slice(i, comma)).trim();
      if (/[[\]{}]/.test(raw)) fail(p, line, 'nested flow collections are not supported');
      item = raw;
      i = comma < 0 ? inner.length : comma;
    }
    out.push(item);
    while (inner[i] === ' ') i++;
    if (i < inner.length) {
      if (inner[i] !== ',') fail(p, line, `expected "," in list`);
      i++;
    }
  }
  return out;
}

// Index of the closing quote for the quote at `start`, or -1.
function quoteEnd(s: string, start: number): number {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? c);
}

function stripComment(raw: string, file: string, no: number): string {
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (q === "'" && c === "'" && raw[i + 1] === "'") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[,:-]/.test(raw[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  if (q) throw new YamlError(`${file} line ${no}: unclosed quote`);
  return raw;
}
