# Notion MCP extension for pi

pi extension that connects to Notion's hosted MCP server (`https://mcp.notion.com`) with OAuth (PKCE), mirrors Notion MCP tools into pi tools, and exposes helper commands.

## Features

- OAuth login with local loopback callback
- Automatic token refresh
- MCP transport fallback: Streamable HTTP -> SSE
- Dynamic tool registration from Notion MCP `listTools`
- Status/report command with loaded tools

## Commands

- `/notion-login` - start OAuth login flow
- `/notion-status` - show connection status and available tools
- `/notion-logout` - remove local OAuth credentials

## Installation

### 1) Place the extension folder in a pi extensions directory

Choose placement based on scope:

- Global scope (all projects): `~/.pi/agent/extensions/notion-mcp`
- Project scope (current project only): `<project>/.pi/extensions/notion-mcp`

### 2) Install dependencies

```bash
cd <chosen-extension-path>
npm install
```

### 3) Reload pi

In pi interactive mode:

```text
/reload
```

## Usage

1. Run `/notion-login`
2. Complete OAuth in browser
3. Run `/notion-status` to verify tools
4. Use natural prompts (pi can call Notion tools automatically)

Examples:

- "Create a Notion page titled Sprint Notes"
- "Search in Notion for roadmap"
- "Update this Notion page status to In progress"

## Credentials and security

- OAuth credentials are stored locally in `auth.json` next to the extension.
- `auth.json` is intentionally ignored by git.
- Never commit `auth.json`.

## Troubleshooting

- Browser did not open: copy the URL printed by `/notion-login` and open it manually.
- Status says disconnected: run `/notion-login` again.
- Tools missing after login: run `/reload`, then `/notion-status`.
