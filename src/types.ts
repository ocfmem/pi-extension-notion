import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type OAuthProtectedResourceMetadata = {
	authorization_servers?: string[];
};

export type OAuthMetadata = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	code_challenge_methods_supported?: string[];
	grant_types_supported?: string[];
	response_types_supported?: string[];
	scopes_supported?: string[];
};

export type ClientRegistration = {
	client_name: string;
	client_uri?: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: "none";
	scope?: string;
};

export type ClientCredentials = {
	client_id: string;
	client_secret?: string;
	client_id_issued_at?: number;
	client_secret_expires_at?: number;
};

export type TokenResponse = {
	access_token: string;
	token_type: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
};

export type StoredAuth = {
	clientId: string;
	clientSecret?: string;
	accessToken: string;
	refreshToken?: string;
	tokenType: string;
	scope?: string;
	expiresAt?: number;
};

export type NotionTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
	input_schema?: unknown;
};

export type NotionClient = Client & {
	close?: () => Promise<void> | void;
};

export type CallbackResult = {
	code?: string;
	state?: string;
	error?: string;
	error_description?: string;
};

export type ToolMapEntry = {
	mcpName: string;
};
