---
name: atlassian-mcp
description: Use Atlassian Rovo MCP (Jira, Confluence, Loom) via mcp_call when the user asks about tickets, docs, sprints, or company knowledge in Atlassian.
triggers:
  - atlassian
  - jira
  - confluence
  - jql
  - rovo
---

# Atlassian MCP

## Keywords
jira, confluence, atlassian, ticket, issue, jql, cql, backlog, sprint, rovo, loom, company docs, search jira, create issue, confluence page

## When to use

When the user asks about Jira issues, Confluence pages, sprints, or Atlassian company knowledge **and** Atlassian MCP tools are listed in the MCP tools hint.

## How to call tools

CodeForge exposes MCP through `mcp_call` with the full name `Atlassian__<tool>` (server name + tool).

Typical tools (names may vary by Rovo version):

- `search` / `searchJiraIssuesUsingJql` / `getJiraIssue` — find or read issues
- `createJiraIssue` / `editJiraIssue` / `addOrEditJiraIssueComment` / `transitionJiraIssue`
- `searchConfluence` / `getConfluenceContent` / `createConfluenceContent` / `updateConfluenceContent`
- `getAccessibleAtlassianResources` — obtain `cloudId` when required
- `atlassianUserInfo` — current user accountId
- `discover` + `executeRead` / `executeWrite` / `executeDestructive` — operations not in the primary list

## Rules

1. Prefer read tools before writes; confirm destructive actions with the user.
2. For site-scoped APIs, call `getAccessibleAtlassianResources` once and reuse `cloudId`.
3. If MCP auth fails or no Atlassian tools are listed, tell the user to run **CodeForge: Add Atlassian MCP**, complete browser OAuth, then **CodeForge: Refresh MCP Servers**.
4. Do not invent issue keys or page IDs — search first.
