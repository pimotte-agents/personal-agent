/**
 * Execution helpers — extracted from index.ts for testability.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "./types.js";

// ── Git: snapshots, staging, commit ────────────────────────────────────────

export interface GitExec {
	exec(
		cmd: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Path -> content hash of every dirty (modified/untracked/deleted) file. */
export type DirtySnapshot = Map<string, string>;

const DELETED = "<deleted>";

/** Parse `git status --porcelain -z --untracked-files=all` into paths. */
export function parsePorcelainZ(stdout: string): Array<{ path: string; deleted: boolean }> {
	const out: Array<{ path: string; deleted: boolean }> = [];
	const parts = stdout.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		out.push({ path: entry.slice(3), deleted: xy.includes("D") });
		// Renames and copies are followed by their source path.
		if (xy[0] === "R" || xy[0] === "C") i++;
	}
	return out;
}

/**
 * Record every dirty file and its content hash. Taken when a task starts, so
 * that at the end only the files the task itself touched are committed.
 * Returns null outside a git repository.
 */
export async function snapshotDirty(
	executor: GitExec,
	cwd: string,
): Promise<DirtySnapshot | null> {
	const status = await executor.exec(
		"git",
		["status", "--porcelain", "-z", "--untracked-files=all"],
		{ cwd, timeout: 15000 },
	);
	if (status.code !== 0) return null;
	const snap: DirtySnapshot = new Map();
	for (const { path, deleted } of parsePorcelainZ(status.stdout)) {
		if (deleted) {
			snap.set(path, DELETED);
			continue;
		}
		const hash = await executor.exec("git", ["hash-object", "--", path], {
			cwd,
			timeout: 15000,
		});
		snap.set(path, hash.code === 0 ? hash.stdout.trim() : `<unhashable:${Date.now()}>`);
	}
	return snap;
}

/** Files dirty now that were clean, or had different content, in `before`. */
export function changedSince(before: DirtySnapshot, now: DirtySnapshot): string[] {
	const changed: string[] = [];
	for (const [path, hash] of now) {
		if (before.get(path) !== hash) changed.push(path);
	}
	// A file dirty before and clean now was reverted by the task: also a change.
	for (const path of before.keys()) {
		if (!now.has(path)) changed.push(path);
	}
	return changed.sort();
}

/** Short one-line commit subject; the full text goes into the body. */
export function buildCommitMessage(
	taskIndex: number,
	taskText: string,
	status: TaskStatus,
	reason?: string,
	summary?: string,
): string {
	const MAX = 72;
	const prefix = `plan: task ${taskIndex} (${status}): `;
	const oneLine = taskText.replace(/\s+/g, " ").trim();
	const room = Math.max(10, MAX - prefix.length);
	const subject =
		prefix + (oneLine.length > room ? `${oneLine.slice(0, room - 1).trimEnd()}…` : oneLine);
	const body: string[] = [];
	if (oneLine.length > room) body.push(`Task: ${oneLine}`);
	if (reason) body.push(`Reason: ${reason}`);
	if (summary && summary !== reason) body.push(`Summary: ${summary}`);
	return body.length ? `${subject}\n\n${body.join("\n\n")}` : subject;
}

/**
 * Commit exactly `paths` (added, modified or deleted) — never `git add -A`,
 * so files touched outside the task (another session, the user) are left alone.
 * Returns "committed", "nothing to commit", "not a git repo", or an error.
 */
export async function commitTask(
	executor: GitExec,
	cwd: string,
	paths: string[],
	message: string,
): Promise<string> {
	try {
		const statusResult = await executor.exec("git", ["status", "--porcelain"], {
			cwd,
			timeout: 5000,
		});
		if (statusResult.code !== 0) {
			return "not a git repo";
		}
		if (paths.length === 0) {
			return "nothing to commit";
		}

		const addResult = await executor.exec("git", ["add", "-A", "--", ...paths], {
			cwd,
			timeout: 10000,
		});
		if (addResult.code !== 0) {
			return `git add failed: ${addResult.stderr}`;
		}

		const diffResult = await executor.exec(
			"git",
			["diff", "--cached", "--quiet", "--", ...paths],
			{ cwd, timeout: 5000 },
		);
		if (diffResult.code === 0) {
			return "nothing to commit";
		}

		// Commit only these paths, even if something else was already staged.
		const commitResult = await executor.exec(
			"git",
			["commit", "-m", message, "--", ...paths],
			{ cwd, timeout: 15000 },
		);
		if (commitResult.code !== 0) {
			return `git commit failed: ${commitResult.stderr}`;
		}

		return "committed";
	} catch {
		return "git commit error";
	}
}

