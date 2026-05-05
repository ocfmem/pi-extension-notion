import { Type } from "typebox";
import { TOOL_SNIPPETS } from "./config.js";

export function normalizeToolName(name: string): string {
	return `notion_${name.replace(/-/g, "_")}`;
}

export function isNotionToolName(name: string): boolean {
	return name.startsWith("notion_");
}

export function toToolSnippet(mcpName: string, description: string): string {
	return TOOL_SNIPPETS[mcpName] ?? description;
}

export function schemaToTypeBox(schema: unknown) {
	if (!schema || typeof schema !== "object") {
		return Type.Object({});
	}
	return Type.Unsafe<Record<string, unknown>>(schema as never);
}

export function formatNotionToolList(tools: Array<{ name: string; description?: string }>): string {
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
