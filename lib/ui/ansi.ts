export const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
} as const;

export const CURSOR = {
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	up: (n = 1) => `\x1b[${n}A`,
	clearLine: "\x1b[2K",
} as const;

export type KeyAction =
	| "up"
	| "down"
	| "enter"
	| "escape"
	| "backspace"
	| "q"
	| "y"
	| "n"
	| null;

export function parseKey(data: Buffer): KeyAction {
	if (data.length === 0) return null;

	if (data[0] === 0x03) {
		process.exit(0);
	}

	if (data.length >= 3 && data[0] === 0x1b && data[1] === 0x5b) {
		if (data[2] === 0x41) return "up";
		if (data[2] === 0x42) return "down";
	}

	if (data.length === 1 && data[0] === 0x1b) return "escape";
	if (data[0] === 0x0d || data[0] === 0x0a) return "enter";
	if (data[0] === 0x7f || data[0] === 0x08) return "backspace";

	const ch = data.toString("utf-8");
	if (ch === "q" || ch === "Q") return "q";
	if (ch === "y" || ch === "Y") return "y";
	if (ch === "n" || ch === "N") return "n";

	return null;
}

export function isTTY(): boolean {
	return process.stdout.isTTY === true && process.stdin.isTTY === true;
}
