import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageFile } from "./config.js";
import type { StoredAuth } from "./types.js";
import { isRecord } from "./utils.js";

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

export async function loadStoredAuth(): Promise<StoredAuth | undefined> {
	return await readJsonFile<StoredAuth>(getStorageFile());
}

export async function saveStoredAuth(auth: StoredAuth): Promise<void> {
	await writeJsonFile(getStorageFile(), auth);
}

export async function clearStoredAuth(): Promise<void> {
	await rm(getStorageFile(), { force: true });
}
