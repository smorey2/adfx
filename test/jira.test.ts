import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pullJira } from '../src/jira/pull.ts';
import { JiraFixtureApi, type Issue, type JiraFixture } from '../src/jira/api.ts';
import { parseJiraConfig } from '../src/jira/config.ts';
import type { AdfNode } from '../src/core/adf.ts';
import { quiet, tmp } from './helpers.ts';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content });
const p = (...c: AdfNode[]): AdfNode => ({ type: 'paragraph', content: c });
const t = (text: string, href?: string): AdfNode => ({ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) });
const status = (id: string, name: string) => ({ id, name });

function issue(key: string, summary: string, statusId: string, statusName: string, extra: Partial<Issue['fields']> = {}): Issue {
  return {
    id: '1' + key.split('-')[1],
    key,
    fields: {
      summary,
      status: status(statusId, statusName),
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      assignee: { displayName: 'Pat Example' },
      reporter: { displayName: 'Sky' },
      labels: [],
      created: '2026-10-01T10:00:00.000+0000',
      updated: '2026-10-20T10:00:00.000+0000',
      ...extra,
    },
  };
}

function fixture(): JiraFixture {
  return {
    boards: {
      42: {
        name: 'OMS board',
        type: 'scrum',
        projectKey: 'OMS',
        columns: [
          { name: 'To Do', statuses: ['1'] },
          { name: 'In Progress', statuses: ['3'] },
          { name: 'Done', statuses: ['10001'] },
        ],
        sprints: [{ id: 7, name: 'Sprint 7', state: 'active', startDate: '2026-10-20T00:00:00Z', endDate: '2026-11-03T00:00:00Z', goal: 'Return fees', issues: ['OMS-1', 'OMS-2'] }],
      },
      50: { name: 'Support', type: 'kanban', projectKey: 'SUP', issues: ['SUP-1', 'SUP-2'] },
    },
    issues: {
      'OMS-1': issue('OMS-1', 'Charge return fees', '3', 'In Progress', {
        labels: ['fees'],
        description: doc({ type: 'heading', attrs: { level: 1, localId: 'h-1' }, content: [t('Steps')] }, p(t('Depends on '), t('OMS-2', 'https://x.atlassian.net/browse/OMS-2'), t('.'))),
        subtasks: [{ key: 'OMS-3', fields: { summary: 'Epicor line', status: { name: 'To Do' } } }],
        issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'OMS-2', fields: { summary: 'Fee table', status: { name: 'To Do' } } } }],
        comment: { comments: [{ id: 'c1', author: { displayName: 'Pat Example' }, created: '2026-10-21T09:00:00.000+0000', body: doc(p(t('Looks good.'))) }], total: 1 },
      }),
      'OMS-2': issue('OMS-2', 'Fee table', '1', 'To Do'),
      'OMS-3': issue('OMS-3', 'Epicor line', '1', 'To Do'),
      'SUP-1': issue('SUP-1', 'Open ticket', '1', 'To Do'),
      'SUP-2': issue('SUP-2', 'Closed ticket', '10001', 'Done'),
      'CORE-9': issue('CORE-9', 'Core work', '1', 'To Do'),
    },
  };
}

const configText = 'site: x.atlassian.net\nboards:\n  - id: "42"\n';

function setup(text = configText) {
  const root = tmp('adf-bridge-jira-');
  const config = parseJiraConfig(text, { root });
  const data = fixture();
  const run = (opts: { dryRun?: boolean } = {}) => pullJira({ api: new JiraFixtureApi(data), config, log: quiet, ...opts });
  const read = (rel: string) => fs.readFileSync(path.join(config.out, rel), 'utf8');
  return { root, config, data, run, read };
}

