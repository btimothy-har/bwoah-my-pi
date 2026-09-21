/**
 * Date reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date line used to live at the tail of the system
 * prompt (`project-prompt.md`), which invalidated the whole tool array on
 * every day rollover. It now rides on the first user turn of each provider
 * request instead: built at request time (never stored in the session),
 * deterministic per day, so the bytes are stable for the lifetime of a
 * session/day and refresh automatically at midnight. The execution directory
 * is carried by the workspace-policy reminder instead (cwd-workspace-reminder.ts).
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import { prompt } from "@oh-my-pi/pi-utils";
import dateReminderTemplate from "../prompts/system/date-reminder.md" with { type: "text" };

/** Renders the reminder text for the given local calendar date. */
export function renderDateReminder(date: string): string {
	return prompt.render(dateReminderTemplate, { date }).trim();
}

function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	return { ...message, content };
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 */
export class DateReminderInjector {
	#root: UserMessage | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<Message, { injected: UserMessage; reminder: string; version: number }>();
	#controls: Array<{ anchor: Message; message: Message }> = [];
	#seen = new WeakSet<object>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateReminder(date);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	#recordInjection(
		source: UserMessage,
		reminder: string,
	): { injected: UserMessage; reminder: string; version: number } {
		return {
			injected: injectReminder(source, reminder),
			reminder,
			version: messageEstimateVersion(source as AgentMessage),
		};
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;
		if (this.#root !== firstUser) {
			this.#root = firstUser;
			this.#currentReminder = reminder;
			this.#injections.clear();
			this.#controls = [];
			this.#seen = new WeakSet();
			if (!messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(firstUser, this.#recordInjection(firstUser, reminder));
			}
		} else if (this.#currentReminder !== reminder) {
			let newUser: UserMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const candidate = messages[index]!;
				if (candidate.role === "user" && !this.#seen.has(candidate)) {
					newUser = candidate;
					break;
				}
			}
			if (newUser) {
				this.#injections.set(newUser, this.#recordInjection(newUser, reminder));
			} else {
				const anchor = messages.at(-1)!;
				this.#controls.push({
					anchor,
					message: {
						role: "developer",
						content: reminder,
						synthetic: true,
						timestamp: Date.now(),
					},
				});
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<Message, Message[]>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const record = this.#injections.get(message);
			if (record) {
				// Owner rewrites (prune/shake) mutate messages in place under stable
				// identity and bump the estimate version; a stale injected copy would
				// hide the rewritten source. Rebuild with the ORIGINAL reminder over
				// the CURRENT content instead of replaying the stale copy.
				if (record.version !== messageEstimateVersion(message as AgentMessage)) {
					this.#injections.set(message, this.#recordInjection(message as UserMessage, record.reminder));
				}
				out.push(this.#injections.get(message)!.injected);
				changed = true;
			} else {
				out.push(message);
			}
			const controls = controlsByAnchor.get(message);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			this.#seen.add(message);
		}
		return changed ? out : messages;
	}
}
