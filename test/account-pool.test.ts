import { describe, expect, it } from "vitest";
import {
	createAccountRecordFromAuth,
	createDefaultAccountPoolState,
	limitAttemptCount,
	markAccountFailure,
	markAccountSuccess,
	selectAccountForRequest,
	updateAccountRateLimits,
	upsertAccountRecord,
} from "../lib/account-pool.js";
import type { Auth, RuntimeAccountConfig } from "../lib/types.js";

function createOAuthAuth(accountId: string, expires: number, tokenMarker = "token"): Auth {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
				marker: tokenMarker,
			},
		}),
	).toString("base64");

	return {
		type: "oauth",
		access: `header.${payload}.signature`,
		refresh: `refresh-${accountId}-${tokenMarker}`,
		expires,
	};
}

describe("account-pool", () => {
	describe("createAccountRecordFromAuth", () => {
		it("creates a record when JWT contains chatgpt account id", () => {
			const record = createAccountRecordFromAuth(createOAuthAuth("acct-a", 1000), 100);
			expect(record?.accountId).toBe("acct-a");
			expect(record?.refresh).toBe("refresh-acct-a-token");
			expect(record?.expires).toBe(1000);
		});

		it("returns null when JWT does not contain account id", () => {
			const auth: Auth = {
				type: "oauth",
				access: "header.payload.signature",
				refresh: "refresh-token",
				expires: 123,
			};

			expect(createAccountRecordFromAuth(auth)).toBeNull();
		});
	});

	describe("upsertAccountRecord", () => {
		it("adds new account records", () => {
			const pool = createDefaultAccountPoolState();
			const created = createAccountRecordFromAuth(createOAuthAuth("acct-a", 1000), 100);
			expect(created).not.toBeNull();

			const result = upsertAccountRecord(pool, created!);
			expect(result.changed).toBe(true);
			expect(pool.accounts).toHaveLength(1);
			expect(pool.accounts[0].accountId).toBe("acct-a");
		});

		it("does not overwrite newer token with stale token for same account", () => {
			const pool = createDefaultAccountPoolState();
			const newer = createAccountRecordFromAuth(
				createOAuthAuth("acct-a", 2000, "new"),
				200,
			);
			const stale = createAccountRecordFromAuth(
				createOAuthAuth("acct-a", 1000, "old"),
				300,
			);
			expect(newer).not.toBeNull();
			expect(stale).not.toBeNull();

			upsertAccountRecord(pool, newer!);
			const result = upsertAccountRecord(pool, stale!);

			expect(result.changed).toBe(false);
			expect(pool.accounts[0].expires).toBe(2000);
		});
	});

	describe("updateAccountRateLimits", () => {
		it("stores primary/secondary remaining percentages for an account", () => {
			const pool = createDefaultAccountPoolState();
			const created = createAccountRecordFromAuth(createOAuthAuth("acct-a", 1000), 100);
			expect(created).not.toBeNull();
			upsertAccountRecord(pool, created!);

			const updated = updateAccountRateLimits(
				pool,
				"acct-a",
				{
					primary: {
						usedPercent: 42.5,
						remainingPercent: 57.5,
						windowMinutes: 300,
						resetsAt: 1_742_000_000_000,
					},
					secondary: {
						usedPercent: 10,
						remainingPercent: 90,
						windowMinutes: 10080,
						resetsAt: 1_743_000_000_000,
					},
					limitName: "codex",
					updatedAt: 200,
				},
				250,
			);

			expect(updated).not.toBeNull();
			expect(pool.accounts[0].rateLimits?.primary?.remainingPercent).toBe(57.5);
			expect(pool.accounts[0].rateLimits?.secondary?.remainingPercent).toBe(90);
			expect(pool.accounts[0].rateLimits?.limitName).toBe("codex");
		});
	});

	describe("selectAccountForRequest", () => {
		it("round-robin rotates eligible accounts", () => {
			const pool = createDefaultAccountPoolState();
			const first = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			const second = createAccountRecordFromAuth(createOAuthAuth("acct-b", 2000), 100);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();

			upsertAccountRecord(pool, first!);
			upsertAccountRecord(pool, second!);

			const a1 = selectAccountForRequest(pool, "round_robin", 100);
			const a2 = selectAccountForRequest(pool, "round_robin", 100);
			expect(a1?.accountId).toBe("acct-a");
			expect(a2?.accountId).toBe("acct-b");
		});

		it("sticky strategy prefers last successful account when eligible", () => {
			const pool = createDefaultAccountPoolState();
			const first = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			const second = createAccountRecordFromAuth(createOAuthAuth("acct-b", 2000), 100);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();

			upsertAccountRecord(pool, first!);
			upsertAccountRecord(pool, second!);
			markAccountSuccess(pool, "acct-b", 150);

			const selected = selectAccountForRequest(pool, "sticky", 200);
			expect(selected?.accountId).toBe("acct-b");
		});

		it("skips accounts in cooldown window", () => {
			const pool = createDefaultAccountPoolState();
			const first = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			const second = createAccountRecordFromAuth(createOAuthAuth("acct-b", 2000), 100);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();

			upsertAccountRecord(pool, first!);
			upsertAccountRecord(pool, second!);
			markAccountFailure(pool, "acct-a", 60, 100);

			const selected = selectAccountForRequest(pool, "round_robin", 120);
			expect(selected?.accountId).toBe("acct-b");
		});
	});

	describe("limitAttemptCount", () => {
		it("caps attempts by enabled account count", () => {
			const pool = createDefaultAccountPoolState();
			const first = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			const second = createAccountRecordFromAuth(createOAuthAuth("acct-b", 2000), 100);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();

			upsertAccountRecord(pool, first!);
			upsertAccountRecord(pool, second!);

			const runtime: RuntimeAccountConfig = {
				strategy: "round_robin",
				rateLimitCooldownSeconds: 300,
				authFailureCooldownSeconds: 90,
				maxAccountsPerRequest: 5,
			};

			expect(limitAttemptCount(pool, runtime)).toBe(2);
		});
	});

	describe("markAccountFailure with progressive backoff", () => {
		it("first failure uses base cooldown (1x multiplier)", () => {
			const pool = createDefaultAccountPoolState();
			const record = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			expect(record).not.toBeNull();
			upsertAccountRecord(pool, record!);

			markAccountFailure(pool, "acct-a", 100, 1000);

			const account = pool.accounts[0];
			// level 0 → multiplier 2^0 = 1 → cooldown = 100 * 1 = 100s
			expect(account.cooldownUntil).toBe(1000 + 100 * 1000);
			expect(account.backoffLevel).toBe(1);
		});

		it("second failure doubles cooldown (2x multiplier)", () => {
			const pool = createDefaultAccountPoolState();
			const record = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			expect(record).not.toBeNull();
			upsertAccountRecord(pool, record!);

			markAccountFailure(pool, "acct-a", 100, 1000);
			// After first: backoffLevel = 1
			markAccountFailure(pool, "acct-a", 100, 200_000);

			const account = pool.accounts[0];
			// level 1 → multiplier 2^1 = 2 → cooldown = 100 * 2 = 200s
			expect(account.cooldownUntil).toBe(200_000 + 200 * 1000);
			expect(account.backoffLevel).toBe(2);
		});

		it("third failure caps at 4x multiplier", () => {
			const pool = createDefaultAccountPoolState();
			const record = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			expect(record).not.toBeNull();
			upsertAccountRecord(pool, record!);

			markAccountFailure(pool, "acct-a", 100, 1000);
			markAccountFailure(pool, "acct-a", 100, 200_000);
			// After second: backoffLevel = 2
			markAccountFailure(pool, "acct-a", 100, 500_000);

			const account = pool.accounts[0];
			// level 2 → multiplier 2^2 = 4 → cooldown = 100 * 4 = 400s
			expect(account.cooldownUntil).toBe(500_000 + 400 * 1000);
			// backoffLevel stays capped at 2
			expect(account.backoffLevel).toBe(2);
		});
	});

	describe("markAccountSuccess resets backoff", () => {
		it("resets backoffLevel to 0 on success", () => {
			const pool = createDefaultAccountPoolState();
			const record = createAccountRecordFromAuth(createOAuthAuth("acct-a", 2000), 100);
			expect(record).not.toBeNull();
			upsertAccountRecord(pool, record!);

			markAccountFailure(pool, "acct-a", 100, 1000);
			markAccountFailure(pool, "acct-a", 100, 200_000);
			expect(pool.accounts[0].backoffLevel).toBe(2);

			markAccountSuccess(pool, "acct-a", 400_000);
			expect(pool.accounts[0].backoffLevel).toBe(0);
			expect(pool.accounts[0].cooldownUntil).toBeUndefined();
		});
	});
});