test('a board pull writes one file per active-sprint issue and a board page by column', async () => {
  const s = setup();
  const r = await s.run();
  assert.deepStrictEqual(r.written.sort(), ['OMS/OMS-1.adoc', 'OMS/OMS-2.adoc', 'OMS/board.adoc']);

  const one = s.read('OMS/OMS-1.adoc');
  assert.match(one, /^= OMS-1: Charge return fees\n:jira-key: OMS-1\n:jira-source: https:\/\/x\.atlassian\.net\/browse\/OMS-1\n/);
  assert.match(one, /^:generated: adf-bridge jira pull; do not edit/m);
  assert.match(one, /^h\|Sprint\n\|Sprint 7$/m);
  assert.match(one, /^== Description$/m);
  assert.match(one, /^=== Steps$/m, 'description headings sit under Description');
  assert.doesNotMatch(one, /adf=/, 'no local IDs in read-only files');
  assert.match(one, /xref:OMS-2\.adoc\[OMS-2\]/, 'links to mirrored issues become xrefs');
  assert.match(one, /^\* blocks xref:OMS-2\.adoc\[OMS-2\] Fee table \(To Do\)$/m);
  assert.match(one, /^\* link:https:\/\/x\.atlassian\.net\/browse\/OMS-3\[OMS-3\] Epicor line \(To Do\)$/m, 'issues outside scope stay links');
  assert.match(one, /^=== Pat Example, 2026-10-21\n\nLooks good\.$/m);

  const board = s.read('OMS/board.adoc');
  assert.match(board, /^= OMS board\n:jira-board: 42\n/);
  assert.match(board, /^== Sprint 7\n\n2026-10-20 to 2026-11-03\. Goal: Return fees$/m);
  assert.match(board, /=== To Do\n\n\[%header,cols="110,400,100,160"\]\n\|===\n\|Key\n\|Summary\n\|Type\n\|Assignee\n\nxref:OMS-2\.adoc\[OMS-2\]|=== To Do[\s\S]*\|xref:OMS-2\.adoc\[OMS-2\]/);
  assert.match(board, /=== In Progress[\s\S]*\|xref:OMS-1\.adoc\[OMS-1\][\s\S]*=== Done\n\nNone\./);
});

test('a second pull changes nothing; dry runs write nothing', async () => {
  const s = setup();
  await s.run();
  const r = await s.run();
  assert.deepStrictEqual([r.written, r.deleted, r.unchanged.length], [[], [], 3]);
  const d = setup();
  const dr = await d.run({ dryRun: true });
  assert.strictEqual(dr.written.length, 3);
  assert.ok(!fs.existsSync(d.config.out));
});

test('when the sprint closes, issues that left are deleted; files the tool did not write are kept', async () => {
  const s = setup();
  await s.run();
  fs.writeFileSync(path.join(s.config.out, 'OMS', 'notes.adoc'), '= My notes\n\nkeep me\n');
  const b = s.data.boards[42];
  b.sprints![0].state = 'closed';
  b.sprints!.push({ id: 8, name: 'Sprint 8', state: 'active', issues: ['OMS-3'] });
  const r = await s.run();
  assert.deepStrictEqual(r.deleted.sort(), ['OMS/OMS-1.adoc', 'OMS/OMS-2.adoc']);
  assert.ok(r.written.includes('OMS/OMS-3.adoc'));
  assert.ok(fs.existsSync(path.join(s.config.out, 'OMS', 'notes.adoc')));
  assert.match(s.read('OMS/board.adoc'), /== Sprint 8/);
});

test('kanban boards show what is not done; projects are limited to their own key', async () => {
  const s = setup('site: x.atlassian.net\nboards:\n  - "50"\nprojects:\n  - key: CORE\n    jql: statusCategory != Done\n');
  const api = new JiraFixtureApi(s.data);
  const r = await pullJira({ api, config: s.config, log: quiet });
  assert.deepStrictEqual(r.written.sort(), ['CORE/CORE-9.adoc', 'SUP/SUP-1.adoc', 'SUP/board.adoc']);
  assert.ok(api.queries.includes('project = "CORE" AND (statusCategory != Done) ORDER BY key ASC'));
  assert.doesNotMatch(s.read('SUP/board.adoc'), /SUP-2/);
});

test('include controls the sections', async () => {
  const s = setup(configText + 'include: [description]\n');
  await s.run();
  const one = s.read('OMS/OMS-1.adoc');
  assert.match(one, /== Description/);
  assert.doesNotMatch(one, /== (Comments|Subtasks|Links)/);
});

test('jira.yaml: typos and bad values fail loudly', () => {
  assert.throws(() => parseJiraConfig('site: x.atlassian.net\nboard:\n  - id: "1"\n'), /unknown key "board"/);
  assert.throws(() => parseJiraConfig('site: x.atlassian.net\nboards:\n  - id: abc\n'), /invalid board id/);
  assert.throws(() => parseJiraConfig('site: x.atlassian.net\nprojects:\n  - key: oms\n'), /invalid project key/);
  assert.throws(() => parseJiraConfig('site: x.atlassian.net\n'), /nothing to pull/);
  assert.throws(() => parseJiraConfig(configText + 'include: [history]\n'), /unknown "history"/);
  assert.throws(() => parseJiraConfig('site: x.atlassian.net\nboards:\n  - id: "1"\n    sprints: all\n'), /must be "active"/);
});