/**
 * Move `paths` out of the working tree into a named stash (untracked files
 * included), so a broken edit is kept but not committed and does not leak
 * into the next task. Returns true on success.
 */
export async function stashPaths(
	executor: GitExec,
	cwd: string,
	paths: string[],
	message: string,
): Promise<boolean> {
	if (paths.length === 0) return true;
	try {
		const r = await executor.exec(
			"git",
			["stash", "push", "--include-untracked", "-m", message, "--", ...paths],
			{ cwd, timeout: 30000 },
		);
		return r.code === 0;
	} catch {
		return false;
	}
}

// ── Project hooks ──────────────────────────────────────────────────────────
//
// A project can provide executables in .pi/hooks/:
//   check-files <path>...            exit 0 if the changed files compile; else
//                                     exit 1 and print failing paths on stdout
//   verify-done <declaration> <task> exit 0 if a DONE/FALSE claim checks out;
//                                     else exit 1 with the reason on stdout
// Missing hooks are skipped: the extension then trusts the model.

export const HOOK_DIR = ".pi/hooks";

export interface HookResult {
	exists: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

export async function runHook(
	executor: GitExec,
	cwd: string,
	name: string,
	args: string[],
	timeout: number,
): Promise<HookResult> {
	const path = `${HOOK_DIR}/${name}`;
	const probe = await executor.exec("test", ["-x", path], { cwd, timeout: 5000 });
	if (probe.code !== 0) return { exists: false, code: 0, stdout: "", stderr: "" };
	const r = await executor.exec(path, args, { cwd, timeout });
	return { exists: true, ...r };
}

/** Keep the last `max` characters of hook output for a tool result. */
export function tailText(text: string, max = 3000): string {
	const t = text.trim();
	return t.length > max ? `…${t.slice(t.length - max)}` : t;
}

// ── Blocked reason extraction ──────────────────────────────────────────────

export interface SessionBranchEntry {
	type: string;
	message?: {
		role: string;
		toolName?: string;
		isError?: boolean;
		content?: Array<{ type: string; text?: string }>;
	};
}

/**
 * Suffix the ask_question interceptor appends after the question in the
 * tool-result text (see the `tool_call` handler in index.ts).
 */
const BLOCK_SUFFIX =
	". The plan extension will mark this task as BLOCKED and proceed to the next task.";

/** Extract the blocked reason from the session branch. */
export function extractBlockedReason(
	branch: SessionBranchEntry[],
): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry.type === "message" &&
			entry.message?.role === "toolResult"
		) {
			const msg = entry.message;
			if (msg.toolName === "ask_question" && msg.isError) {
				const content = msg.content?.[0];
				if (content?.type === "text" && content.text) {
					const match = content.text.match(
						/\[PLAN BLOCKED\].*?Reason:\s*([\s\S]+)/,
					);
					if (match) {
						let reason = match[1];
						// The tool result appends interceptor guidance after the
						// question. Keep only the question itself (which may be
						// multiline): cut at the known suffix, or — if the
						// interceptor format changed — at the first blank line.
						const suffixAt = reason.indexOf(BLOCK_SUFFIX);
						if (suffixAt !== -1) {
							reason = reason.slice(0, suffixAt);
						} else {
							const blankAt = reason.search(/\n[ \t]*\n/);
							if (blankAt !== -1) reason = reason.slice(0, blankAt);
						}
						reason = reason.trim();
						if (reason) return reason;
					}
				}
			}
		}
	}
	return undefined;
}

// ── Context filtering ──────────────────────────────────────────────────────

/** The fields of a context message the filter reads; pi's AgentMessage fits. */
export interface ContextMessage {
	customType?: unknown;
	role?: unknown;
	content?: unknown;
}

/** Text of a user message, whose content may be a string or text blocks. */
function userMessageText(m: ContextMessage): string | null {
	if (m.role !== "user") return null;
	const content = m.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" &&
				b !== null &&
				(b as { type?: unknown }).type === "text" &&
				typeof (b as { text?: unknown }).text === "string",
		)
		.map((b) => b.text)
		.join("\n");
}

