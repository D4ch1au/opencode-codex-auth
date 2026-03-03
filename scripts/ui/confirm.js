#!/usr/bin/env node

import { COLORS, CURSOR, parseKey, isTTY } from "./ansi.js";

export async function confirm(message, defaultValue = false) {
	if (!isTTY()) {
		return defaultValue;
	}

	const hint = defaultValue ? "[Y/n]" : "[y/N]";
	process.stdout.write(`${COLORS.yellow}?${COLORS.reset} ${message} ${COLORS.gray}${hint}${COLORS.reset} `);

	return new Promise((resolve) => {
		const { stdin } = process;
		const wasRaw = stdin.isRaw;

		stdin.setRawMode(true);
		stdin.resume();

		function cleanup(value) {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw ?? false);
			stdin.pause();

			const label = value ? "Yes" : "No";
			const color = value ? COLORS.green : COLORS.red;
			process.stdout.write(`${color}${label}${COLORS.reset}\n`);
			resolve(value);
		}

		function onData(data) {
			const key = parseKey(data);
			if (!key) return;

			switch (key) {
				case "y":
					cleanup(true);
					break;
				case "n":
					cleanup(false);
					break;
				case "enter":
					cleanup(defaultValue);
					break;
				case "escape":
				case "q":
					cleanup(false);
					break;
			}
		}

		stdin.on("data", onData);
	});
}
