import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, configFromEnv, parseArgs } from '../src/client.js';
import { listMembers, addWatchers, watchPath } from '../src/confluence-group-watch.js';
import { listGroupAccountIds, addParticipants, chunk } from '../src/jsm-group-participants.js';
import { countPerAssignee, fetchInProgress, buildJql } from '../src/jira-wip-per-person.js';
import { parseRates, rateFor, aggregate, toCsv, fetchWorklogs } from '../src/jira-epic-cost.js';
import * as wl from '../src/jira-worklog-export.js';
import { mockFetch } from './mock-fetch.js';

const cfg = { site: 'x.atlassian.net', email: 'a@b.c', token: 't' };
const mk = (h) => { const f = mockFetch(h); return [createClient(cfg, { fetchImpl: f, sleep: async () => {} }), f]; };

test('client retries 429 using Retry-After and sends basic auth', async () => {
  const [c, f] = mk((u, i, n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '1' } } : { body: { ok: 1 } }));
  assert.deepEqual(await c.get('/x'), { ok: 1 });
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].init.headers.Authorization, /^Basic /);
});
test('client gives clear error on 403', async () => {
  const [c] = mk(() => ({ status: 403, body: { message: 'no' } }));
  await assert.rejects(c.get('/x'), /HTTP 403.*permission/);
});
test('config and args', () => {
  assert.throws(() => configFromEnv({}), /ATLASSIAN_SITE/);
  assert.equal(configFromEnv({ ATLASSIAN_SITE: 'https://a.net/', ATLASSIAN_EMAIL: 'e', ATLASSIAN_API_TOKEN: 't' }).site, 'a.net');
  const a = parseArgs(['--dry-run', '--space=ENG', '--limit', '3'], { booleans: ['dry-run'] });
  assert.deepEqual([a['dry-run'], a.space, a.limit], [true, 'ENG', '3']);
});
test('confluence members paging by start/limit', async () => {
  const [c, f] = mk((u) => {
    const s = Number(u.searchParams.get('start'));
    return { body: { results: Array.from({ length: s === 0 ? 2 : 1 }, (_, i) => ({ accountId: `u${s + i}` })) } };
  });
  const m = await listMembers(c, 'g1', 2);
  assert.equal(m.length, 3);
  assert.equal(f.calls.length, 2);
});
test('confluence watch dry-run vs real, header', async () => {
  const [c, f] = mk(() => ({ status: 204 }));
  const members = [{ accountId: 'a' }, { accountId: 'b' }];
  const log = () => {};
  assert.equal((await addWatchers(c, members, { space: 'ENG' }, { dryRun: true, log })).added, 2);
  assert.equal(f.calls.length, 0);
  await addWatchers(c, members, { page: '123' }, { log });
  assert.equal(f.calls[0].url.pathname, '/wiki/rest/api/user/watch/content/123');
  assert.equal(f.calls[0].url.searchParams.get('accountId'), 'a');
  assert.equal(f.calls[0].init.headers['X-Atlassian-Token'], 'no-check');
  assert.equal(watchPath({ space: 'ENG' }), '/wiki/rest/api/user/watch/space/ENG');
});
test('jsm group members paging and batching', async () => {
  const [c] = mk((u) => {
    const s = Number(u.searchParams.get('startAt'));
    return { body: { values: [{ accountId: `u${s}` }, { accountId: `u${s + 1}` }, {}], isLast: s >= 2 } };
  });
  assert.deepEqual(await listGroupAccountIds(c, { groupId: 'g' }), ['u0', 'u1', 'u3', 'u4']);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const [c2, f2] = mk(() => ({ body: {} }));
  const r = await addParticipants(c2, 'SUP-1', ['a', 'b', 'c'], { batchSize: 2, log: () => {} });
  assert.equal(r.ok, 3);
  assert.deepEqual(JSON.parse(f2.calls[1].init.body), { accountIds: ['c'] });
});
test('wip counting, flag and paging', async () => {
  const [c] = mk((u, i) => {
    const body = JSON.parse(i.body);
    return body.nextPageToken
      ? { body: { issues: [{ key: 'A-3', fields: { assignee: { accountId: '1', displayName: 'Ann' } } }] } }
      : { body: { issues: [{ key: 'A-1', fields: { assignee: { accountId: '1', displayName: 'Ann' } } }, { key: 'A-2', fields: { assignee: { accountId: '2', displayName: 'Bob' } } }], nextPageToken: 'n' } };
  });
  const rows = countPerAssignee(await fetchInProgress(c, buildJql('A')), 1);
  assert.deepEqual(rows.map((r) => [r.name, r.count, r.over]), [['Ann', 2, true], ['Bob', 1, false]]);
  assert.match(buildJql('A'), /^project = "A" AND statusCategory/);
});
test('rate lookup by started date, accountId and name', () => {
  const rates = parseRates('person,rate,valid_from\nacc1,100,2025-01-01\nacc1,120,2025-07-01\n"Doe, Jo",50,2025-01-01\n');
  const a = { accountId: 'acc1', displayName: 'Ann' };
  assert.equal(rateFor(rates, a, '2024-12-31'), null);
  assert.equal(rateFor(rates, a, '2025-06-30'), 100);
  assert.equal(rateFor(rates, a, '2025-07-01'), 120);
  assert.equal(rateFor(rates, { accountId: 'z', displayName: 'Doe, Jo' }, '2025-02-01'), 50);
  assert.throws(() => parseRates('person,rate,valid_from\nx,abc,2025-01-01'), /invalid/);
});
test('aggregate and CSV totals', () => {
  const rates = parseRates('person,rate,valid_from\nacc1,100,2025-01-01\nacc1,200,2025-07-01');
  const au = { accountId: 'acc1', displayName: 'Ann' };
  const { rows, unpriced } = aggregate([
    { epic: 'E-1', author: au, started: '2025-06-30T10:00:00.000+0200', seconds: 7200 },
    { epic: 'E-1', author: au, started: '2025-07-02T10:00:00.000+0200', seconds: 3600 },
    { epic: 'E-1', author: { accountId: 'q', displayName: 'Q' }, started: '2025-07-02T10:00:00.000+0200', seconds: 3600 },
  ], rates);
  assert.deepEqual(unpriced, ['Q']);
  assert.equal(rows.find((r) => r.month === '2025-06').cost, 200);
  assert.equal(rows.find((r) => r.month === '2025-07' && r.person === 'Ann').cost, 200);
  const csv = toCsv(rows);
  assert.match(csv, /E-1,TOTAL,,4\.00,400\.00/);
  assert.match(csv, /ALL,TOTAL,,4\.00,400\.00/);
});
test('worklog paging by startAt', async () => {
  const [c, f] = mk((u) => {
    const s = Number(u.searchParams.get('startAt'));
    return { body: { total: 3, worklogs: s === 0 ? [{}, {}] : [{}] } };
  });
  assert.equal((await fetchWorklogs(c, 'A-1')).length, 3);
  assert.equal(f.calls.length, 2);
});