/**
 * Filter messages to only include those from the current task onward.
 *
 * The boundary is the most recent delivered task prompt ("Execute task N of
 * M: ..."), not the plan-marker: pi can deliver the marker AFTER the task
 * prompt it belongs to (the prompt is a queued follow-up, the marker is not),
 * so cutting at a marker could drop the task statement. A marker directly
 * before the prompt is kept with it. Continue/persist prompts deliberately do
 * not match TASK_PROMPT_RE, so a retried task keeps its own history.
 *
 * Returns undefined (no filtering) if not in execution mode or no task prompt
 * is in context — e.g. a compaction summarized it away, in which case the
 * summary is the only record of the task and must be kept.
 */
export function filterTaskContext<T extends ContextMessage>(
	messages: T[],
	running: boolean,
): T[] | undefined {
	if (!running) return undefined;

	let start = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = userMessageText(messages[i]);
		if (text !== null && TASK_PROMPT_RE.test(text)) {
			start = i;
			break;
		}
	}
	if (start === -1) return undefined;

	if (start > 0 && messages[start - 1].customType === "plan-marker") {
		start -= 1;
	}

	return messages.slice(start);
}

// ── Task outcome resolution ────────────────────────────────────────────────

export interface TaskOutcome {
	status: TaskStatus;
	reason: string | undefined;
}

/**
 * Resolve the outcome of a task based on execution state and session branch.
 */
export function resolveTaskOutcome(
	taskCompleted: boolean,
	taskBlocked: boolean,
	branch: SessionBranchEntry[],
): TaskOutcome {
	if (taskCompleted) {
		return { status: "DONE", reason: undefined };
	}

	if (taskBlocked) {
		const reason = extractBlockedReason(branch);
		return { status: "BLOCKED", reason };
	}

	return {
		status: "UNKNOWN",
		reason:
			"Task completed but outcome was unclear (task_complete was not called)",
	};
}

// ── Task-end decision (agent_end handling) ──────────────────────────────────
//
// When an agent run ends during execution, the extension must decide what
// happened to the current task. The decision is pure so it can be tested
// without the pi runtime:
//
//   skip    - the ended run belonged to an earlier task (e.g. pi's overflow
//             recovery re-sent a truncated turn after the extension had
//             already advanced). Finalize/queue nothing.
//   advance - finalize the current task (DONE / BLOCKED / UNKNOWN) and queue
//             the next task.
//   retry   - the run was truncated before task_complete: re-inject the same
//             task. `compact` asks for a compaction first when the context is
//             high and pi's own overflow recovery will not handle it.
//             `final` marks the last retry in the budget: instead of the
//             normal continue prompt, index.ts sends a persist-partial-results
//             prompt so a repeatedly truncated task can at least write down
//             its state before being given up.
//   stop    - finalize the current task as UNKNOWN and stop execution (the
//             run was aborted by the user or ended in an error).

/** Matches the task prompts this extension sends: "Execute task 3 of 20: ..." */
export const TASK_PROMPT_RE = /^Execute task (\d+) of \d+:/;

/** Max times a truncated task is re-injected before being given up as UNKNOWN. */
export const MAX_LENGTH_RETRIES = 2;

/** Context usage percent (0-100) at which a compaction is requested before
 *  re-injecting a truncated task. */
export const RETRY_COMPACT_PERCENT = 85;

/** If the compaction callbacks never fire, re-inject anyway after this long.
 *  A duplicated "continue" turn is harmless (it re-checks state first). */
export const RETRY_COMPACT_SAFETY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Find the task index of the most recent DELIVERED task prompt
 * ("Execute task N of M: ...") in the session branch, or null if none.
 *
 * Prompts that are only queued (not yet delivered) are not in the branch, so
 * this returns the task the agent actually last worked on. Used to detect
 * that an agent_end belongs to a stale retry of an earlier task.
 */
export function findDeliveredTaskIndex(
	branch: SessionBranchEntry[],
): number | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "user" || !msg.content) continue;
		const text = msg.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n");
		const match = text.match(TASK_PROMPT_RE);
		if (match) return Number(match[1]);
	}
	return null;
}

/**
 * True when pi's own overflow recovery will handle this length stop: the
 * response ended BELOW the model's output cap, which pi treats as context
 * pressure (compact-and-retry the same turn). In that case the extension
 * must not trigger its own compaction — the two would run in parallel.
 */
