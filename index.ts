import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

type OAuthProtectedResourceMetadata = {
	authorization_servers?: string[];
};

type OAuthMetadata = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	code_challenge_methods_supported?: string[];
	grant_types_supported?: string[];
	response_types_supported?: string[];
	scopes_supported?: string[];
};

type ClientRegistration = {
	client_name: string;
	client_uri?: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: "none";
	scope?: string;
};

type ClientCredentials = {
	client_id: string;
	client_secret?: string;
	client_id_issued_at?: number;
	client_secret_expires_at?: number;
};

type TokenResponse = {
	access_token: string;
	token_type: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
};

type StoredAuth = {
	clientId: string;
	clientSecret?: string;
	accessToken: string;
	refreshToken?: string;
	tokenType: string;
	scope?: string;
	expiresAt?: number;
};

type NotionTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
	input_schema?: unknown;
};

type NotionClient = Client & {
	listTools: () => Promise<{ tools: NotionTool[] }>;
	callTool: (
		request: { name: string; arguments?: Record<string, unknown> },
		resultSchema?: unknown,
		options?: { signal?: AbortSignal },
	) => Promise<unknown>;
	close?: () => Promise<void> | void;
};

type CallbackResult = {
	code?: string;
	state?: string;
	error?: string;
	error_description?: string;
};

type ToolMapEntry = {
	mcpName: string;
};

const MCP_BASE_URL = "https://mcp.notion.com";
const MCP_HTTP_URL = new URL("/mcp", MCP_BASE_URL);
const MCP_SSE_URL = new URL("/sse", MCP_BASE_URL);
const CLIENT_NAME = "pi-coding-agent";
const CLIENT_VERSION = "1.0.0";
const STORAGE_FILE = "auth.json";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const NOTION_SYSTEM_PROMPT =
	"Use the Notion tools whenever the user asks about Notion pages, databases, comments, search, or Notion URLs. Prefer the Notion tools over guessing.";

const TOOL_SNIPPETS: Record<string, string> = {
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

function getConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function getStorageDir(): string {
	return path.join(getConfigDir(), "extensions", "notion-mcp");
}

function getStorageFile(): string {
	// OAuth credentials are stored locally per-user (never commit this file).
	return path.join(getStorageDir(), STORAGE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function generateCodeVerifier(): string {
	return base64UrlEncode(randomBytes(32));
}

function generateCodeChallenge(codeVerifier: string): string {
	return base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
}

function generateState(): string {
	return base64UrlEncode(randomBytes(32));
}

function normalizeToolName(name: string): string {
	return `notion_${name.replace(/-/g, "_")}`;
}

function isNotionToolName(name: string): boolean {
	return name.startsWith("notion_");
}

function toToolSnippet(mcpName: string, description: string): string {
	return TOOL_SNIPPETS[mcpName] ?? description;
}

function formatNotionToolList(tools: Array<{ name: string; description?: string }>): string {
	if (tools.length === 0) {
		return "_Aucun outil Notion n'est chargé._";
	}

	return tools
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			const mcpName = tool.name.replace(/^notion_/, "").replace(/_/g, "-");
			const summary = TOOL_SNIPPETS[mcpName] ?? tool.description?.split(/\r?\n/)[0]?.trim() ?? "";
			return summary ? `- \`${mcpName}\` — ${summary}` : `- \`${mcpName}\``;
		})
		.join("\n");
}

function schemaToTypeBox(schema: unknown) {
	if (!schema || typeof schema !== "object") {
		return Type.Object({});
	}
	return Type.Unsafe<Record<string, unknown>>(schema as never);
}

function formatToolResult(result: unknown): string {
	if (!isRecord(result)) {
		return JSON.stringify(result, null, 2);
	}

	const chunks: string[] = [];
	const content = result.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block)) {
				chunks.push(JSON.stringify(block, null, 2));
				continue;
			}

			if (block.type === "text" && typeof block.text === "string") {
				chunks.push(block.text);
				continue;
			}

			chunks.push(JSON.stringify(block, null, 2));
		}
	}

	if (isRecord(result.structuredContent)) {
		chunks.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	}

	if (chunks.length === 0) {
		return JSON.stringify(result, null, 2);
	}

	return chunks.join("\n\n");
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return JSON.stringify(error, null, 2);
}

