import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { SessionManager } from "../../src/session/session-manager";
import { shareSession, shareSessionData, type ShareSessionResult } from "../../src/export/share";
import { type SessionData } from "../../src/export/html";

interface ShareFixtureManifest {
	data?: SessionData;
	sessionPath?: string;
	secret?: string;
}

const [mode, manifestPath, ...extraArgs] = process.argv.slice(2);
if ((mode !== "data" && mode !== "live") || !manifestPath || extraArgs.length > 0) {
	throw new Error("Usage: share-publication-fixture.ts <data|live> <absolute-manifest-path>");
}
if (!path.isAbsolute(manifestPath)) throw new Error("The share fixture manifest path must be absolute");

const serverUrl = process.env.OMP_TEST_SHARE_ORIGIN;
if (!serverUrl) throw new Error("OMP_TEST_SHARE_ORIGIN is required");

const manifest = (await Bun.file(manifestPath).json()) as ShareFixtureManifest;
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
	throw new Error("The share fixture manifest must be a JSON object");
}
if (manifest.secret !== undefined && typeof manifest.secret !== "string") {
	throw new Error("The share fixture secret must be a string");
}

const obfuscator =
	manifest.secret === undefined ? undefined : new SecretObfuscator([{ type: "plain", content: manifest.secret }]);
const options = {
	serverUrl,
	store: "blob" as const,
	...(obfuscator ? { obfuscator } : {}),
};

let result: ShareSessionResult;
let unchanged: boolean;
if (mode === "data") {
	if (!manifest.data || typeof manifest.data !== "object" || Array.isArray(manifest.data)) {
		throw new Error("The data-mode manifest must contain a SessionData object");
	}
	const data = manifest.data;
	const before = JSON.stringify(structuredClone(data));
	result = await shareSessionData(data, options);
	unchanged = before === JSON.stringify(data);
} else {
	if (typeof manifest.sessionPath !== "string") throw new Error("The live-mode manifest must contain sessionPath");
	const sessionPath = manifest.sessionPath;
	const manager = await SessionManager.open(sessionPath, undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	const before = await snapshotLiveSource(manager, sessionPath);
	result = await shareSession(manager, options);
	unchanged = before === (await snapshotLiveSource(manager, sessionPath));
}

process.stdout.write(`${JSON.stringify({ result, unchanged })}\n`);

async function snapshotLiveSource(manager: SessionManager, sessionPath: string): Promise<string> {
	const [bytes, stat] = await Promise.all([
		Bun.file(sessionPath).arrayBuffer(),
		fs.stat(sessionPath, { bigint: true }),
	]);
	return JSON.stringify(
		structuredClone({
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leafId: manager.getLeafId(),
			file: {
				bytes: Buffer.from(bytes).toString("base64"),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
			},
		}),
	);
}
