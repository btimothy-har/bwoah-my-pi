import { register } from "../../config/registry";

export const cfgExecutionWorkspaceEnabled = register({
	id: "bwoah.executionWorkspace.enabled",
	type: "boolean",
	default: false,
	env: "BWOAH_EXECUTION_WORKSPACE",
});
