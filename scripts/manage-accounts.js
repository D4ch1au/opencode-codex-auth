#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { select } from "./ui/select.js";
import { confirm } from "./ui/confirm.js";
import { COLORS, isTTY } from "./ui/ansi.js";

const POOL_PATH = join(homedir(), ".opencode", "codex-auth-accounts.json");

function loadPool() {
	if (!existsSync(POOL_PATH)) {
		return { version: 1, accounts: [], roundRobinCursor: 0 };
	}
	try {
		return JSON.parse(readFileSync(POOL_PATH, "utf-8"));
	} catch {
		return { version: 1, accounts: [], roundRobinCursor: 0 };
	}
}

function savePool(pool) {
	const dir = join(homedir(), ".opencode");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`, "utf-8");
}

function getAccountStatus(account) {
	const now = Date.now();
	if (account.disabled) return "disabled";
	if (typeof account.cooldownUntil === "number" && account.cooldownUntil > now) return "cooldown";
	if (account.expires <= now) return "expired";
	return "active";
}

function formatStatusBadge(status, account) {
	switch (status) {
		case "active":
			return `${COLORS.green}[active]${COLORS.reset}`;
		case "disabled":
			return `${COLORS.red}[disabled]${COLORS.reset}`;
		case "expired":
			return `${COLORS.red}[expired]${COLORS.reset}`;
		case "cooldown": {
			const remaining = formatCountdown(account.cooldownUntil);
			return `${COLORS.yellow}[cooldown ${remaining}]${COLORS.reset}`;
		}
		default:
			return `${COLORS.gray}[unknown]${COLORS.reset}`;
	}
}

function truncateId(accountId) {
	if (!accountId || accountId.length <= 12) return accountId || "???";
	return `${accountId.slice(0, 4)}...${accountId.slice(-4)}`;
}

function formatRelativeTime(timestamp) {
	if (timestamp === undefined || timestamp === null) return "never";

	const now = Date.now();
	const diff = now - timestamp;

	if (diff < 0) return "in the future";
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return `${Math.floor(diff / 2_592_000_000)}mo ago`;
}

function formatDate(timestamp) {
	if (timestamp === undefined || timestamp === null) return "N/A";
	return new Date(timestamp).toLocaleString();
}

function formatCountdown(until) {
	if (until === undefined || until === null) return "N/A";

	const now = Date.now();
	const remaining = until - now;
	if (remaining <= 0) return "expired";

	const seconds = Math.floor(remaining / 1000);
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;

	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildSummary(accounts) {
	const total = accounts.length;
	if (total === 0) return "No accounts configured";

	let active = 0;
	let disabled = 0;
	let cooldown = 0;
	let expired = 0;

	for (const account of accounts) {
		const status = getAccountStatus(account);
		switch (status) {
			case "active": active++; break;
			case "disabled": disabled++; break;
			case "cooldown": cooldown++; break;
			case "expired": expired++; break;
		}
	}

	const parts = [`${total} account${total !== 1 ? "s" : ""}`];
	if (active > 0) parts.push(`${COLORS.green}${active} active${COLORS.reset}`);
	if (cooldown > 0) parts.push(`${COLORS.yellow}${cooldown} cooldown${COLORS.reset}`);
	if (disabled > 0) parts.push(`${COLORS.red}${disabled} disabled${COLORS.reset}`);
	if (expired > 0) parts.push(`${COLORS.red}${expired} expired${COLORS.reset}`);

	return parts.join(", ");
}

async function showAccountDetail(pool, accountIndex) {
	const account = pool.accounts[accountIndex];
	if (!account) return;

	const status = getAccountStatus(account);

	while (true) {
		const detailLines = [
			`${COLORS.gray}Account ID:     ${COLORS.reset}${account.accountId}`,
			`${COLORS.gray}Status:         ${COLORS.reset}${formatStatusBadge(status, account)}`,
			`${COLORS.gray}Added:          ${COLORS.reset}${formatDate(account.addedAt)}`,
			`${COLORS.gray}Last Used:      ${COLORS.reset}${account.lastUsedAt ? formatDate(account.lastUsedAt) : "Never"}`,
			`${COLORS.gray}Last Failure:   ${COLORS.reset}${account.lastFailureAt ? formatDate(account.lastFailureAt) : "None"}`,
			`${COLORS.gray}Failure Count:  ${COLORS.reset}${account.failureCount ?? 0}`,
			`${COLORS.gray}Cooldown Until: ${COLORS.reset}${account.cooldownUntil ? `${formatDate(account.cooldownUntil)} (${formatCountdown(account.cooldownUntil)})` : "None"}`,
			`${COLORS.gray}Token Expires:  ${COLORS.reset}${formatDate(account.expires)}`,
		];

		console.log("");
		for (const line of detailLines) {
			console.log(`  ${line}`);
		}
		console.log("");

		const isDisabled = account.disabled === true;
		const items = [
			{ label: "Back", value: "back" },
			{ type: "separator" },
			{
				label: isDisabled ? "Enable Account" : "Disable Account",
				value: "toggle",
				badge: isDisabled
					? `${COLORS.green}(currently disabled)${COLORS.reset}`
					: `${COLORS.yellow}(currently enabled)${COLORS.reset}`,
			},
			{
				label: "Clear Cooldown",
				value: "clear-cooldown",
				disabled: status !== "cooldown",
				hint: status === "cooldown" ? formatCountdown(account.cooldownUntil) : "",
			},
			{ type: "separator", label: "Danger" },
			{ label: "Delete Account", value: "delete", danger: true },
		];

		const action = await select(items, {
			title: `Account ${truncateId(account.accountId)}`,
		});

		if (action === null || action === "back") return;

		switch (action) {
			case "toggle": {
				account.disabled = !account.disabled;
				if (!account.disabled) {
					account.cooldownUntil = undefined;
					account.failureCount = 0;
					account.lastFailureAt = undefined;
				}
				account.updatedAt = Date.now();
				savePool(pool);
				const state = account.disabled ? "disabled" : "enabled";
				console.log(`\n${COLORS.green}Account ${truncateId(account.accountId)} ${state}.${COLORS.reset}\n`);
				return;
			}
			case "clear-cooldown": {
				account.cooldownUntil = undefined;
				account.failureCount = 0;
				account.lastFailureAt = undefined;
				account.updatedAt = Date.now();
				savePool(pool);
				console.log(`\n${COLORS.green}Cooldown cleared for ${truncateId(account.accountId)}.${COLORS.reset}\n`);
				return;
			}
			case "delete": {
				const yes = await confirm(
					`Delete account ${truncateId(account.accountId)}? This cannot be undone.`,
					false,
				);
				if (yes) {
					pool.accounts.splice(accountIndex, 1);
					if (pool.roundRobinCursor >= pool.accounts.length) {
						pool.roundRobinCursor = 0;
					}
					if (pool.stickyAccountId === account.accountId) {
						pool.stickyAccountId = undefined;
					}
					savePool(pool);
					console.log(`\n${COLORS.green}Account deleted.${COLORS.reset}\n`);
				}
				return;
			}
		}
	}
}

async function showMainMenu() {
	while (true) {
		const pool = loadPool();
		const { accounts } = pool;

		const items = [];

		if (accounts.length > 0) {
			items.push({ type: "separator", label: "Accounts" });

			for (let i = 0; i < accounts.length; i++) {
				const account = accounts[i];
				const status = getAccountStatus(account);
				items.push({
					label: `Account #${i + 1}: ${truncateId(account.accountId)}`,
					value: { type: "select-account", index: i },
					badge: formatStatusBadge(status, account),
					hint: `last used: ${formatRelativeTime(account.lastUsedAt)}`,
				});
			}
		}

		items.push({ type: "separator", label: "Actions" });
		items.push({
			label: "Refresh",
			value: { type: "refresh" },
			hint: "reload accounts from disk",
		});

		if (accounts.length > 0) {
			items.push({ type: "separator", label: "Danger" });
			items.push({
				label: "Delete All Accounts",
				value: { type: "delete-all" },
				danger: true,
			});
		}

		items.push({ type: "separator" });
		items.push({ label: "Exit", value: { type: "exit" } });

		const action = await select(items, {
			title: "opencode-codex-auth Account Manager",
			subtitle: buildSummary(accounts),
		});

		if (action === null || action.type === "exit") {
			return;
		}

		switch (action.type) {
			case "select-account": {
				const freshPool = loadPool();
				await showAccountDetail(freshPool, action.index);
				break;
			}
			case "refresh": {
				console.log(`\n${COLORS.green}Accounts reloaded.${COLORS.reset}\n`);
				break;
			}
			case "delete-all": {
				const yes = await confirm(
					`Delete ALL ${accounts.length} account${accounts.length !== 1 ? "s" : ""}? This cannot be undone.`,
					false,
				);
				if (yes) {
					const freshPool = loadPool();
					freshPool.accounts = [];
					freshPool.roundRobinCursor = 0;
					freshPool.stickyAccountId = undefined;
					savePool(freshPool);
					console.log(`\n${COLORS.green}All accounts deleted.${COLORS.reset}\n`);
				}
				break;
			}
		}
	}
}

export async function manageAccounts() {
	if (!isTTY()) {
		console.error("This command requires an interactive terminal.");
		process.exit(1);
	}

	console.log("");
	await showMainMenu();
	console.log(`${COLORS.gray}Goodbye.${COLORS.reset}`);
}

const scriptPath = process.argv[1];
if (scriptPath) {
	const normalizedScript = scriptPath.replace(/\\/g, "/");
	const normalizedMeta = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
	if (normalizedMeta.endsWith(normalizedScript) || normalizedScript.endsWith("manage-accounts.js")) {
		manageAccounts().catch((error) => {
			console.error(`Account manager failed: ${error instanceof Error ? error.message : error}`);
			process.exit(1);
		});
	}
}
