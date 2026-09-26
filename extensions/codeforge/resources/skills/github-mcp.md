---
name: github-mcp
description: Use GitHub MCP via mcp_call when the user asks about issues, pull requests, repositories, or GitHub code search.
triggers:
  - github
  - pull request
  - gh issue
  - github repo
---

# GitHub MCP

## Keywords
github, gh, issue, pull request, PR, repository, repo, gist, code search, actions, workflow run

## When to use

When the user asks about GitHub issues, PRs, or repos **and** GitHub MCP tools are listed in the MCP tools hint.

## Auth

Remote GitHub MCP (`https://api.githubcopilot.com/mcp/`) uses a Personal Access Token in the MCP server **API key** field. If tools fail with 401, tell the user to add a PAT (classic or fine-grained with needed scopes), Save, then **CodeForge: Refresh MCP Servers**.

## How to call tools

Use `mcp_call` with full name `GitHub__<tool>` (server name + tool). Exact tool names come from the loaded MCP catalog.

## Rules

1. Prefer read tools before create/update/merge; confirm destructive actions.
2. Do not invent issue/PR numbers — search or list first.
3. If no GitHub tools appear, run **CodeForge: Add GitHub MCP** (or Settings → Plugins → GitHub → Add).
