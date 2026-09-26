---
name: azure-mcp
description: Use Azure MCP (@azure/mcp) via mcp_call when the user asks about Azure resources, subscriptions, storage, App Service, Key Vault, or cloud deployments.
triggers:
  - azure
  - az login
  - resource group
  - key vault
  - app service
---

# Azure MCP

## Keywords
azure, az, subscription, resource group, storage account, blob, app service, key vault, cosmos, aks, function app, arm, entra, az login, cloud resources

## When to use

When the user asks about Azure resources **and** Azure MCP tools are listed in the MCP tools hint.

## Auth

Azure MCP uses local credentials. If tools fail with auth errors, tell the user to run `az login` (and optionally `az account set --subscription …`), then **CodeForge: Refresh MCP Servers**.

## How to call tools

Use `mcp_call` with full name `Azure__<tool>` (server name + tool). Tool names follow Azure MCP (examples): storage account list, resource group list, subscription list — exact names come from the loaded MCP catalog.

## Rules

1. Prefer read/list tools before create/update/delete; confirm destructive actions.
2. Scope by subscription / resource group when the user names one.
3. Do not invent resource names — list first.
4. If no Azure tools appear, run **CodeForge: Add Azure MCP** (or Settings → MCP → Add Azure).
