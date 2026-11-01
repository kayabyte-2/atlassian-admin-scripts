#!/usr/bin/env node
// Add all members of a group as watchers of a Confluence space or page.
import { configFromEnv, createClient, parseArgs, isMain, run } from './client.js';

const USAGE = `Usage:
  confluence-group-watch (--group-id ID | --group NAME) (--space KEY | --page ID) [--dry-run]

Environment: ATLASSIAN_SITE, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN`;

export async function resolveGroupId(client, name) {
  for (let start = 0; ; start += 200) {
    const page = await client.get('/wiki/rest/api/group', { query: { start, limit: 200 } });
    const hit = (page.results || []).find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    if (!page.results || page.results.length < 200) throw new Error(`Group "${name}" not found.`);
  }
}

// Pages through members using start/limit until a short page is returned.
export async function listMembers(client, groupId, limit = 200) {
  const members = [];
  for (let start = 0; ; start += limit) {
    const page = await client.get(`/wiki/rest/api/group/${encodeURIComponent(groupId)}/membersByGroupId`, { query: { start, limit } });
    const results = page.results || [];
    members.push(...results);
    if (results.length < limit) return members;
  }
}

export function watchPath(target) {
  return target.space
    ? `/wiki/rest/api/user/watch/space/${encodeURIComponent(target.space)}`
    : `/wiki/rest/api/user/watch/content/${encodeURIComponent(target.page)}`;
}

export async function addWatchers(client, members, target, { dryRun = false, log = console.log } = {}) {
  const stats = { added: 0, failed: 0 };
  for (const m of members) {
    const who = m.displayName || m.accountId;
    if (dryRun) { log(`[dry-run] would add ${who}`); stats.added++; continue; }
    try {
      await client.post(watchPath(target), { query: { accountId: m.accountId }, headers: { 'X-Atlassian-Token': 'no-check' } });
      stats.added++;
      log(`added ${who}`);
    } catch (e) {
      stats.failed++;
      console.error(`failed ${who}: ${e.message}`);
    }
  }
  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'help'] });
  if (args.help) return console.log(USAGE);
  if ((!args['group-id'] && !args.group) || (!args.space && !args.page)) {
    console.error(USAGE);
    process.exit(2);
  }
  const client = createClient(configFromEnv());
  const groupId = args['group-id'] || await resolveGroupId(client, args.group);
  const members = (await listMembers(client, groupId)).filter((m) => m.accountId);
  console.log(`Group has ${members.length} member(s).`);
  const s = await addWatchers(client, members, { space: args.space, page: args.page }, { dryRun: args['dry-run'] });
  console.log(`${args['dry-run'] ? 'Would add' : 'Added'}: ${s.added}, failed: ${s.failed}`);
  if (s.failed) process.exitCode = 1;
}

if (isMain(import.meta.url)) run(main);
