#!/usr/bin/env node
// Export individual worklogs (who, when, how long, comment) to CSV for a JQL query.
import { writeFileSync } from 'node:fs';
import { configFromEnv, createClient, parseArgs, isMain, run } from './client.js';

const USAGE = `Usage:
  jira-worklog-export --jql "project = APP" [--from 2026-10-01] [--to 2026-10-31] [--out worklogs.csv]

Without --out the CSV goes to stdout. --from and --to are inclusive days in UTC, matched on when the
work was started, not when it was logged.

Environment: ATLASSIAN_SITE, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function dayToMs(day, name, endOfDay = false) {
  if (!DAY.test(day)) throw new Error(`--${name} must look like 2026-10-31.`);
  const ms = Date.parse(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(ms)) throw new Error(`--${name} isn't a real date: ${day}.`);
  return ms;
}

export function buildJql(jql, from, to) {
  // Jira's worklogDate follows the user's time zone, so widen by a day and filter exactly on the rows.
  const shift = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
  const parts = [`(${jql})`, 'timespent > 0'];
  if (from) parts.push(`worklogDate >= "${shift(from, -1)}"`);
  if (to) parts.push(`worklogDate <= "${shift(to, 1)}"`);
  return parts.join(' AND ');
}

export async function fetchIssues(client, jql) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await client.post('/rest/api/3/search/jql', { body: { jql, fields: ['summary'], maxResults: 100, nextPageToken } });
    issues.push(...(page.issues || []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return issues;
}

export async function fetchWorklogs(client, key, { startedAfter, startedBefore } = {}) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const page = await client.get(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, { query: { startAt, maxResults: 1000, startedAfter, startedBefore } });
    const w = page.worklogs || [];
    out.push(...w);
    startAt += w.length;
    if (!w.length || startAt >= (page.total ?? 0)) return out;
  }
}

// Worklog comments are Atlassian Document Format; keep the text, one line.
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return node.attrs?.text || '';
  return (node.content || []).map(adfToText).join(node.type === 'doc' ? ' ' : '').replace(/\s+/g, ' ').trim();
}

export function toRow(issue, w) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    author: w.author?.displayName || '',
    accountId: w.author?.accountId || '',
    started: w.started || '',
    hours: Math.round(((w.timeSpentSeconds || 0) / 3600) * 100) / 100,
    seconds: w.timeSpentSeconds || 0,
    comment: adfToText(w.comment),
  };
}

const COLUMNS = ['key', 'summary', 'author', 'accountId', 'started', 'hours', 'seconds', 'comment'];

function cell(v) {
  let s = String(v);
  // Stop a spreadsheet running text from Jira as a formula.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export async function exportWorklogs(client, { jql, from, to }) {
  const startedAfter = from ? dayToMs(from, 'from') : undefined;
  const lastMs = to ? dayToMs(to, 'to', true) : undefined;
  const issues = await fetchIssues(client, buildJql(jql, from, to));
  const rows = [];
  for (const issue of issues) {
    for (const w of await fetchWorklogs(client, issue.key, { startedAfter, startedBefore: lastMs })) {
      const at = Date.parse(w.started);
      if (startedAfter !== undefined && at < startedAfter) continue;
      if (lastMs !== undefined && at > lastMs) continue;
      rows.push(toRow(issue, w));
    }
  }
  rows.sort((a, b) => Date.parse(a.started) - Date.parse(b.started) || a.key.localeCompare(b.key));
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jql) { console.error(USAGE); process.exit(2); }
  if (args.from) dayToMs(args.from, 'from');
  if (args.to) dayToMs(args.to, 'to');
  const client = createClient(configFromEnv());
  const rows = await exportWorklogs(client, args);
  const csv = toCsv(rows);
  if (args.out) {
    writeFileSync(args.out, csv);
    const hours = rows.reduce((s, r) => s + r.seconds, 0) / 3600;
    console.error(`${rows.length} worklogs, ${hours.toFixed(2)} hours, written to ${args.out}`);
  } else {
    process.stdout.write(csv);
  }
}

if (isMain(import.meta.url)) run(main);
