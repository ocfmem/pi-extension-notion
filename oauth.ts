import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	CLIENT_NAME,
	LOGIN_TIMEOUT_MS,
	MCP_HTTP_URL,
} from "./config.js";
import type {
	CallbackResult,
	ClientCredentials,
	ClientRegistration,
	OAuthMetadata,
	OAuthProtectedResourceMetadata,
	TokenResponse,
} from "./types.js";

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
	return base64UrlEncode(randomBytes(32));
}

export function generateCodeChallenge(codeVerifier: string): string {
	return base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
}

export function generateState(): string {
	return base64UrlEncode(randomBytes(32));
}

// RFC 9470 -> RFC 8414 discovery flow (resource metadata -> auth server metadata).
export async function discoverOAuthMetadata(): Promise<OAuthMetadata> {
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

export async function registerClient(metadata: OAuthMetadata, redirectUri: string): Promise<ClientCredentials> {
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

export function buildAuthorizationUrl(
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

export async function exchangeCodeForTokens(
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
			"User-Agent": `${CLIENT_NAME}/1.0`,
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

export async function refreshTokens(
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
			"User-Agent": `${CLIENT_NAME}/1.0`,
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

// Local callback receiver for OAuth authorization code redirect.
export async function createLoopbackCallbackServer(): Promise<{
	redirectUri: string;
	waitForCallback: Promise<CallbackResult>;
	close: () => Promise<void>;
}> {
	let resolveCallback: ((value: CallbackResult) => void) | undefined;
	let closed = false;
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
		res.end("<!doctype html><html><body><p>Notion login complete. You can return to pi.</p></body></html>");

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
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export function openBrowser(url: string): void {
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

export function createLoginTimeout(): Promise<CallbackResult> {
	return new Promise<CallbackResult>((_, reject) => {
		setTimeout(() => reject(new Error("Notion login timed out")), LOGIN_TIMEOUT_MS);
	});
}
