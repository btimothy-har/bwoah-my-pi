/**
 * Workspace-policy reminder injection.
 *
 * Emits the current execution-workspace policy (primary / linked worktree /
 * native isolation / unverified) as synthetic developer control messages: once
 * per provider request that carries newly arrived user input, and again when
 * the resolved policy text changes or history reconstruction invalidates the
 * remembered context. Unchanged tool continuations and request replays add
 * nothing, and nothing is persisted into the session or the system prompt.
 *
 * Runs AFTER the date/cwd injector in the provider-context chain so workspace
 * controls land at the tail, immediately before the next model response.
 * Identity is tracked by source position plus a content fingerprint: steering
 * wraps and secret obfuscation hand back fresh message objects each request,
 * and timestamps alone collide or move backwards, so neither is a key.
 */
import type { Context, DeveloperMessage, Message } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isEstimateCacheable, messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import { fingerprintMessage } from "../advisor/message-fingerprint";

/** Workspace-policy reminder for one owning session, resolved per request. */
export interface CwdWorkspaceReminderInput {
	/** Logical session identity; a change resets all reminder state. */
	ownerId: string;
	/** Fully rendered policy text for the current execution workspace. */
	text: string;
}

/**
 * A genuine user request for reminder cadence: real prompts, follow-ups and
 * steering (the steering flag is stripped by the pre-LLM transform, so only
 * content/timestamp identify them), plus explicit user-initiated developer
 * continuations. Automatic continuations, compaction summaries and
 * agent-attributed notices do not count.
 */
function isGenuineUserInput(message: Message): boolean {
	if (message.role === "user") {
		return (
			message.synthetic !== true &&
			(message.attribution ?? "user") === "user" &&
			message.historyRewriteAt === undefined
		);
	}
	return message.role === "developer" && message.userInitiated === true;
}

interface SourceRecord {
	fingerprint: bigint | undefined;
	genuine: boolean;
	timestamp: number;
}

interface ControlRecord {
	anchorIndex: number;
	anchorFingerprint: bigint | undefined;
	message: DeveloperMessage;
}

/**
 * Remembers which inputs already carry the workspace reminder and re-attaches
 * prior controls at their original source positions, keeping every previously
 * sent byte stable across retries and history rebuilds.
 */
export class CwdWorkspaceReminderInjector {
	#ownerId: string | undefined;
	#sources: SourceRecord[] = [];
	#controls: ControlRecord[] = [];
	#lastEmit: { key: string; text: string } | undefined;
	#fingerprintMemo = new WeakMap<object, { version: number; fingerprint: bigint | undefined }>();

	/** Apply the current workspace reminder while preserving prior injected bytes. */
	transform(context: Context, workspace: CwdWorkspaceReminderInput): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		if (workspace.ownerId !== this.#ownerId) this.#reset(workspace.ownerId);

		const messages = context.messages;
		const previousLength = this.#sources.length;
		const records = messages.map(message => this.#record(message));
		let stable = 0;
		while (
			stable < Math.min(records.length, previousLength) &&
			this.#sameRecord(records[stable]!, this.#sources[stable]!)
		) {
			stable++;
		}
		if (records.length < previousLength) {
			// Compaction/history shrink: prior injections belong to another context.
			this.#reset(this.#ownerId);
		} else if (stable < previousLength) {
			this.#controls = this.#controls.filter(control => control.anchorIndex < stable);
		}
		this.#sources = records;
		const rewritten = records.length >= previousLength && stable < previousLength;

		this.#decide(records, rewritten, workspace);
		const out = this.#apply(messages, records);
		return out === messages ? context : { ...context, messages: out };
	}

	#reset(ownerId: string | undefined): void {
		this.#ownerId = ownerId;
		this.#sources = [];
		this.#controls = [];
		this.#lastEmit = undefined;
	}

	#record(message: Message): SourceRecord {
		const cacheable = isEstimateCacheable(message as AgentMessage);
		const version = messageEstimateVersion(message as AgentMessage);
		const memo = this.#fingerprintMemo.get(message);
		const genuine = isGenuineUserInput(message);
		if (cacheable && memo && memo.version === version) {
			return { fingerprint: memo.fingerprint, genuine, timestamp: message.timestamp };
		}
		const fingerprint = fingerprintMessage(message as AgentMessage);
		if (cacheable) this.#fingerprintMemo.set(message, { version, fingerprint });
		return { fingerprint, genuine, timestamp: message.timestamp };
	}

	#sameRecord(current: SourceRecord, previous: SourceRecord): boolean {
		if (current.fingerprint === undefined || previous.fingerprint === undefined) return false;
		// Timestamps discriminate only genuine user inputs: resent/edited turns
		// invalidate their suffix, while assistant/tool timestamps may churn
		// across provider-request rebuilds.
		return (
			current.fingerprint === previous.fingerprint &&
			current.genuine === previous.genuine &&
			(!current.genuine || current.timestamp === previous.timestamp)
		);
	}

	#decide(records: SourceRecord[], rewritten: boolean, workspace: CwdWorkspaceReminderInput): void {
		let newestGenuine = -1;
		for (let index = records.length - 1; index >= 0; index--) {
			if (records[index]!.genuine) {
				newestGenuine = index;
				break;
			}
		}
		const genuineKey =
			newestGenuine === -1
				? undefined
				: `${newestGenuine}:${records[newestGenuine]!.fingerprint ?? "unstable"}:${records[newestGenuine]!.timestamp}`;
		const last = this.#lastEmit;
		const emit =
			last === undefined ||
			rewritten ||
			(genuineKey !== undefined && genuineKey !== last.key) ||
			workspace.text !== last.text;
		if (!emit) return;

		// An unserializable tail message (fingerprint undefined) can never be
		// validated on reattach: the control would be dropped every request while
		// re-emission churned fresh copies. Skip delivery for that pathological
		// context rather than emitting into the void.
		const anchor = records.at(-1)!;
		if (anchor.fingerprint === undefined) return;

		this.#controls.push({
			anchorIndex: records.length - 1,
			anchorFingerprint: anchor.fingerprint,
			message: { role: "developer", content: workspace.text, synthetic: true, timestamp: Date.now() },
		});
		this.#lastEmit = { key: genuineKey ?? `none:${this.#controls.length}`, text: workspace.text };
	}

	/** Reattach retained controls after their validated source anchors. */
	#apply(messages: Message[], records: SourceRecord[]): Message[] {
		const controlsByIndex = new Map<number, DeveloperMessage[]>();
		const retained: ControlRecord[] = [];
		for (const control of this.#controls) {
			const source = records[control.anchorIndex];
			if (source && source.fingerprint !== undefined && source.fingerprint === control.anchorFingerprint) {
				retained.push(control);
				const list = controlsByIndex.get(control.anchorIndex) ?? [];
				list.push(control.message);
				controlsByIndex.set(control.anchorIndex, list);
			}
		}
		this.#controls = retained;

		if (controlsByIndex.size === 0) return messages;
		const out: Message[] = [];
		for (let index = 0; index < messages.length; index++) {
			out.push(messages[index]!);
			const controls = controlsByIndex.get(index);
			if (controls) out.push(...controls);
		}
		return out;
	}
}