function isAuthFailure(error: unknown): boolean {
	const message = stringifyError(error).toLowerCase();
	return message.includes("401") || message.includes("unauthorized") || message.includes("invalid_token");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if (isRecord(error) && typeof error.code === "string" && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await chmod(filePath, 0o600).catch(() => undefined);
}

async function removeJsonFile(filePath: string): Promise<void> {
	await rm(filePath, { force: true });
}

function openBrowser(url: string): void {
	// Best-effort browser open. Detached so /notion-login never blocks on this process.
	const child =
		process.platform === "darwin"
			? spawn("open", [url], { detached: true, stdio: "ignore" })
			: process.platform === "win32"
				? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
				: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
}

async function discoverOAuthMetadata(): Promise<OAuthMetadata> {
	// RFC 9470 -> RFC 8414 discovery flow (resource metadata -> auth server metadata).
	const protectedResourceUrl = new URL("/.well-known/oauth-protected-resource", MCP_HTTP_URL);
	const protectedResourceResponse = await fetch(protectedResourceUrl);
	if (!protectedResourceResponse.ok) {
		throw new Error(`Failed to fetch protected resource metadata: ${protectedResourceResponse.status}`);
	}

	const protectedResource = (await protectedResourceResponse.json()) as OAuthProtectedResourceMetadata;
	const authServers = protectedResource.authorization_servers;
	if (!Array.isArray(authServers) || authServers.length === 0) {
		throw new Error("Notion MCP did not return any authorization servers");
	}

	const authorizationServerUrl = new URL("/.well-known/oauth-authorization-server", authServers[0]);
	const metadataResponse = await fetch(authorizationServerUrl);
	if (!metadataResponse.ok) {
		throw new Error(`Failed to fetch authorization server metadata: ${metadataResponse.status}`);
	}

	const metadata = (await metadataResponse.json()) as OAuthMetadata;
	if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
		throw new Error("Notion OAuth metadata is missing required endpoints");
	}

	return metadata;
}

