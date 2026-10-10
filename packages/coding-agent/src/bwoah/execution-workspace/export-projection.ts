import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { BlobStore } from "../../session/blob-store";
import { sanitizeRehydratedOpenAIResponsesAssistantMessage } from "../../session/messages";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";
import { loadSessionFile, normalizeAssistantUsage, resolveBlobRefsInEntries } from "../../session/session-loader";
import { migrateToCurrentVersion } from "../../session/session-migrations";

export interface ExportSessionProjection {
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
}

export async function loadExportSession(inputPath: string): Promise<ExportSessionProjection> {
	const resolvedPath = path.resolve(inputPath);
	const loaded = await loadSessionFile(resolvedPath, undefined, { throwIfMissing: true });
	if (loaded.invalidHeader) {
		throw new Error(
			`Cannot resume session "${resolvedPath}": the session header is missing or malformed. The file was not modified.`,
		);
	}
	if (loaded.entries.length === 0) {
		throw new Error(
			`Cannot resume session "${resolvedPath}": the session file holds no entries. The file was not modified.`,
		);
	}

	const fileEntries = loaded.entries;
	migrateToCurrentVersion(fileEntries);
	await resolveBlobRefsInEntries(fileEntries, new BlobStore(getBlobsDir()));

	const header = fileEntries[0] as SessionHeader;
	const entries = fileEntries.slice(1) as SessionEntry[];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		normalizeAssistantUsage(entry.message);
		entry.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
	}

	return { header, entries, leafId: entries.at(-1)?.id ?? null };
}

export function sessionHeaderForExport(header: SessionHeader | null): SessionHeader | null {
	if (!header) return null;
	const exported = { ...header } as SessionHeader & { executionCwd?: unknown };
	delete exported.previousSessionFiles;
	delete exported.executionCwd;
	return exported;
}

export async function assertExportOutputIsSeparate(
	sessionFile: string,
	outputPath: string,
	subSessionKeys?: readonly string[],
): Promise<void> {
	const protectedPaths = [
		path.resolve(sessionFile),
		...(subSessionKeys ?? []).map(key => path.resolve(path.join(sessionFile.slice(0, -6), `${key}.jsonl`))),
	].map(filePath => ({ filePath, normalizedPath: normalizePathForComparison(filePath) }));
	const resolvedOutputPath = path.resolve(outputPath);
	const normalizedOutputPath = normalizePathForComparison(resolvedOutputPath);

	let outputStat: BigIntStats | undefined;
	try {
		outputStat = await fs.stat(resolvedOutputPath, { bigint: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const sourceStats = await Promise.all(protectedPaths.map(({ filePath }) => fs.stat(filePath, { bigint: true })));
	const outputMatchesSource = protectedPaths.some(({ normalizedPath }, index) => {
		if (normalizedPath === normalizedOutputPath) return true;
		const sourceStat = sourceStats[index];
		return outputStat !== undefined && sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino;
	});
	if (outputMatchesSource) {
		throw new Error(`Cannot export HTML over a source session file: ${outputPath}`);
	}
}
