/**
 * Execution helpers — extracted from index.ts for testability.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "./types.js";

// ── Git commit ─────────────────────────────────────────────────────────────

export interface GitExec {
	exec(
		cmd: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Commit the current task's changes to git.
 * Returns a status string: "committed", "nothing to commit", "not a git repo", or an error message.
 */
export async function commitTask(
	executor: GitExec,
	cwd: string,
	taskIndex: number,
	taskText: string,
	status: TaskStatus,
): Promise<string> {
	try {
		// Check if we're in a git repo
		const statusResult = await executor.exec("git", ["status", "--porcelain"], {
			cwd,
			timeout: 5000,
		});
		if (statusResult.code !== 0) {
			return "not a git repo";
		}

		const msg = `plan: task ${taskIndex}: ${taskText} (${status})`;

		// Stage all changes
		const addResult = await executor.exec("git", ["add", "-A"], {
			cwd,
			timeout: 10000,
		});
		if (addResult.code !== 0) {
			return `git add failed: ${addResult.stderr}`;
		}

		// Check if there's anything to commit
		const diffResult = await executor.exec(
			"git",
			["diff", "--cached", "--quiet"],
			{ cwd, timeout: 5000 },
		);
		const untrackedResult = await executor.exec(
			"git",
			["status", "--porcelain", "--untracked-files=only"],
			{ cwd, timeout: 5000 },
		);

		const hasChanges =
			diffResult.code !== 0 || untrackedResult.stdout.trim().length > 0;
		if (!hasChanges) {
			return "nothing to commit";
		}

		// Commit
		const commitResult = await executor.exec("git", ["commit", "-m", msg], {
			cwd,
			timeout: 15000,
		});
		if (commitResult.code !== 0) {
			return `git commit failed: ${commitResult.stderr}`;
		}

		return "committed";
	} catch {
		return "git commit error";
	}
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
						/\[PLAN BLOCKED\].*?Reason:\s*(.+)/s,
					);
					if (match) return match[1].trim();
				}
			}
		}
	}
	return undefined;
}

// ── Context filtering ──────────────────────────────────────────────────────

export interface ContextMessage {
	customType?: string;
	role?: string;
	[key: string]: unknown;
}

/**
 * Filter messages to only include those from the current task onward.
 * Finds the most recent plan-marker message and keeps everything after it.
 * Returns undefined (no filtering) if not in execution mode or no marker found.
 */
export function filterTaskContext(
	messages: ContextMessage[],
	running: boolean,
): ContextMessage[] | undefined {
	if (!running) return undefined;

	const markerIndex = messages.findIndex(
		(m) => m.customType === "plan-marker",
	);

	if (markerIndex === -1) return undefined;

	return messages.slice(markerIndex);
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
