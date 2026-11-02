// Atlassian Document Format (ADF): the JSON tree Confluence and Jira store rich text in.
// Only the shape is typed; node and mark types are open strings, as ADF adds new ones over time.

export type Attrs = Record<string, any>;

export interface AdfMark {
  type: string;
  attrs?: Attrs;
}

export interface AdfNode {
  type: string;
  attrs?: Attrs;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
  version?: number;
}

export interface AdfDoc extends AdfNode {
  type: 'doc';
  content: AdfNode[];
}

export function walk(n: AdfNode | null | undefined, fn: (n: AdfNode) => void): void {
  if (!n || typeof n !== 'object') return;
  fn(n);
  for (const c of n.content || []) walk(c, fn);
}

export function parseAdf(value: string | null | undefined): AdfDoc {
  return JSON.parse(value || '{"type":"doc","content":[]}');
}
