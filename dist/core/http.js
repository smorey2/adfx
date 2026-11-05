// Atlassian Cloud REST client shared by Confluence and Jira: basic auth with an API token, retries on
// rate limits and server errors, and credentials that only ever go to the site's own origin.
export class AtlassianClient {
    site;
    origin;
    auth;
    fetch;
    constructor({ site, email, token, fetchImpl = globalThis.fetch }) {
        this.site = site;
        this.origin = 'https://' + site;
        this.auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
        this.fetch = fetchImpl;
    }
    async get(path, { binary = false } = {}) {
        let url = path.startsWith('https://') ? path : this.origin + path;
        for (let attempt = 0;; attempt++) {
            const sameOrigin = new URL(url).origin === this.origin;
            const res = await this.fetch(url, {
                method: 'GET',
                redirect: 'manual',
                headers: { Accept: binary ? '*/*' : 'application/json', ...(sameOrigin ? { Authorization: this.auth } : {}) },
            });
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                url = new URL(location, url).toString(); // credentials only go to the site's origin
                continue;
            }
            if ((res.status === 429 || res.status >= 500) && attempt < 4) {
                await sleep(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt);
                continue;
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`GET ${path} -> ${res.status} ${text.slice(0, 300)}`);
            }
            return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
        }
    }
    async send(method, path, body, hint409 = '') {
        const res = await this.fetch(this.origin + path, {
            method,
            headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const hint = res.status === 409 && hint409 ? ` (${hint409})` : '';
            throw new Error(`${method} ${path} -> ${res.status}${hint} ${text.slice(0, 300)}`);
        }
        return res.json();
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
