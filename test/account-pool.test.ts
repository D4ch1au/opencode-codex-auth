import { describe, expect, it } from "vitest";
import {
	createAccountRecordFromAuth,
	createDefaultAccountPoolState,
	limitAttemptCount,
	markAccountFailure,
	markAccountSuccess,
	selectAccountForRequest,
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
});
