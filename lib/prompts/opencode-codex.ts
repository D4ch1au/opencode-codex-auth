/**
 * OpenCode Codex Prompt Fetcher
 *
 * Fetches and caches the codex.txt system prompt from OpenCode's GitHub repository.
 * Uses ETag-based caching to efficiently track updates.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const OPENCODE_CODEX_URL =
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_FILE = join(CACHE_DIR, "opencode-codex.txt");
const CACHE_META_FILE = join(CACHE_DIR, "opencode-codex-meta.json");

interface CacheMeta {
	etag: string;
	lastFetch?: string; // Legacy field for backwards compatibility
	lastChecked: number; // Timestamp for rate limit protection
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let pendingRefresh: Promise<void> | null = null;

/**
 * Perform the actual GitHub fetch and update cache files.
 */
async function fetchAndCachePrompt(
	cachedEtag: string | null,
): Promise<string | null> {
	const headers: Record<string, string> = {};
	if (cachedEtag) {
		headers["If-None-Match"] = cachedEtag;
	}

	const response = await fetch(OPENCODE_CODEX_URL, { headers });

	if (response.status === 304) {
		// Not modified — update lastChecked only
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(
			CACHE_META_FILE,
			JSON.stringify(
				{
					etag: cachedEtag ?? "",
					lastFetch: new Date().toISOString(),
					lastChecked: Date.now(),
				} satisfies CacheMeta,
				null,
				2,
			),
			"utf-8",
		);
		try {
			return await readFile(CACHE_FILE, "utf-8");
		} catch {
			return null;
		}
	}

	if (response.ok) {
		const content = await response.text();
		const etag = response.headers.get("etag") || "";

		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(CACHE_FILE, content, "utf-8");
		await writeFile(
			CACHE_META_FILE,
			JSON.stringify(
				{
					etag,
					lastFetch: new Date().toISOString(),
					lastChecked: Date.now(),
				} satisfies CacheMeta,
				null,
				2,
			),
			"utf-8",
		);

		return content;
	}

	throw new Error(`Failed to fetch OpenCode codex.txt: ${response.status}`);
}

/**
 * Fire a non-blocking background refresh.
 * Errors are silently swallowed when cached content exists.
 */
function triggerBackgroundRefresh(
	cachedEtag: string | null,
	hasCachedContent: boolean,
): void {
	if (pendingRefresh) return;

	pendingRefresh = fetchAndCachePrompt(cachedEtag)
		.catch((error) => {
			if (!hasCachedContent) {
				console.error(
					`[openai-codex-plugin] Background refresh of OpenCode prompt failed:`,
					(error as Error).message,
				);
			}
		})
		.then(() => {})
		.finally(() => {
			pendingRefresh = null;
		});
}

/**
 * Fetch OpenCode's codex.txt prompt with ETag-based caching.
 *
 * Non-blocking strategy:
 *  - If cache is within 6h TTL, return immediately.
 *  - If cache is stale but present, return it immediately AND trigger
 *    a background refresh for the next request.
 *  - Only blocks on network when no cache exists at all.
 *
 * @returns The codex.txt content
 */
export async function getOpenCodeCodexPrompt(): Promise<string> {
	await mkdir(CACHE_DIR, { recursive: true });

	let cachedContent: string | null = null;
	let cachedMeta: CacheMeta | null = null;

	try {
		cachedContent = await readFile(CACHE_FILE, "utf-8");
		const metaContent = await readFile(CACHE_META_FILE, "utf-8");
		cachedMeta = JSON.parse(metaContent);
	} catch {
		// Cache doesn't exist or is invalid
	}

	const isFresh =
		cachedMeta?.lastChecked != null &&
		Date.now() - cachedMeta.lastChecked < CACHE_TTL_MS &&
		cachedContent != null;

	// Fast path: cache is fresh
	if (isFresh && cachedContent) {
		return cachedContent;
	}

	// Stale cache exists — return it now, refresh in background
	if (cachedContent) {
		triggerBackgroundRefresh(cachedMeta?.etag ?? null, true);
		return cachedContent;
	}

	// No cache — must fetch synchronously
	try {
		const result = await fetchAndCachePrompt(cachedMeta?.etag ?? null);
		if (result) return result;
	} catch (error) {
		// No cache and fetch failed — nothing we can do
		throw new Error(
			`Failed to fetch OpenCode codex.txt and no cache available: ${error}`,
		);
	}

	throw new Error("Failed to fetch OpenCode codex.txt and no cache available");
}

/**
 * Get first N characters of the cached OpenCode prompt for verification
 * @param chars Number of characters to get (default: 50)
 * @returns First N characters or null if not cached
 */
export async function getCachedPromptPrefix(chars = 50): Promise<string | null> {
	try {
		const content = await readFile(CACHE_FILE, "utf-8");
		return content.substring(0, chars);
	} catch {
		return null;
	}
}
