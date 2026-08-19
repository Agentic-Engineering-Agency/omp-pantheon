export interface SkillCatalogEntry {
	name: string;
	description: string;
	line: string;
}

export interface ParsedSkillCatalog {
	entries: readonly SkillCatalogEntry[];
	render(selectedNames: ReadonlySet<string>): string[];
}

const ENTRY_PATTERN = /^- ([^:\n]+): (.+)$/;

export function parseSkillCatalog(
	systemPrompt: readonly string[],
): ParsedSkillCatalog | undefined {
	const firstSegment = systemPrompt[0];
	if (firstSegment === undefined) return undefined;

	const lines = firstSegment.split("\n");
	const openingMarkers: number[] = [];
	const closingMarkers: number[] = [];

	for (const [index, line] of lines.entries()) {
		if (line === "<skills>") openingMarkers.push(index);
		if (line === "</skills>") closingMarkers.push(index);
	}

	if (openingMarkers.length !== 1 || closingMarkers.length !== 1)
		return undefined;

	const openingIndex = openingMarkers[0];
	const closingIndex = closingMarkers[0];
	if (
		openingIndex === undefined ||
		closingIndex === undefined ||
		closingIndex <= openingIndex + 1
	) {
		return undefined;
	}

	const entries: SkillCatalogEntry[] = [];
	const names = new Set<string>();
	for (const line of lines.slice(openingIndex + 1, closingIndex)) {
		const match = ENTRY_PATTERN.exec(line);
		if (!match) return undefined;

		const name = match[1];
		const description = match[2];
		if (!name || !description || names.has(name)) return undefined;

		names.add(name);
		entries.push({ name, description, line });
	}

	if (entries.length === 0) return undefined;

	return {
		entries,
		render(selectedNames) {
			const selectedLines = entries
				.filter((entry) => selectedNames.has(entry.name))
				.map((entry) => entry.line);
			const rendered = [
				...lines.slice(0, openingIndex + 1),
				...selectedLines,
				...lines.slice(closingIndex),
			].join("\n");
			const result = [...systemPrompt];
			result[0] = rendered;
			return result;
		},
	};
}
