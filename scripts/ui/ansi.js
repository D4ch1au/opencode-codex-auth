#!/usr/bin/env node

export const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	bgRed: "\x1b[41m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
};

export const CURSOR = {
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	up: (n = 1) => `\x1b[${n}A`,
	down: (n = 1) => `\x1b[${n}B`,
	clearLine: "\x1b[2K",
	clearScreen: "\x1b[2J\x1b[H",
	moveTo: (row, col) => `\x1b[${row};${col}H`,
	moveToColumn: (col) => `\x1b[${col}G`,
};

export function parseKey(data) {
	if (!Buffer.isBuffer(data)) {
		data = Buffer.from(data);
	}

	if (data.length === 0) return null;

	if (data[0] === 0x03) {
		process.exit(0);
	}

	if (data.length >= 3 && data[0] === 0x1b && data[1] === 0x5b) {
		switch (data[2]) {
			case 0x41:
				return "up";
			case 0x42:
				return "down";
			case 0x43:
				return "right";
			case 0x44:
				return "left";
		}
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

export function isTTY() {
	return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

export function colorize(text, ...styles) {
	const prefix = styles.join("");
	return `${prefix}${text}${COLORS.reset}`;
}
