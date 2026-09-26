---
name: azure-devops-mcp
description: Use Azure DevOps MCP via mcp_call when the user asks about work items, boards, repos, pipelines, or wiki in Azure DevOps.
triggers:
  - azure devops
  - ado
  - work item
  - azure boards
  - azure pipelines
---

# Azure DevOps MCP

## Keywords
azure devops, ado, work item, board, sprint, pipeline, build, release, pull request, repo, wiki, azure boards, azure repos, azure pipelines

## When to use

When the user asks about Azure DevOps work items, repos, or pipelines **and** Azure DevOps MCP tools are listed in the MCP tools hint.

## Auth

Local `@azure-devops/mcp` uses Azure CLI / Entra credentials for the organization passed in Args. If auth fails, tell the user to run `az login`, confirm the org slug in MCP Args, then **CodeForge: Refresh MCP Servers**.

## How to call tools

Use `mcp_call` with full name `Azure_DevOps__<tool>` (server name + tool; spaces become underscores). Exact tool names come from the loaded MCP catalog.

## Rules

1. Prefer read/list tools before create/update; confirm destructive actions.
2. Scope by project / team when the user names one.
3. Do not invent work item IDs — search first.
4. If no Azure DevOps tools appear, run **CodeForge: Add Azure DevOps MCP** (or Settings → Plugins → Azure DevOps → Add) and enter the organization name.
