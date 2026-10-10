/**
 * Share a saved session as an encrypted link without launching the agent.
 *
 * `omp share <session>` accepts a session id (prefix) or a path to a session
 * `.jsonl` and uploads the sealed snapshot exactly like the `/share` slash
 * command, honoring `share.serverUrl`, `share.store`, and
 * `share.redactSecrets`.
 */

import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { shareHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { shareSessionData } from "../export/share";
import { buildSecretObfuscator } from "../secrets";
import { resolveResumableSession } from "../session/session-listing";
import { resolveSessionHome } from "../bwoah/execution-workspace/session-home";
import { loadExportSession, type ExportSessionProjection } from "../bwoah/execution-workspace/export-projection";

import { cfgSecretsEnabled } from "../secrets/settings";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "./settings";

export default class Share extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({
			description: "Session id (prefix) or path to a session .jsonl",
			required: true,
		}),
	};
	static flags = {
		gist: Flags.boolean({
			description: "Upload to a secret GitHub gist instead of the share server",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Share);

		const launchCwd = process.cwd();
		const sessionArg = args.session ?? "";
		let sessionPath: string | undefined = sessionArg;
		if (!sessionArg.includes("/") && !sessionArg.includes("\\") && !sessionArg.endsWith(".jsonl")) {
			const match = await resolveResumableSession(sessionArg, launchCwd, undefined, { readOnly: true });
			sessionPath = match?.session.path;
		}

		let projection: ExportSessionProjection | undefined;
		if (sessionPath) {
			try {
				projection = await loadExportSession(sessionPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
		if (!projection) {
			process.stderr.write(`Session "${sessionArg}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		// Settings and secrets follow the saved session's home, not the launch project.
		const policyCwd = path.resolve(resolveSessionHome(projection.header, launchCwd));
		const settings = await Settings.loadReadOnly({ cwd: policyCwd });
		const obfuscator =
			cfgShareRedactSecrets.get(settings) && cfgSecretsEnabled.get(settings)
				? await buildSecretObfuscator(policyCwd, getAgentDir())
				: undefined;

		const result = await shareSessionData(projection, {
			serverUrl: cfgShareServerUrl.get(settings),
			store: flags.gist ? "gist" : cfgShareStore.get(settings),
			obfuscator,
		});
		const lines = [`Share URL: ${result.url}`];
		if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
		if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
		console.log(lines.join("\n"));
	}
}
