# atlassian-admin-scripts

Small scripts for Jira, Confluence and Jira Service Management Cloud admins.

Plain Node.js (22 or newer), no dependencies. Every script that writes data supports `--dry-run`, retries on HTTP 429 using the `Retry-After` header, and stops with a clear message on auth or permission errors.

## Setup

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. Set three environment variables:

```sh
export ATLASSIAN_SITE=your-site.atlassian.net
export ATLASSIAN_EMAIL=you@example.com
export ATLASSIAN_API_TOKEN=your-token
```

3. Clone this repo (https://github.com/kayabyte-2/atlassian-admin-scripts) and run the scripts from `src/`. Run the tests with `npm test`.

Scripts act with the permissions of the account that owns the token.

## confluence-group-watch

Problem: Confluence has no built-in way to make a whole group watch a space or a page.

```sh
node src/confluence-group-watch.js --group "engineering" --space ENG --dry-run
node src/confluence-group-watch.js --group-id <groupId> --page 123456
```

Permissions: adding watchers for other users needs the Confluence Administrator global permission, or Space Administrator on the space. For a page, the account must also be able to view it.

Limits: it adds the people who are in the group right now. People who join the group later are not added, so re-run it (for example on a schedule). Adding someone who already watches is harmless. Users who cannot view the space are reported as failed. A group that was created a moment ago can show 0 members for a short while; run the dry run again after a minute.

Prefer not to run scripts? Group Watchers does this inside Confluence: https://go.kayabyte.dev/atl/group-watchers?s=ot-github-confluence-group-watch
Guide: https://kayabyte.dev/atlassian/guides/confluence-group-watch-space

## jsm-group-participants

Problem: you want everyone in a group on a request (or on all open requests) as participants, so they get notifications.

```sh
node src/jsm-group-participants.js --group "support-staff" --request SUP-123
node src/jsm-group-participants.js --group-id <groupId> --jql 'project = SUP AND statusCategory != Done' --dry-run
```

Options: `--batch-size` (default 50 account IDs per call).

Permissions: browse users and groups (to read group members), browse the project (for the JQL), and permission to manage participants on each request.

Limits: participants must have access to the service project. Agents and customers both work if they can reach the project; users without access make that batch fail, and it is reported and skipped. Only active group members are added. Large JQL results mean many calls, so use `--dry-run` first. New group members are not picked up until the next run.

Prefer not to run scripts? Group Participants does this inside Jira Service Management: https://go.kayabyte.dev/atl/group-participants?s=ot-github-jsm-group-participants
Guide: https://kayabyte.dev/atlassian/guides/jsm-add-group-request-participants

## jira-wip-per-person

Problem: Jira shows work in progress per column, not per person, so overloaded people are easy to miss.

```sh
node src/jira-wip-per-person.js --limit 3
node src/jira-wip-per-person.js --limit 2 --project APP
```

Counts issues matching `statusCategory = "In Progress" AND assignee is not EMPTY` per assignee and flags everyone above `--limit` (default 3). Exits with code 1 if anyone is over, so it can run in a scheduled job.

Permissions: Browse projects on the projects you want counted.

Limits: it only reports. It does not stop anyone from moving more issues to In Progress. Issues you cannot see are not counted.

Prefer not to run scripts? Personal WIP Limits does this inside Jira: https://go.kayabyte.dev/atl/wip-limits?s=ot-github-jira-wip-per-person
Guide: https://kayabyte.dev/atlassian/guides/jira-wip-limit-per-person

## jira-epic-cost

Problem: you want the cost of an epic from logged time, with rates that change over time.

```sh
node src/jira-epic-cost.js --epics APP-1,APP-9 --rates rates.csv --out costs.csv
```

`rates.csv`:

```csv
person,rate,valid_from
5b10ac8d82e05b22cc7d4ef5,100,2025-01-01
Jane Doe,120,2025-07-01
```

`person` is an accountId or a display name; `rate` is per hour. Each worklog is priced with the rate valid on its started date (the latest `valid_from` on or before it). Output is CSV per epic, person and month, plus a TOTAL row per epic and an overall total. People without a rate are listed as a warning and counted at 0.

Permissions: Browse projects and View worklogs on the issues (time tracking must be enabled).

Limits: children are the issues with `parent = EPIC` plus their subtasks; deeper nesting is not followed. Worklogs on the epic itself are included. Months follow the date in the worklog's started timestamp, as stored in Jira.

Prefer not to run scripts? Burnrate does this inside Jira: https://go.kayabyte.dev/atl/burnrate?s=ot-github-jira-epic-cost
Guide: https://kayabyte.dev/atlassian/guides/jira-project-cost-from-worklogs

## jira-worklog-export

Problem: you need the individual worklogs (who, when, how long) in a spreadsheet, and a Jira export only gives you totals per work item.

```sh
node src/jira-worklog-export.js --jql "project = APP" --from 2026-10-01 --to 2026-10-31 --out worklogs.csv
```

Columns: `key, summary, author, accountId, started, hours, seconds, comment`. `--from` and `--to` are inclusive days in UTC, matched on when the work was started, not when it was logged. Text that a spreadsheet would run as a formula gets a leading `'`.

Permissions: Browse projects and View worklogs on the issues (time tracking must be enabled).

Limits: one API call per matching issue, so a large query takes a while. Tempo users: on Cloud, Jira holds Tempo's app account as the author, so this shows that account rather than the person. The file holds names and hours, so treat it as personnel data.

Want it priced, without a file? Burnrate does that inside Jira: https://go.kayabyte.dev/atl/burnrate?s=ot-github-jira-worklog-export
Guide: https://kayabyte.dev/atlassian/guides/jira-export-worklogs

## License

MIT

---

Made by Kayabyte, a software company in Oslo, Norway. https://kayabyte.dev
