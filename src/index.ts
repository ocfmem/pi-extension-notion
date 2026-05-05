import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { NOTION_SYSTEM_PROMPT } from "./config.js";
import { NotionIntegration } from "./notion-integration.js";
import { isNotionToolName } from "./tool-registry.js";

export default function notionExtension(pi: ExtensionAPI) {
	const notion = new NotionIntegration(pi);

	pi.on("session_start", async (_event, ctx) => {
		await notion.initializeFromDisk(ctx);
	});

	pi.on("before_agent_start", async (event) => {
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
