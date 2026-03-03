import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Auth } from "@opencode-ai/sdk";
import { JWT_CLAIM_PATH } from "./constants.js";
import { decodeJWT } from "./auth/auth.js";
import type {
	AccountPoolState,
	AccountSelectionStrategy,
	OAuthAccountRecord,
	RuntimeAccountConfig,
	TokenSuccess,
} from "./types.js";

const ACCOUNT_POOL_FILE_PATH = join(homedir(), ".opencode", "codex-auth-accounts.json");

export function getAccountPoolFilePath(): string {
	return ACCOUNT_POOL_FILE_PATH;
}

export function createDefaultAccountPoolState(): AccountPoolState {
	return {
		version: 1,
		accounts: [],
		roundRobinCursor: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAccountRecord(value: unknown): OAuthAccountRecord | null {
	if (!isRecord(value)) return null;
	if (typeof value.accountId !== "string" || value.accountId.length === 0) return null;
	if (typeof value.access !== "string" || value.access.length === 0) return null;
	if (typeof value.refresh !== "string" || value.refresh.length === 0) return null;
	if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) return null;

	const now = Date.now();
	return {
		accountId: value.accountId,
		access: value.access,
		refresh: value.refresh,
		expires: value.expires,
		addedAt: toFiniteNumber(value.addedAt, now),
		updatedAt: toFiniteNumber(value.updatedAt, now),
		lastUsedAt: typeof value.lastUsedAt === "number" ? value.lastUsedAt : undefined,
		lastFailureAt: typeof value.lastFailureAt === "number" ? value.lastFailureAt : undefined,
		failureCount: typeof value.failureCount === "number" ? value.failureCount : undefined,
		cooldownUntil:
			typeof value.cooldownUntil === "number" ? value.cooldownUntil : undefined,
		disabled: value.disabled === true,
	};
}

export function loadAccountPoolState(): AccountPoolState {
	try {
		if (!existsSync(ACCOUNT_POOL_FILE_PATH)) {
			return createDefaultAccountPoolState();
		}

		const raw = readFileSync(ACCOUNT_POOL_FILE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return createDefaultAccountPoolState();

		const accountEntries = Array.isArray(parsed.accounts) ? parsed.accounts : [];
		const accounts = accountEntries
			.map((entry) => normalizeAccountRecord(entry))
			.filter((entry): entry is OAuthAccountRecord => entry !== null);

		const stickyAccountId =
			typeof parsed.stickyAccountId === "string" && parsed.stickyAccountId.length > 0
				? parsed.stickyAccountId
				: undefined;

		return {
			version: 1,
			accounts,
			roundRobinCursor: toFiniteNumber(parsed.roundRobinCursor, 0),
			stickyAccountId,
		};
	} catch {
		return createDefaultAccountPoolState();
	}
}

export function saveAccountPoolState(pool: AccountPoolState): void {
	const dir = join(homedir(), ".opencode");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(ACCOUNT_POOL_FILE_PATH, `${JSON.stringify(pool, null, 2)}\n`, "utf-8");
}

export function getAccountIdFromAuth(auth: Auth): string | null {
	if (auth.type !== "oauth") return null;
	const decoded = decodeJWT(auth.access);
	const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export function getAccountIdFromAccessToken(accessToken: string): string | null {
	const decoded = decodeJWT(accessToken);
	const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export function createAccountRecordFromAuth(
	auth: Auth,
	now = Date.now(),
): OAuthAccountRecord | null {
	if (auth.type !== "oauth") return null;
	const accountId = getAccountIdFromAuth(auth);
	if (!accountId) return null;

	return {
		accountId,
		access: auth.access,
		refresh: auth.refresh,
		expires: auth.expires,
		addedAt: now,
		updatedAt: now,
	};
}

export function upsertAccountRecord(
	pool: AccountPoolState,
	record: OAuthAccountRecord,
): { changed: boolean; record: OAuthAccountRecord } {
	const index = pool.accounts.findIndex((entry) => entry.accountId === record.accountId);

	if (index === -1) {
		pool.accounts.push(record);
		return { changed: true, record };
	}

	const existing = pool.accounts[index];
	const incomingLooksStale =
		record.access !== existing.access
		&& record.refresh !== existing.refresh
		&& record.expires < existing.expires;

	if (incomingLooksStale) {
		return { changed: false, record: existing };
	}

	const changed =
		existing.access !== record.access
		|| existing.refresh !== record.refresh
		|| existing.expires !== record.expires
		|| existing.disabled === true;

	const merged: OAuthAccountRecord = {
		...existing,
		access: record.access,
		refresh: record.refresh,
		expires: record.expires,
		updatedAt: record.updatedAt,
		disabled: false,
	};

	pool.accounts[index] = merged;
	return { changed, record: merged };
}

export function isAccountEligible(account: OAuthAccountRecord, now = Date.now()): boolean {
	if (account.disabled) return false;
	if (typeof account.cooldownUntil === "number" && account.cooldownUntil > now) return false;
	return true;
}

export function selectAccountForRequest(
	pool: AccountPoolState,
	strategy: AccountSelectionStrategy,
	now = Date.now(),
): OAuthAccountRecord | null {
	if (pool.accounts.length === 0) return null;

	if (strategy === "sticky" && pool.stickyAccountId) {
		const sticky = pool.accounts.find(
			(account) => account.accountId === pool.stickyAccountId && isAccountEligible(account, now),
		);
		if (sticky) {
			return sticky;
		}
	}

	const total = pool.accounts.length;
	const start = ((pool.roundRobinCursor % total) + total) % total;

	for (let offset = 0; offset < total; offset += 1) {
		const index = (start + offset) % total;
		const candidate = pool.accounts[index];
		if (!isAccountEligible(candidate, now)) {
			continue;
		}

		pool.roundRobinCursor = (index + 1) % total;
		return candidate;
	}

	return null;
}

export function markAccountSuccess(
	pool: AccountPoolState,
	accountId: string,
	now = Date.now(),
): void {
	const account = pool.accounts.find((entry) => entry.accountId === accountId);
	if (!account) return;

	account.lastUsedAt = now;
	account.updatedAt = now;
	account.failureCount = 0;
	account.lastFailureAt = undefined;
	account.cooldownUntil = undefined;
	account.disabled = false;
	pool.stickyAccountId = accountId;
}

export function markAccountFailure(
	pool: AccountPoolState,
	accountId: string,
	cooldownSeconds: number,
	now = Date.now(),
): void {
	const account = pool.accounts.find((entry) => entry.accountId === accountId);
	if (!account) return;

	account.lastFailureAt = now;
	account.updatedAt = now;
	account.failureCount = (account.failureCount ?? 0) + 1;
	if (cooldownSeconds > 0) {
		account.cooldownUntil = now + cooldownSeconds * 1000;
	}
}

export function updateAccountTokens(
	pool: AccountPoolState,
	accountId: string,
	tokens: TokenSuccess,
	now = Date.now(),
): OAuthAccountRecord | null {
	const account = pool.accounts.find((entry) => entry.accountId === accountId);
	if (!account) return null;

	account.access = tokens.access;
	account.refresh = tokens.refresh;
	account.expires = tokens.expires;
	account.updatedAt = now;
	account.disabled = false;
	return account;
}

export function shouldRefreshStoredAccount(
	account: OAuthAccountRecord,
	now = Date.now(),
): boolean {
	return !account.access || account.expires <= now;
}

export function limitAttemptCount(
	pool: AccountPoolState,
	runtimeConfig: RuntimeAccountConfig,
): number {
	const enabledCount = pool.accounts.filter((account) => !account.disabled).length;
	if (enabledCount <= 0) return 0;
	return Math.min(enabledCount, Math.max(1, runtimeConfig.maxAccountsPerRequest));
}

export function syncCurrentAuthIntoPool(auth: Auth): {
	pool: AccountPoolState;
	activeAccount: OAuthAccountRecord | null;
	changed: boolean;
} {
	const pool = loadAccountPoolState();
	const record = createAccountRecordFromAuth(auth);
	if (!record) {
		return { pool, activeAccount: null, changed: false };
	}

	const result = upsertAccountRecord(pool, record);
	if (result.changed) {
		saveAccountPoolState(pool);
	}

	return {
		pool,
		activeAccount: result.record,
		changed: result.changed,
	};
}

export function upsertTokenSuccessIntoPool(
	tokens: TokenSuccess,
	now = Date.now(),
): OAuthAccountRecord | null {
	const accountId = getAccountIdFromAccessToken(tokens.access);
	if (!accountId) return null;

	const pool = loadAccountPoolState();
	const record: OAuthAccountRecord = {
		accountId,
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		addedAt: now,
		updatedAt: now,
	};

	const result = upsertAccountRecord(pool, record);
	if (result.changed) {
		saveAccountPoolState(pool);
	}

	return result.record;
}
