export interface SkillCatalogEntry {
	name: string;
	description: string;
	line: string;
}

export interface ParsedSkillCatalog {
	entries: readonly SkillCatalogEntry[];
	render(selectedNames: ReadonlySet<string>): string[];
}

const LIST_ENTRY_PATTERN = /^- ([^:\n]+): (.+)$/;
const XML_ENTRY_OPEN_PATTERN = /^<skill name="([^"\n]+)">(.*)$/;
const XML_ENTRY_CLOSE = "</skill>";

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

	const interiorLines = lines.slice(openingIndex + 1, closingIndex);
	const entries =
		parseListEntries(interiorLines) ?? parseXmlEntries(interiorLines);
	if (entries === undefined) return undefined;

	if (entries.length === 0) return undefined;
	return {
		entries,
		render(selectedNames) {
			const selectedBlocks = entries
				.filter((entry) => selectedNames.has(entry.name))
				.map((entry) => entry.line);
			const rendered = [
				...lines.slice(0, openingIndex + 1),
				...selectedBlocks,
				...lines.slice(closingIndex),
			].join("\n");
			const result = [...systemPrompt];
			result[0] = rendered;
			return result;
		},
	};
}

function parseListEntries(
	lines: readonly string[],
): SkillCatalogEntry[] | undefined {
	const entries: SkillCatalogEntry[] = [];
	const names = new Set<string>();

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (
			line === undefined ||
			line.includes("<skill") ||
			line.includes("</skill>")
		) {
			return undefined;
		}

		const match = LIST_ENTRY_PATTERN.exec(line);
		if (!match) return undefined;

		const name = match[1];
		const firstDescriptionLine = match[2];
		if (
			name === undefined ||
			firstDescriptionLine === undefined ||
			name === "" ||
			firstDescriptionLine === "" ||
			names.has(name)
		) {
			return undefined;
		}

		const blockLines = [line];
		const descriptionLines = [firstDescriptionLine];
		while (index + 1 < lines.length) {
			const nextLine = lines[index + 1];
			if (nextLine === undefined || nextLine.startsWith("- ")) break;
			if (nextLine.includes("<skill") || nextLine.includes("</skill>")) {
				return undefined;
			}

			blockLines.push(nextLine);
			descriptionLines.push(nextLine);
			index++;
		}

		while (descriptionLines.at(-1) === "") descriptionLines.pop();
		const description = descriptionLines.join("\n");
		if (description.length === 0) return undefined;

		names.add(name);
		entries.push({ name, description, line: blockLines.join("\n") });
	}

	return entries;
}

function parseXmlEntries(
	lines: readonly string[],
): SkillCatalogEntry[] | undefined {
	const entries: SkillCatalogEntry[] = [];
	const names = new Set<string>();

	for (let index = 0; index < lines.length; index++) {
		const openingLine = lines[index];
		if (openingLine === undefined) return undefined;

		const match = XML_ENTRY_OPEN_PATTERN.exec(openingLine);
		if (!match) return undefined;

		const name = match[1];
		const openingDescription = match[2];
		if (
			name === undefined ||
			openingDescription === undefined ||
			name === "" ||
			names.has(name)
		) {
			return undefined;
		}

		const blockLines = [openingLine];
		const descriptionLines: string[] = [];
		const closeInOpening = openingDescription.indexOf(XML_ENTRY_CLOSE);
		if (closeInOpening >= 0) {
			const description = openingDescription.slice(0, closeInOpening);
			const trailing = openingDescription.slice(
				closeInOpening + XML_ENTRY_CLOSE.length,
			);
			if (
				trailing !== "" ||
				description.length === 0 ||
				description.includes("<skill")
			) {
				return undefined;
			}

			names.add(name);
			entries.push({ name, description, line: blockLines.join("\n") });
			continue;
		}

		if (openingDescription.includes("<skill")) return undefined;
		if (openingDescription.length > 0)
			descriptionLines.push(openingDescription);

		let closed = false;
		while (++index < lines.length) {
			const line = lines[index];
			if (line === undefined) return undefined;
			blockLines.push(line);

			const closeIndex = line.indexOf(XML_ENTRY_CLOSE);
			if (closeIndex >= 0) {
				const beforeClose = line.slice(0, closeIndex);
				const afterClose = line.slice(closeIndex + XML_ENTRY_CLOSE.length);
				if (afterClose !== "" || beforeClose.includes("<skill"))
					return undefined;
				if (beforeClose.length > 0) descriptionLines.push(beforeClose);
				closed = true;
				break;
			}

			if (line.includes("<skill")) return undefined;
			descriptionLines.push(line);
		}

		const description = descriptionLines.join("\n");
		if (!closed || description.length === 0) return undefined;

		names.add(name);
		entries.push({ name, description, line: blockLines.join("\n") });
	}

	return entries;
}
