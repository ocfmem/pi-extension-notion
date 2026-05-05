import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLIENT_NAME, CLIENT_VERSION, MCP_HTTP_URL, MCP_SSE_URL } from "./config.js";
import type { NotionClient, NotionTool } from "./types.js";
import { stringifyError } from "./utils.js";

export async function connectClient(accessToken: string, useSse: boolean): Promise<NotionClient> {
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

export async function loadTools(client: NotionClient): Promise<NotionTool[]> {
	const response = (await client.listTools()) as { tools: NotionTool[] };
	return response.tools;
}

export async function callMcpTool(
	client: NotionClient,
	mcpName: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	return await client.callTool({ name: mcpName, arguments: params }, undefined, { signal });
}

export function buildConnectionError(lastError: unknown): Error {
	return new Error(`Failed to connect to Notion MCP: ${stringifyError(lastError)}`);
}
