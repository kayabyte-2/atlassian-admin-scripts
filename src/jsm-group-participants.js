#!/usr/bin/env node
// Add a group's members as request participants on one request or all requests matching a JQL.
import { configFromEnv, createClient, parseArgs, isMain, run } from './client.js';

const USAGE = `Usage:
  jsm-group-participants (--group-id ID | --group NAME) (--request KEY | --jql "JQL") [--batch-size 50] [--dry-run]

Example JQL: project = SUP AND statusCategory != Done

Environment: ATLASSIAN_SITE, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN`;

export async function listGroupAccountIds(client, { groupId, groupName }) {
  const ids = [];
  for (let startAt = 0; ; ) {
    const page = await client.get('/rest/api/3/group/member', {
      query: { groupId, groupname: groupId ? undefined : groupName, startAt, maxResults: 50 },
    });
    const values = page.values || [];
    ids.push(...values.map((u) => u.accountId).filter(Boolean));
    if (page.isLast || values.length === 0) return ids;
    startAt += values.length;
  }
}

export async function searchKeys(client, jql) {
  const keys = [];
  let nextPageToken;
  do {
    const page = await client.post('/rest/api/3/search/jql', { body: { jql, fields: ['summary'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } });
    keys.push(...(page.issues || []).map((i) => i.key));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return keys;
}

export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function addParticipants(client, key, accountIds, { batchSize = 50, dryRun = false, log = console.log } = {}) {
  let ok = 0;
  let failed = 0;
  for (const part of chunk(accountIds, batchSize)) {
    if (dryRun) { log(`[dry-run] ${key}: would add ${part.length} participant(s)`); ok += part.length; continue; }
    try {
      await client.post(`/rest/servicedeskapi/request/${encodeURIComponent(key)}/participant`, { body: { accountIds: part } });
      ok += part.length;
      log(`${key}: added batch of ${part.length}`);
    } catch (e) {
      failed += part.length;
      console.error(`${key}: batch of ${part.length} failed: ${e.message}`);
    }
  }
  return { ok, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'help'] });
  if (args.help) return console.log(USAGE);
  if ((!args['group-id'] && !args.group) || (!args.request && !args.jql)) {
    console.error(USAGE);
    process.exit(2);
  }
  const batchSize = Number(args['batch-size'] || 50);
  if (!(batchSize > 0)) throw new Error('--batch-size must be a positive number.');
  const client = createClient(configFromEnv());
  const accountIds = await listGroupAccountIds(client, { groupId: args['group-id'], groupName: args.group });
  console.log(`Group has ${accountIds.length} active member(s).`);
  const keys = args.request ? [args.request] : await searchKeys(client, args.jql);
  console.log(`${keys.length} request(s) to update.`);
  let failed = 0;
  for (const key of keys) {
    failed += (await addParticipants(client, key, accountIds, { batchSize, dryRun: args['dry-run'] })).failed;
  }
  if (failed) { console.error(`${failed} participant add(s) failed.`); process.exitCode = 1; }
}

if (isMain(import.meta.url)) run(main);
