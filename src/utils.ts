export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stringifyError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return JSON.stringify(error, null, 2);
}

export function isAuthFailure(error: unknown): boolean {
	const message = stringifyError(error).toLowerCase();
	return message.includes("401") || message.includes("unauthorized") || message.includes("invalid_token");
}

export function formatToolResult(result: unknown): string {
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
