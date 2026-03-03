#!/usr/bin/env node

import { COLORS, CURSOR, parseKey, isTTY, colorize } from "./ansi.js";

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function getSelectableIndices(items) {
	const indices = [];
	for (let i = 0; i < items.length; i++) {
		if (!items[i].disabled && items[i].type !== "separator") {
			indices.push(i);
		}
	}
	return indices;
}

function renderMenu(items, selectedIndex, options, viewportStart, viewportSize) {
	const { title, subtitle } = options;
	const lines = [];

	if (title) {
		lines.push(`${COLORS.bold}${COLORS.cyan}${title}${COLORS.reset}`);
	}
	if (subtitle) {
		lines.push(`${COLORS.gray}${subtitle}${COLORS.reset}`);
	}
	if (title || subtitle) {
		lines.push("");
	}

	const end = Math.min(viewportStart + viewportSize, items.length);
	const hasScrollUp = viewportStart > 0;
	const hasScrollDown = end < items.length;

	if (hasScrollUp) {
		lines.push(`  ${COLORS.gray}... (${viewportStart} more above)${COLORS.reset}`);
	}

	for (let i = viewportStart; i < end; i++) {
		const item = items[i];

		if (item.type === "separator") {
			const sep = item.label
				? `${COLORS.gray}${"─".repeat(2)} ${item.label} ${"─".repeat(20)}${COLORS.reset}`
				: `${COLORS.gray}${"─".repeat(30)}${COLORS.reset}`;
			lines.push(sep);
			continue;
		}

		const isSelected = i === selectedIndex;
		const marker = isSelected ? `${COLORS.cyan}>` : " ";
		const labelColor = item.disabled
			? COLORS.dim
			: item.danger
				? COLORS.red
				: isSelected
					? COLORS.white + COLORS.bold
					: COLORS.white;

		let line = `${marker} ${labelColor}${item.label}${COLORS.reset}`;

		if (item.badge) {
			line += ` ${item.badge}`;
		}

		if (item.hint) {
			line += ` ${COLORS.gray}${item.hint}${COLORS.reset}`;
		}

		lines.push(line);
	}

	if (hasScrollDown) {
		lines.push(`  ${COLORS.gray}... (${items.length - end} more below)${COLORS.reset}`);
	}

	lines.push("");
	lines.push(`${COLORS.gray}Use arrow keys to navigate, enter to select, q/esc to exit${COLORS.reset}`);

	return lines;
}

export async function select(items, options = {}) {
	if (!isTTY()) {
		console.error("Non-interactive terminal detected. Cannot show menu.");
		return null;
	}

	if (items.length === 0) return null;

	const selectableIndices = getSelectableIndices(items);
	if (selectableIndices.length === 0) return null;

	let selectedIndex = selectableIndices[0];
	const maxViewportSize = Math.max(5, (process.stdout.rows || 24) - 8);
	let viewportStart = 0;
	let lastRenderedLineCount = 0;

	function adjustViewport() {
		const viewportSize = Math.min(maxViewportSize, items.length);
		if (selectedIndex < viewportStart) {
			viewportStart = selectedIndex;
		} else if (selectedIndex >= viewportStart + viewportSize) {
			viewportStart = selectedIndex - viewportSize + 1;
		}
		viewportStart = clamp(viewportStart, 0, Math.max(0, items.length - viewportSize));
		return viewportSize;
	}

	function draw() {
		const viewportSize = adjustViewport();
		const lines = renderMenu(items, selectedIndex, options, viewportStart, viewportSize);

		let output = "";
		if (lastRenderedLineCount > 0) {
			output += CURSOR.up(lastRenderedLineCount);
		}
		for (const line of lines) {
			output += `${CURSOR.clearLine}\r${line}\n`;
		}
		for (let i = lines.length; i < lastRenderedLineCount; i++) {
			output += `${CURSOR.clearLine}\n`;
		}
		if (lastRenderedLineCount > lines.length) {
			output += CURSOR.up(lastRenderedLineCount - lines.length);
		}

		process.stdout.write(output);
		lastRenderedLineCount = lines.length;
	}

	function moveTo(direction) {
		const currentPos = selectableIndices.indexOf(selectedIndex);
		if (currentPos === -1) return;

		let nextPos;
		if (direction === "up") {
			nextPos = currentPos > 0 ? currentPos - 1 : selectableIndices.length - 1;
		} else {
			nextPos = currentPos < selectableIndices.length - 1 ? currentPos + 1 : 0;
		}
		selectedIndex = selectableIndices[nextPos];
	}

	return new Promise((resolve) => {
		const { stdin } = process;
		const wasRaw = stdin.isRaw;

		stdin.setRawMode(true);
		stdin.resume();

		process.stdout.write(CURSOR.hide);
		draw();

		function cleanup(value) {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw ?? false);
			stdin.pause();
			process.stdout.write(CURSOR.show);
			resolve(value);
		}

		function onData(data) {
			const key = parseKey(data);
			if (!key) return;

			switch (key) {
				case "up":
					moveTo("up");
					draw();
					break;
				case "down":
					moveTo("down");
					draw();
					break;
				case "enter": {
					const item = items[selectedIndex];
					if (item && !item.disabled) {
						cleanup(item.value);
					}
					break;
				}
				case "escape":
				case "q":
					cleanup(null);
					break;
			}
		}

		stdin.on("data", onData);
	});
}