export function isPiRecoverableLength(
	stopReason: string | null,
	lastOutputTokens: number | null,
	maxOutputTokens: number,
): boolean {
	return (
		stopReason === "length" &&
		maxOutputTokens > 0 &&
		lastOutputTokens !== null &&
		lastOutputTokens < maxOutputTokens
	);
}

export interface TaskEndParams {
	/** Task index of the last delivered task prompt, or null if none found. */
	deliveredTaskIndex: number | null;
	/** Task index the extension currently considers active. */
	currentTaskIndex: number;
	/** task_complete was called (and accepted) during this task. */
	taskCompleted: boolean;
	/** The outcome task_complete recorded; DONE when absent. */
	completedOutcome?: TaskOutcome;
	/** ask_question was intercepted (blocked) during this task. */
	taskBlocked: boolean;
	/** Pre-extracted blocked reason, if any. */
	blockedReason?: string;
	/** stopReason of the last assistant message of the ended run, or null. */
	stopReason: string | null;
	/** Output tokens of the last assistant message, or null. */
	lastOutputTokens: number | null;
	/** Configured max output tokens for the model (0 = unknown). */
	maxOutputTokens: number;
	/** Times this task has already been re-injected after truncation. */
	lengthRetries: number;
	/** Re-injection budget before the task is given up as UNKNOWN. */
	maxLengthRetries: number;
	/** Context usage percent (0-100), or null if unknown. */
	contextPercent: number | null;
	/** Percent at which a compaction is requested before re-injection. */
	compactThresholdPercent: number;
}

export type TaskEndDecision =
	| { kind: "advance"; outcome: TaskOutcome }
	| { kind: "retry"; compact: boolean; final?: boolean }
	| { kind: "stop"; outcome: TaskOutcome }
	| { kind: "skip" };

/**
 * Decide what to do with the current task when an agent run ends.
 */
export function decideTaskEnd(p: TaskEndParams): TaskEndDecision {
	// 1) The ended run must belong to the current task. If the branch's last
	//    task prompt is an earlier one, this agent_end belongs to a stale
	//    retry of that earlier turn — do not finalize or queue anything.
	//    (No prompt found at all: fall through — better to risk advancing
	//    than to stall the plan.)
	if (
		p.deliveredTaskIndex !== null &&
		p.deliveredTaskIndex !== p.currentTaskIndex
	) {
		return { kind: "skip" };
	}

	// 2) Explicit completion signals win over how the run ended.
	if (p.taskCompleted) {
		return {
			kind: "advance",
			outcome: p.completedOutcome ?? { status: "DONE", reason: undefined },
		};
	}
	if (p.taskBlocked) {
		return {
			kind: "advance",
			outcome: { status: "BLOCKED", reason: p.blockedReason },
		};
	}

	// 3) No explicit signal: how the run ended decides.
	if (p.stopReason === "aborted") {
		return {
			kind: "stop",
			outcome: {
				status: "UNKNOWN",
				reason:
					"Aborted before completion (user interrupt or plan stop)",
			},
		};
	}
	if (p.stopReason === "error") {
		return {
			kind: "stop",
			outcome: {
				status: "UNKNOWN",
				reason:
					"Run ended with an error before completion (task_complete was not called)",
			},
		};
	}
	if (p.stopReason === "length") {
		// The last retry in the budget is the "final" retry: index.ts sends a
		// persist-partial-results prompt instead of the normal continue
		// prompt. Only when THAT attempt is truncated too is the task given
		// up below.
		if (p.lengthRetries <= p.maxLengthRetries) {
			// Re-inject the same task. Request a compaction first when the
			// context is high — unless pi's overflow recovery will already
			// compact (a manual compaction would run in parallel with it).
			const compact =
				p.contextPercent !== null &&
				p.contextPercent >= p.compactThresholdPercent &&
				!isPiRecoverableLength(
					p.stopReason,
					p.lastOutputTokens,
					p.maxOutputTokens,
				);
			if (p.lengthRetries === p.maxLengthRetries) {
				return { kind: "retry", compact, final: true };
			}
			return { kind: "retry", compact };
		}
		return {
			kind: "advance",
			outcome: {
				status: "UNKNOWN",
				reason: `Truncated ${p.lengthRetries + 1} times at the output limit, including a final checkpoint attempt; never completed (task_complete was not called)`,
			},
		};
	}

	// "stop" or unrecognized: the model finished the turn without signaling.
	return {
		kind: "advance",
		outcome: {
			status: "UNKNOWN",
			reason:
				"Task completed but outcome was unclear (task_complete was not called)",
		},
	};
}

