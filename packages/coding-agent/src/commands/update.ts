/**
 * Check for and install updates.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({
			char: "f",
			description: "Unsupported for fork app updates; re-run scripts/install-bwoah.sh",
			default: false,
		}),
		check: Flags.boolean({
			char: "c",
			description: "Unsupported for fork app updates; re-run scripts/install-bwoah.sh",
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({
			description: "Unsupported for fork app updates; re-run scripts/install-bwoah.sh",
			default: false,
		}),
		stable: Flags.boolean({
			description: "Unsupported for fork app updates; re-run scripts/install-bwoah.sh",
			default: false,
		}),
	};

	static examples = [
		"omp update --plugins",
		"# Bwoah My Pi app updates: re-run scripts/install-bwoah.sh from btimothy-har/bwoah-my-pi\n  # (or update a source checkout and run bun setup); force/check/channel flags refuse to run",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({
				force: flags.force,
				check: flags.check,
				channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
			});
		}
	}
}