test('worklog export: dates, JQL and bad input', () => {
  assert.equal(wl.dayToMs('2026-10-31', 'to', true), Date.parse('2026-10-31T23:59:59.999Z'));
  assert.throws(() => wl.dayToMs('31/10/2026', 'to'), /--to/);
  assert.equal(wl.buildJql('project = A', '2026-10-01', '2026-10-31'), '(project = A) AND timespent > 0 AND worklogDate >= "2026-09-30" AND worklogDate <= "2026-11-01"');
});
test('worklog export: pages through more than one page and keeps exact days', async () => {
  const [c] = mk((u) => {
    if (u.pathname.endsWith('/search/jql')) return { body: { issues: [{ key: 'A-1', fields: { summary: 'S, with comma' } }] } };
    const at = Number(u.searchParams.get('startAt'));
    if (at === 0) return { body: { total: 3, worklogs: [
      { started: '2026-10-31T23:30:00.000+0000', timeSpentSeconds: 3600, author: { displayName: 'Bo', accountId: 'b' }, comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] } },
      { started: '2026-11-01T00:30:00.000+0000', timeSpentSeconds: 60, author: { displayName: 'Bo', accountId: 'b' } },
    ] } };
    return { body: { total: 3, worklogs: [{ started: '2026-10-01T00:00:00.000+0000', timeSpentSeconds: 5400, author: { displayName: 'Al', accountId: 'a' } }] } };
  });
  const rows = await wl.exportWorklogs(c, { jql: 'project = A', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(rows.map((r) => [r.author, r.hours]), [['Al', 1.5], ['Bo', 1]]);
  assert.equal(rows[1].comment, 'hello');
});
test('worklog export: CSV quotes text and neutralises formulas', () => {
  const csv = wl.toCsv([{ key: 'A-1', summary: 'a "b", c', author: '=cmd()', accountId: 'x', started: 's', hours: 1, seconds: 3600, comment: '' }]);
  assert.match(csv, /"a ""b"", c"/);
  assert.match(csv, /,'=cmd\(\),/);
});
