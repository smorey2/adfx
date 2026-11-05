// Atlassian Document Format (ADF): the JSON tree Confluence and Jira store rich text in.
// Only the shape is typed; node and mark types are open strings, as ADF adds new ones over time.
export function walk(n, fn) {
    if (!n || typeof n !== 'object')
        return;
    fn(n);
    for (const c of n.content || [])
        walk(c, fn);
}
export function parseAdf(value) {
    return JSON.parse(value || '{"type":"doc","content":[]}');
}
