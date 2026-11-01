#!/usr/bin/env node
// Cost of epics from worklogs and a rates.csv, as CSV per epic / person / month.
import { readFileSync } from 'node:fs';
import { configFromEnv, createClient, parseArgs, isMain, run } from './client.js';

const USAGE = `Usage:
  jira-epic-cost --epics KEY1,KEY2 --rates rates.csv [--out costs.csv]

rates.csv columns: person,rate,valid_from
  person      Atlassian accountId or display name
  rate        hourly rate (number)
  valid_from  YYYY-MM-DD; a rate applies from this date until the next valid_from for the same person

Environment: ATLASSIAN_SITE, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN`;

export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

export function parseRates(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('rates.csv is empty.');
  const idx = (n) => header.map((h) => h.toLowerCase()).indexOf(n);
  const [p, r, v] = [idx('person'), idx('rate'), idx('valid_from')];
  if (p < 0 || r < 0 || v < 0) throw new Error('rates.csv needs the header: person,rate,valid_from');
  const rates = new Map();
  rows.forEach((row, n) => {
    const rate = Number(row[r]);
    if (!Number.isFinite(rate) || !/^\d{4}-\d{2}-\d{2}$/.test(row[v])) throw new Error(`rates.csv line ${n + 2}: invalid rate or valid_from.`);
    const list = rates.get(row[p]) || [];
    list.push({ rate, validFrom: row[v] });
    rates.set(row[p], list);
  });
  for (const list of rates.values()) list.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return rates;
}

// Rate valid on a date (YYYY-MM-DD): the latest entry with valid_from <= date. Looks up accountId first, then displayName.
export function rateFor(rates, author, date) {
  const list = rates.get(author.accountId) || rates.get(author.displayName);
  if (!list) return null;
  let found = null;
  for (const e of list) if (e.validFrom <= date) found = e.rate;
  return found;
}

export function aggregate(entries, rates) {
  // entries: [{epic, author:{accountId,displayName}, started, seconds}]
  const map = new Map();
  const unpriced = new Set();
  for (const e of entries) {
    const date = e.started.slice(0, 10);
    const rate = rateFor(rates, e.author, date);
    const name = e.author.displayName || e.author.accountId;
    if (rate === null) unpriced.add(name);
    const hours = e.seconds / 3600;
    const k = `${e.epic}\u0000${name}\u0000${date.slice(0, 7)}`;
    const row = map.get(k) || { epic: e.epic, person: name, month: date.slice(0, 7), hours: 0, cost: 0 };
    row.hours += hours;
    row.cost += rate === null ? 0 : hours * rate;
    map.set(k, row);
  }
  return { rows: [...map.values()].sort((a, b) => a.epic.localeCompare(b.epic) || a.month.localeCompare(b.month) || a.person.localeCompare(b.person)), unpriced: [...unpriced] };
}

const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows) {
  const out = ['epic,person,month,hours,cost'];
  const fmt = (n) => n.toFixed(2);
  const totals = new Map();
  let all = { hours: 0, cost: 0 };
  for (const r of rows) {
    out.push([esc(r.epic), esc(r.person), r.month, fmt(r.hours), fmt(r.cost)].join(','));
    const t = totals.get(r.epic) || { hours: 0, cost: 0 };
    t.hours += r.hours; t.cost += r.cost;
    totals.set(r.epic, t);
    all.hours += r.hours; all.cost += r.cost;
  }
  for (const [epic, t] of totals) out.push([esc(epic), 'TOTAL', '', fmt(t.hours), fmt(t.cost)].join(','));
  out.push(['ALL', 'TOTAL', '', fmt(all.hours), fmt(all.cost)].join(','));
  return out.join('\n') + '\n';
}

async function searchKeys(client, jql) {
  const keys = [];
  let nextPageToken;
  do {
    const page = await client.post('/rest/api/3/search/jql', { body: { jql, fields: ['summary'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } });
    keys.push(...(page.issues || []).map((i) => i.key));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return keys;
}

export async function childKeys(client, epic) {
  const children = await searchKeys(client, `parent = ${epic}`);
  const subtasks = [];
  // JQL "parent in (...)" is limited in size, so ask in chunks.
  for (let i = 0; i < children.length; i += 50) {
    subtasks.push(...await searchKeys(client, `parent in (${children.slice(i, i + 50).join(',')})`));
  }
  return [...new Set([...children, ...subtasks])];
}

export async function fetchWorklogs(client, key) {
  const logs = [];
  for (let startAt = 0; ; ) {
    const page = await client.get(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, { query: { startAt, maxResults: 1000 } });
    const w = page.worklogs || [];
    logs.push(...w);
    startAt += w.length;
    if (w.length === 0 || startAt >= page.total) return logs;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['help'] });
  if (args.help) return console.log(USAGE);
  if (!args.epics || !args.rates) { console.error(USAGE); process.exit(2); }
  const rates = parseRates(readFileSync(args.rates, 'utf8'));
  const client = createClient(configFromEnv());
  const entries = [];
  for (const epic of args.epics.split(',').map((s) => s.trim()).filter(Boolean)) {
    const keys = [epic, ...await childKeys(client, epic)];
    console.error(`${epic}: ${keys.length - 1} child issue(s)`);
    for (const key of keys) {
      for (const w of await fetchWorklogs(client, key)) {
        entries.push({ epic, author: w.author || {}, started: w.started, seconds: w.timeSpentSeconds || 0 });
      }
    }
  }
  const { rows, unpriced } = aggregate(entries, rates);
  if (unpriced.length) console.error(`Warning: no rate found for ${unpriced.join(', ')} (counted as cost 0 for the months without a rate).`);
  const csv = toCsv(rows);
  if (args.out) { (await import('node:fs')).writeFileSync(args.out, csv); console.error(`Wrote ${args.out}`); } else process.stdout.write(csv);
}

if (isMain(import.meta.url)) run(main);