async function registerClient(metadata: OAuthMetadata, redirectUri: string): Promise<ClientCredentials> {
	if (!metadata.registration_endpoint) {
		throw new Error("Notion OAuth server does not expose a registration endpoint");
	}

	const request: ClientRegistration = {
		client_name: CLIENT_NAME,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};

	const response = await fetch(metadata.registration_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(request),
	});

	if (!response.ok) {
		throw new Error(`Client registration failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as ClientCredentials;
}

function buildAuthorizationUrl(
	metadata: OAuthMetadata,
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
	state: string,
): string {
	const url = new URL(metadata.authorization_endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

async function exchangeCodeForTokens(
	metadata: OAuthMetadata,
	clientId: string,
	clientSecret: string | undefined,
	redirectUri: string,
	code: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code,
		code_verifier: codeVerifier,
	});

	if (clientSecret) {
		body.set("client_secret", clientSecret);
	}

	const response = await fetch(metadata.token_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": "pi-coding-agent/1.0",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
	}

	const tokens = (await response.json()) as TokenResponse;
	if (!tokens.access_token) {
		throw new Error("Token exchange did not return an access token");
	}
	return tokens;
}

async function refreshTokens(
	metadata: OAuthMetadata,
	clientId: string,
	clientSecret: string | undefined,
	refreshToken: string,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken,
	});

	if (clientSecret) {
		body.set("client_secret", clientSecret);
	}

	const response = await fetch(metadata.token_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": "pi-coding-agent/1.0",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
	}

	const tokens = (await response.json()) as TokenResponse;
	if (!tokens.access_token) {
		throw new Error("Token refresh did not return an access token");
	}
	return tokens;
}

async function createLoopbackCallbackServer(): Promise<{
	redirectUri: string;
	waitForCallback: Promise<CallbackResult>;
	close: () => Promise<void>;
}> {
	// Local callback receiver for OAuth authorization code redirect.
	let resolveCallback: ((value: CallbackResult) => void) | undefined;
	let rejected = false;
	let settled = false;

	const waitForCallback = new Promise<CallbackResult>((resolve) => {
		resolveCallback = resolve;
	});

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (!req.url) {
			res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Missing URL");
			return;
		}

		const requestUrl = new URL(req.url, "http://127.0.0.1");
		if (requestUrl.pathname !== "/callback") {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}

		const payload: CallbackResult = {
			code: requestUrl.searchParams.get("code") ?? undefined,
			state: requestUrl.searchParams.get("state") ?? undefined,
			error: requestUrl.searchParams.get("error") ?? undefined,
			error_description: requestUrl.searchParams.get("error_description") ?? undefined,
		};

		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><html><body><p>Notion login complete. You can return to pi.</p></body></html>`);

		if (!settled) {
			settled = true;
			resolveCallback?.(payload);
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to allocate a loopback port for OAuth callback");
	}

	const redirectUri = `http://127.0.0.1:${address.port}/callback`;
	return {
		redirectUri,
		waitForCallback,
		close: async () => {
			if (rejected) return;
			rejected = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function connectClient(accessToken: string, useSse: boolean): Promise<NotionClient> {
	const client = new Client(
		{
			name: CLIENT_NAME,
			version: CLIENT_VERSION,
		},
		{
			capabilities: {
				roots: {},
				sampling: {},
			},
		},
	) as NotionClient;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": `${CLIENT_NAME}/${CLIENT_VERSION}`,
	};
	const transport = useSse
		? new SSEClientTransport(MCP_SSE_URL, {
				requestInit: { headers },
				eventSourceInit: { headers },
			})
		: new StreamableHTTPClientTransport(MCP_HTTP_URL, {
				requestInit: { headers },
			});

	await client.connect(transport);
	return client;
}

class NotionIntegration {
	private auth: StoredAuth | undefined;
	private client: NotionClient | undefined;
	private metadata: OAuthMetadata | undefined;
	private toolMap = new Map<string, ToolMapEntry>();
	private toolsRegistered = false;
	private startupPromise: Promise<void> | undefined;
	private loginTask: Promise<void> | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	private async loadAuth(): Promise<StoredAuth | undefined> {
		if (this.auth !== undefined) {
			return this.auth;
		}

		this.auth = await readJsonFile<StoredAuth>(getStorageFile());
		return this.auth;
	}

	private async saveAuth(auth: StoredAuth): Promise<void> {
		this.auth = auth;
		await writeJsonFile(getStorageFile(), auth);
	}

	private async clearAuth(): Promise<void> {
		this.auth = undefined;
		await removeJsonFile(getStorageFile());
	}

	private async closeClient(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		if (!client) return;

		const close = client.close;
		if (typeof close === "function") {
			await close.call(client).catch(() => undefined);
		}
	}

	private async getMetadata(): Promise<OAuthMetadata> {
		if (!this.metadata) {
			this.metadata = await discoverOAuthMetadata();
		}
		return this.metadata;
	}

	private async ensureFreshAuth(forceRefresh = false): Promise<StoredAuth> {
		const auth = await this.loadAuth();
		if (!auth) {
			throw new Error("Notion is not connected. Run /notion-login first.");
		}

		if (!forceRefresh && auth.expiresAt && auth.expiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS) {
			return auth;
		}

		if (!auth.refreshToken) {
			throw new Error("Notion access token expired and no refresh token is available. Run /notion-login.");
		}

		const metadata = await this.getMetadata();
		const refreshed = await refreshTokens(metadata, auth.clientId, auth.clientSecret, auth.refreshToken);
		const updated: StoredAuth = {
			clientId: auth.clientId,
			clientSecret: auth.clientSecret,
			accessToken: refreshed.access_token,
			refreshToken: refreshed.refresh_token ?? auth.refreshToken,
			tokenType: refreshed.token_type,
			scope: refreshed.scope ?? auth.scope,
			expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
		};

		await this.saveAuth(updated);
		await this.closeClient();
		return updated;
	}

	private async ensureClient(forceReconnect = false): Promise<NotionClient> {
		if (this.client && !forceReconnect) {
			// Reuse live connection between calls when possible.
			return this.client;
		}

		await this.closeClient();
		const auth = await this.ensureFreshAuth();
		const candidates: Array<{ useSse: boolean }> = [{ useSse: false }, { useSse: true }];
		let lastError: unknown;

		// Prefer Streamable HTTP, fall back to SSE when needed.
		for (const candidate of candidates) {
			try {
				this.client = await connectClient(auth.accessToken, candidate.useSse);
				return this.client;
			} catch (error) {
				lastError = error;
			}
		}

		throw new Error(`Failed to connect to Notion MCP: ${stringifyError(lastError)}`);
	}

	private async loadToolDefinitions(): Promise<NotionTool[]> {
		const client = await this.ensureClient();
		const response = await client.listTools();
		return response.tools;
	}

	private registerToolWrappers(tools: NotionTool[]): void {
		if (this.toolsRegistered) {
			// Tools already registered for this runtime, only re-enable if needed.
			this.setActiveTools([...this.toolMap.keys()], true);
			return;
		}

		const toolNames: string[] = [];
		for (const tool of tools) {
			// Mirror MCP tool names to pi tool names (notion-search -> notion_notion_search).
			const mcpName = tool.name;
			const piName = normalizeToolName(mcpName);
			const description = typeof tool.description === "string" && tool.description.trim() ? tool.description.trim() : `Notion tool: ${mcpName}`;
			const inputSchema = tool.inputSchema ?? tool.input_schema;
			this.toolMap.set(piName, { mcpName });
			toolNames.push(piName);

			this.pi.registerTool({
				name: piName,
				label: mcpName,
				description,
				promptSnippet: toToolSnippet(mcpName, description),
				parameters: schemaToTypeBox(inputSchema),
				execute: async (_toolCallId, params, signal) => {
					return await this.runTool(piName, params, signal);
				},
			});
		}

		this.toolsRegistered = true;
		this.setActiveTools(toolNames, true);
	}

	private setActiveTools(toolNames: string[], enabled: boolean): void {
		const current = new Set(this.pi.getActiveTools());
		for (const toolName of toolNames) {
			if (enabled) {
				current.add(toolName);
			} else {
				current.delete(toolName);
			}
		}
		this.pi.setActiveTools([...current]);
	}

	private async runTool(piName: string, params: Record<string, unknown>, signal?: AbortSignal) {
		// Wrapper execution: resolve mapped MCP tool and forward arguments.
		const mapping = this.toolMap.get(piName);
		if (!mapping) {
			return {
				content: [{ type: "text", text: `Unknown Notion tool: ${piName}` }],
				details: {},
				isError: true,
			};
		}

		try {
			const client = await this.ensureClient();
			const result = await client.callTool({ name: mapping.mcpName, arguments: params }, undefined, { signal });
			const isError = isRecord(result) && typeof result.isError === "boolean" ? result.isError : false;
			return {
				content: [{ type: "text", text: formatToolResult(result) }],
				details: { notionTool: mapping.mcpName, result },
				isError,
			};
		} catch (error) {
			if (isAuthFailure(error)) {
				// Token may have expired mid-session; force refresh once then retry.
				try {
					await this.ensureFreshAuth(true);
					const client = await this.ensureClient(true);
					const mappingRetry = this.toolMap.get(piName);
					if (!mappingRetry) {
						throw error;
					}
					const result = await client.callTool({ name: mappingRetry.mcpName, arguments: params }, undefined, {
						signal,
					});
					const isError = isRecord(result) && typeof result.isError === "boolean" ? result.isError : false;
					return {
						content: [{ type: "text", text: formatToolResult(result) }],
						details: { notionTool: mappingRetry.mcpName, result },
						isError,
					};
				} catch (retryError) {
					return {
						content: [{ type: "text", text: `Notion call failed after refresh: ${stringifyError(retryError)}` }],
						details: { notionTool: mapping.mcpName },
						isError: true,
					};
				}
			}

			return {
				content: [{ type: "text", text: `Notion call failed: ${stringifyError(error)}` }],
				details: { notionTool: mapping.mcpName },
				isError: true,
			};
		}
	}

	async initializeFromDisk(ctx?: ExtensionContext): Promise<void> {
		if (this.startupPromise) {
			return this.startupPromise;
		}

		this.startupPromise = (async () => {
			let auth: StoredAuth | undefined;
			try {
				auth = await this.loadAuth();
			} catch (error) {
				this.auth = undefined;
				await removeJsonFile(getStorageFile()).catch(() => undefined);
				if (ctx?.hasUI) {
					ctx.ui.notify(`Notion auth file is invalid: ${stringifyError(error)}`, "warning");
				}
				return;
			}
			if (!auth) {
				return;
			}

			try {
				const tools = await this.loadToolDefinitions();
				this.registerToolWrappers(tools);
				if (ctx?.hasUI) {
					ctx.ui.notify("Notion MCP connected.", "info");
				}
			} catch (error) {
				const toolNames = [...this.toolMap.keys()];
				await this.closeClient();
				this.toolsRegistered = false;
				this.setActiveTools(toolNames, false);
				this.toolMap.clear();
				if (ctx?.hasUI) {
					ctx.ui.notify(`Notion MCP unavailable: ${stringifyError(error)}`, "warning");
				}
			}
		})();

		return this.startupPromise;
	}

	async login(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			throw new Error("Notion login requires an interactive terminal.");
		}

		if (this.loginTask) {
			ctx.ui.notify("Notion login is already in progress.", "warning");
			return;
		}

		// Run login in background so the slash command returns immediately.
		this.loginTask = this.runLoginFlow(ctx).finally(() => {
			this.loginTask = undefined;
		});
		ctx.ui.notify("Notion login started. If the browser does not open automatically, use /notion-status and retry.", "info");
		void this.loginTask.catch((error) => {
			ctx.ui.notify(`Notion login failed: ${stringifyError(error)}`, "error");
		});
	}

	private async runLoginFlow(ctx: ExtensionCommandContext): Promise<void> {
		const metadata = await this.getMetadata();
		const callbackServer = await createLoopbackCallbackServer();
		const codeVerifier = generateCodeVerifier();
		const state = generateState();

		try {
			const registration = await registerClient(metadata, callbackServer.redirectUri);
			const authUrl = buildAuthorizationUrl(
				metadata,
				registration.client_id,
				callbackServer.redirectUri,
				generateCodeChallenge(codeVerifier),
				state,
			);

			ctx.ui.notify("Opening Notion login in your browser.", "info");
			openBrowser(authUrl);
			ctx.ui.notify(`If nothing opened, use this URL: ${authUrl}`, "info");

			const timeout = new Promise<CallbackResult>((_, reject) => {
				setTimeout(() => reject(new Error("Notion login timed out")), LOGIN_TIMEOUT_MS);
			});

			const callback = await Promise.race([callbackServer.waitForCallback, timeout]);
			if (callback.error) {
				throw new Error(`${callback.error}: ${callback.error_description ?? "No additional error details"}`);
			}
			if (callback.state !== state) {
				throw new Error("OAuth state mismatch");
			}
			if (!callback.code) {
				throw new Error("OAuth callback did not include an authorization code");
			}

			const tokens = await exchangeCodeForTokens(
				metadata,
				registration.client_id,
				registration.client_secret,
				callbackServer.redirectUri,
				callback.code,
				codeVerifier,
			);

			await this.saveAuth({
				clientId: registration.client_id,
				clientSecret: registration.client_secret,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				tokenType: tokens.token_type,
				scope: tokens.scope,
				expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
			});

			await this.closeClient();
			try {
				const tools = await this.loadToolDefinitions();
				this.registerToolWrappers(tools);
				ctx.ui.notify("Notion connected.", "success");
			} catch (error) {
				ctx.ui.notify(`Notion connected, but failed to load tools: ${stringifyError(error)}`, "warning");
			}
		} finally {
			await callbackServer.close();
		}
	}

	async logout(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm("Disconnect Notion?", "This removes the stored OAuth tokens for the global Notion extension.");
			if (!ok) {
				return;
			}
		}

		const toolNames = [...this.toolMap.keys()];
		await this.closeClient();
		await this.clearAuth();
		this.toolsRegistered = false;
		this.setActiveTools(toolNames, false);
		this.toolMap.clear();
		ctx.ui.notify("Notion disconnected.", "info");
	}

	async status(ctx: ExtensionCommandContext): Promise<void> {
		const auth = await this.loadAuth();
		const notionTools = this.pi.getAllTools().filter((tool) => isNotionToolName(tool.name));
		const loginInProgress = Boolean(this.loginTask);

		if (!auth) {
			this.pi.sendMessage({
				customType: "notion-status",
				content: [
					"# Notion status",
					"",
					"- **State:** disconnected",
					`- **Login in progress:** ${loginInProgress ? "yes" : "no"}`,
					"- **Access token:** unavailable",
					"",
					"## Available tools (0)",
					"_Aucun outil Notion n'est chargé._",
				].join("\n"),
				display: true,
				details: { connected: false, toolCount: 0, toolNames: [], loginInProgress, timestamp: Date.now() },
			});
			ctx.ui.notify("Notion is disconnected.", "info");
			return;
		}

		const expiresIn = auth.expiresAt ? Math.max(0, Math.floor((auth.expiresAt - Date.now()) / 1000)) : undefined;
		const connectionState = this.pi.getActiveTools().some((toolName) => isNotionToolName(toolName))
			? "connected"
			: "connected, tools inactive";
		const header = [
			"# Notion status",
			"",
			`- **State:** ${connectionState}`,
			`- **Login in progress:** ${loginInProgress ? "yes" : "no"}`,
			expiresIn !== undefined
				? `- **Access token:** expires in ${expiresIn}s`
				: "- **Access token:** expiry unknown",
			"",
			`## Available tools (${notionTools.length})`,
			formatNotionToolList(notionTools.map((tool) => ({ name: tool.name, description: tool.description }))),
		].join("\n");

		this.pi.sendMessage({
			customType: "notion-status",
			content: header,
			display: true,
			details: {
				connected: true,
				toolCount: notionTools.length,
				toolNames: notionTools.map((tool) => tool.name),
				loginInProgress,
				expiresIn,
				timestamp: Date.now(),
			},
		});
		ctx.ui.notify(`Notion: ${connectionState}.`, "info");
	}
}

export default function notionExtension(pi: ExtensionAPI) {
	const notion = new NotionIntegration(pi);

	pi.on("session_start", async (_event, ctx) => {
		await notion.initializeFromDisk(ctx);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const activeTools = pi.getActiveTools();
		if (!activeTools.some((toolName) => isNotionToolName(toolName))) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${NOTION_SYSTEM_PROMPT}`,
		};
	});

	pi.registerCommand("notion-login", {
		description: "Connect pi to Notion using OAuth.",
		handler: async (_args, ctx) => {
			await notion.login(ctx);
		},
	});

	pi.registerCommand("notion-logout", {
		description: "Disconnect pi from Notion and forget the stored OAuth tokens.",
		handler: async (_args, ctx) => {
			await notion.logout(ctx);
		},
	});

	pi.registerCommand("notion-status", {
		description: "Show the current Notion connection status.",
		handler: async (_args, ctx) => {
			await notion.status(ctx);
		},
	});
}
