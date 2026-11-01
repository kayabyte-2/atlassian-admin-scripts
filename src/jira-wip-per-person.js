#!/usr/bin/env node
// Count in-progress issues per assignee and flag people above a limit.
import { configFromEnv, createClient, parseArgs, isMain, run } from './client.js';

const USAGE = `Usage:
  jira-wip-per-person [--limit 3] [--project KEY]

Environment: ATLASSIAN_SITE, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN`;

export function buildJql(project) {
  const base = 'statusCategory = "In Progress" AND assignee is not EMPTY';
  return project ? `project = "${project.replace(/"/g, '\\"')}" AND ${base}` : base;
}

export async function fetchInProgress(client, jql) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await client.post('/rest/api/3/search/jql', { body: { jql, fields: ['assignee'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } });
    issues.push(...(page.issues || []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return issues;
}

export function countPerAssignee(issues, limit) {
  const map = new Map();
  for (const i of issues) {
    const a = i.fields?.assignee;
    if (!a) continue;
    const key = a.accountId;
    const row = map.get(key) || { accountId: key, name: a.displayName || key, count: 0, keys: [] };
    row.count++;
    row.keys.push(i.key);
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, over: r.count > limit }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['help'] });
  if (args.help) return console.log(USAGE);
  const limit = Number(args.limit ?? 3);
  if (!(limit >= 0)) throw new Error('--limit must be a number.');
  const client = createClient(configFromEnv());
  const rows = countPerAssignee(await fetchInProgress(client, buildJql(args.project)), limit);
  if (!rows.length) return console.log('No in-progress issues with an assignee.');
  for (const r of rows) console.log(`${r.over ? 'OVER ' : '     '}${String(r.count).padStart(3)}  ${r.name}  (${r.keys.join(', ')})`);
  const over = rows.filter((r) => r.over).length;
  console.log(`\n${over} of ${rows.length} assignee(s) above the limit of ${limit}.`);
  if (over) process.exitCode = 1;
}

if (isMain(import.meta.url)) run(main);