/** How to report a task's outcome; appended to every task prompt. */
export const TASK_OUTCOME_INSTRUCTIONS: readonly string[] = [
	"When you stop working on this task, call task_complete with the status that is true:",
	"- DONE: the task is fully done. Claims on \"Prove X in F\" tasks are checked (the file must compile and X must not depend on sorry); a failed check is returned to you as an error.",
	"- PARTIAL: real progress, but the task is not finished. Put what was achieved and what is left in the summary.",
	"- FALSE: the statement is false and you proved its negation. Pass that theorem's name as `declaration`; it is checked like DONE.",
	"- BLOCKED: you cannot proceed. Put the reason in the summary.",
	"If you need clarification from the user, call ask_question — the plan extension will mark this task as BLOCKED and proceed to the next task.",
];

/**
 * Build the "persist partial results" prompt sent as the FINAL continuation
 * of a task that has been truncated at the output limit repeatedly. It asks
 * the model to stop working and write down its partial state instead.
 * Deliberately does NOT start with "Execute task N of M" so
 * findDeliveredTaskIndex() keeps resolving to the original prompt.
 */
export function buildPersistMessage(
	task: { index: number; text: string },
	totalTasks: number,
	goal: string,
): string {
	const lines = [
		`Final attempt for task ${task.index} of ${totalTasks}: ${task.text}`,
		"",
		"This task has repeatedly been truncated by the output limit, so it will not be completed in this run. Do not try to make further progress on it now. Instead, persist your partial results:",
		"1. Append a short checkpoint to the project's progress notes (e.g. PROGRESS.md or the relevant notes file): what has been done, what was tried, the current partial results, and the exact next steps for a fresh session.",
		"2. Leave any modified files in a consistent state (no half-written edits).",
		"Keep the write short — it must fit within a single response.",
		"",
		`This is part of the plan: "${goal}"`,
		"",
		"When the checkpoint is written, call task_complete with status PARTIAL and a one-line summary of what was achieved (or ask_question, if nothing was, so the task is marked BLOCKED) and the plan moves on.",
	];
	return lines.join("\n");
}

/**
 * Build the "continue" prompt re-injected when a task's run was truncated
 * before task_complete. Deliberately does NOT start with "Execute task N of
 * M" so findDeliveredTaskIndex() keeps resolving to the original prompt.
 */
export function buildContinueMessage(
	task: { index: number; text: string },
	totalTasks: number,
	goal: string,
	retriesUsed: number,
): string {
	const lines = [
		`Continue task ${task.index} of ${totalTasks}: ${task.text}`,
		"",
		`Your previous response on this task was truncated by the output limit before you called task_complete. Resume from where you left off: first check the current state of the relevant files (some work may already be done), then continue the task.`,
	];
	if (retriesUsed > 1) {
		lines.push(
			"",
			`This is retry ${retriesUsed} of ${MAX_LENGTH_RETRIES}. If you cannot make further progress, call task_complete with status PARTIAL (what was achieved) or BLOCKED (why), or ask_question with the reason, instead of letting the task be dropped.`,
		);
	}
	lines.push(
		"",
		`This is part of the plan: "${goal}"`,
		"",
		...TASK_OUTCOME_INSTRUCTIONS,
	);
	return lines.join("\n");
}

/**
 * Build the prompt that starts a task. Starts with "Execute task N of M:" —
 * TASK_PROMPT_RE and the context filter rely on that. A reason left by an
 * earlier attempt (a task reset to TODO) is passed on so work is not redone.
 */
export function buildTaskMessage(
	task: { index: number; text: string; reason?: string },
	totalTasks: number,
	goal: string,
	planPath: string,
): string {
	const lines = [`Execute task ${task.index} of ${totalTasks}: ${task.text}`, ""];
	if (task.reason) {
		lines.push(`Outcome of an earlier attempt: ${task.reason}`, "");
	}
	lines.push(
		`This is part of the plan: "${goal}"`,
		`Full plan file: ${planPath}`,
		"",
		...TASK_OUTCOME_INSTRUCTIONS,
	);
	return lines.join("\n");
}
