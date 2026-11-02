// "confluence new": write a draft .adoc for a page that does not exist yet, from a project template.
// The draft has :confluence-parent: and no :confluence-id:; its first push creates the page (ADR-0007).

import fs from 'node:fs';
import path from 'node:path';
import * as header from '../core/header.ts';
import { writeFile } from '../core/files.ts';
import { discover, type Log } from './pull.ts';
import { layoutTree, slug } from './layout.ts';
import type { ConfluenceReader } from './api.ts';
import type { ConfluenceConfig } from './config.ts';

export interface NewPageOptions {
  api: ConfluenceReader;
  config: ConfluenceConfig;
  outDir: string;
  title: string;
  parentId: string;
  template?: string;
  log?: Log;
}

export async function newPage({ api, config, outDir, title, parentId, template, log = console.log }: NewPageOptions): Promise<string> {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('the new page needs a title');
  const { nodes, roots } = await discover(api, config);
  const parent = nodes.get(parentId);
  if (!parent || parent.excluded) throw new Error(`parent ${parentId} is not in scope (confluence.yaml roots)`);
  const sibling = parent.children.map((c) => nodes.get(c)!).find((c) => c.title.replace(/\s+/g, ' ').trim().toLowerCase() === clean.toLowerCase());
  if (sibling) throw new Error(`"${sibling.title}" already exists under that parent (page ${sibling.id})`);

  const dir = layoutTree(nodes, roots).get(parentId)!.dir;
  const rel = `${dir}/${slug(clean)}.adoc`;
  const file = path.join(outDir, rel);
  if (fs.existsSync(file)) throw new Error(`${rel} already exists`);

  let body = '{empty}\n';
  let offset: string | undefined;
  if (template) {
    const tpl = config.templates[template];
    if (!tpl) {
      const names = Object.keys(config.templates);
      throw new Error(`no template "${template}" in confluence.yaml${names.length ? ` (templates: ${names.join(', ')})` : ' (it has no templates section)'}`);
    }
    if (!fs.existsSync(tpl)) throw new Error(`template "${template}" points to ${tpl}, which does not exist`);
    const text = fs.readFileSync(tpl, 'utf8').replace(/\r\n/g, '\n');
    const h = header.parse(text);
    // a template may have its own "= Title" header; only its heading offset carries over
    body = h ? h.body : text;
    offset = h ? h.attrs['confluence-heading-offset'] : undefined;
    if (!body.endsWith('\n')) body += '\n';
  }

  const spaceKey = roots.find((r) => r.id === parent.rootId)!.spaceKey;
  const text = header.render(
    clean,
    [
      ['confluence-parent', parentId],
      ['confluence-space', spaceKey],
      ['scope-root', parent.rootId],
      ['confluence-heading-offset', offset && offset !== '0' ? offset : null],
      ['toc', /^toc::\[/m.test(body) ? 'macro' : null],
    ],
    body,
  );
  writeFile(file, text);
  log(`wrote ${rel} (new page "${clean}" under "${parent.title}")`);
  log('Edit it, then preview the page creation with:');
  log(`  adfx confluence push ${path.relative(process.cwd(), file).split(path.sep).join('/')}`);
  return file;
}
