import os from "node:os";
import path from "node:path";

export const MCP_BASE_URL = "https://mcp.notion.com";
export const MCP_HTTP_URL = new URL("/mcp", MCP_BASE_URL);
export const MCP_SSE_URL = new URL("/sse", MCP_BASE_URL);

export const CLIENT_NAME = "pi-coding-agent";
export const CLIENT_VERSION = "1.0.0";
export const STORAGE_FILE = "auth.json";

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

export const NOTION_SYSTEM_PROMPT =
	"Use the Notion tools whenever the user asks about Notion pages, databases, comments, search, or Notion URLs. Prefer the Notion tools over guessing.";

export const TOOL_SNIPPETS: Record<string, string> = {
	"notion-search": "Search your Notion workspace.",
	"notion-fetch": "Fetch a Notion page, database, or data source by URL or ID.",
	"notion-create-pages": "Create one or more Notion pages.",
	"notion-update-page": "Modify an existing Notion page.",
	"notion-move-pages": "Move Notion pages.",
	"notion-duplicate-page": "Duplicate a Notion page.",
	"notion-create-database": "Create a Notion database.",
	"notion-update-data-source": "Update a Notion data source.",
	"notion-create-view": "Create a Notion view.",
	"notion-update-view": "Update a Notion view.",
	"notion-query-data-sources": "Query Notion data sources.",
	"notion-query-database-view": "Query a Notion database view.",
	"notion-create-comment": "Create a Notion comment.",
	"notion-get-comments": "Read comments from Notion.",
	"notion-get-teams": "List Notion teams.",
	"notion-get-users": "List Notion users.",
	"notion-get-user": "Get a Notion user.",
	"notion-get-self": "Get the current Notion user.",
};

export function getConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function getStorageDir(): string {
	return path.join(getConfigDir(), "extensions", "notion-mcp");
}

export function getStorageFile(): string {
	// OAuth credentials are stored locally per-user (never commit this file).
	return path.join(getStorageDir(), STORAGE_FILE);
}
