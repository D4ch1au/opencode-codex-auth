import { COLORS, CURSOR, parseKey, isTTY } from "./ansi.js";

export interface MenuItem<T> {
	label: string;
	value: T;
	hint?: string;
	badge?: string;
	disabled?: boolean;
	danger?: boolean;
	type?: "item" | "separator";
}

export interface SelectOptions {
	title?: string;
	subtitle?: string;
}

function getSelectableIndices<T>(items: MenuItem<T>[]): number[] {
	const indices: number[] = [];
	for (let i = 0; i < items.length; i++) {
		if (!items[i].disabled && items[i].type !== "separator") {
			indices.push(i);
		}
	}
	return indices;
}

function renderMenu<T>(
	items: MenuItem<T>[],
	selectedIndex: number,
	options: SelectOptions,
	viewportStart: number,
	viewportSize: number,
): string[] {
	const lines: string[] = [];

	if (options.title) {
		lines.push(`${COLORS.bold}${COLORS.cyan}${options.title}${COLORS.reset}`);
	}
	if (options.subtitle) {
		lines.push(`${COLORS.gray}${options.subtitle}${COLORS.reset}`);
	}
	if (options.title || options.subtitle) {
		lines.push("");
	}

	const end = Math.min(viewportStart + viewportSize, items.length);

	if (viewportStart > 0) {
		lines.push(`  ${COLORS.gray}... (${viewportStart} more above)${COLORS.reset}`);
	}

	for (let i = viewportStart; i < end; i++) {
		const item = items[i];

		if (item.type === "separator") {
			const sep = item.label
				? `${COLORS.gray}── ${item.label} ──────────────────────${COLORS.reset}`
				: `${COLORS.gray}──────────────────────────────${COLORS.reset}`;
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

	if (end < items.length) {
		lines.push(`  ${COLORS.gray}... (${items.length - end} more below)${COLORS.reset}`);
	}

	lines.push("");
	lines.push(`${COLORS.gray}Use arrow keys to navigate, enter to select, q/esc to exit${COLORS.reset}`);

	return lines;
}

export async function select<T>(items: MenuItem<T>[], options: SelectOptions = {}): Promise<T | null> {
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

	function adjustViewport(): number {
		const viewportSize = Math.min(maxViewportSize, items.length);
		if (selectedIndex < viewportStart) {
			viewportStart = selectedIndex;
		} else if (selectedIndex >= viewportStart + viewportSize) {
			viewportStart = selectedIndex - viewportSize + 1;
		}
		viewportStart = Math.max(0, Math.min(viewportStart, items.length - viewportSize));
		return viewportSize;
	}

	function draw(): void {
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

	function moveTo(direction: "up" | "down"): void {
		const currentPos = selectableIndices.indexOf(selectedIndex);
		if (currentPos === -1) return;

		let nextPos: number;
		if (direction === "up") {
			nextPos = currentPos > 0 ? currentPos - 1 : selectableIndices.length - 1;
		} else {
			nextPos = currentPos < selectableIndices.length - 1 ? currentPos + 1 : 0;
		}
		selectedIndex = selectableIndices[nextPos];
	}

	return new Promise<T | null>((resolve) => {
		const { stdin } = process;
		const wasRaw = stdin.isRaw;

		stdin.setRawMode(true);
		stdin.resume();
		process.stdout.write(CURSOR.hide);
		draw();

		function cleanup(value: T | null): void {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw ?? false);
			stdin.pause();
			process.stdout.write(CURSOR.show);
			resolve(value);
		}

		function onData(data: Buffer): void {
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
