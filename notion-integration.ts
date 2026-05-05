import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ACCESS_TOKEN_SKEW_MS } from "./config.js";
import { buildConnectionError, callMcpTool, connectClient, loadTools } from "./mcp-client.js";
import {
	buildAuthorizationUrl,
	createLoginTimeout,
	createLoopbackCallbackServer,
	discoverOAuthMetadata,
	exchangeCodeForTokens,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	openBrowser,
	refreshTokens,
	registerClient,
} from "./oauth.js";
import { clearStoredAuth, loadStoredAuth, saveStoredAuth } from "./storage.js";
import { formatNotionToolList, isNotionToolName, normalizeToolName, schemaToTypeBox, toToolSnippet } from "./tool-registry.js";
import type { NotionClient, NotionTool, OAuthMetadata, StoredAuth, ToolMapEntry } from "./types.js";
import { formatToolResult, isAuthFailure, stringifyError } from "./utils.js";

export class NotionIntegration {
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

		this.auth = await loadStoredAuth();
		return this.auth;
	}

	private async saveAuth(auth: StoredAuth): Promise<void> {
		this.auth = auth;
		await saveStoredAuth(auth);
	}

	private async clearAuth(): Promise<void> {
		this.auth = undefined;
		await clearStoredAuth();
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

		throw buildConnectionError(lastError);
	}

	private async loadToolDefinitions(): Promise<NotionTool[]> {
		const client = await this.ensureClient();
		return await loadTools(client);
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
			const description =
				typeof tool.description === "string" && tool.description.trim() ? tool.description.trim() : `Notion tool: ${mcpName}`;
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
			const result = await callMcpTool(client, mapping.mcpName, params, signal);
			const isError = typeof (result as { isError?: unknown }).isError === "boolean" ? (result as { isError: boolean }).isError : false;
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
					const result = await callMcpTool(client, mappingRetry.mcpName, params, signal);
					const isError =
						typeof (result as { isError?: unknown }).isError === "boolean"
							? (result as { isError: boolean }).isError
							: false;
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
				await clearStoredAuth().catch(() => undefined);
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

			const callback = await Promise.race([callbackServer.waitForCallback, createLoginTimeout()]);
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
			const ok = await ctx.ui.confirm(
				"Disconnect Notion?",
				"This removes the stored OAuth tokens for the global Notion extension.",
			);
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
		const content = [
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
			content,
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
