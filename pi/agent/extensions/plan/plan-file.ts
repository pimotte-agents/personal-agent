/**
 * Plan file parsing and writing utilities.
 *
 * Plan file format:
 *
 *   # Plan: <goal>
 *
 *   - [ ] TODO: Task description
 *   - [x] DONE: Task description
 *   - [ ] BLOCKED: Task description — reason
 *   - [ ] UNKNOWN: Task description — reason
 */

export type { PlanFileData, PlanTask, TaskStatus } from "./types.js";
export { PLAN_FILE_NAME, PLAN_DIR } from "./types.js";

// ── Parsing ────────────────────────────────────────────────────────────────

const GOAL_RE = /^#\s*Plan:\s*(.+)$/im;
const TASK_RE = /^(\s*)- \[[ x]\] (TODO|DONE|BLOCKED|UNKNOWN):\s*(.+)$/gm;
const REASON_SEP = " \u2014 "; // " — "

/** Parse a plan markdown string into structured data. */
export function parsePlan(content: string): PlanFileData {
	const goalMatch = content.match(GOAL_RE);
	const goal = goalMatch ? goalMatch[1].trim() : "";

	const tasks: PlanTask[] = [];
	let match: RegExpExecArray | null;

	while ((match = TASK_RE.exec(content)) !== null) {
		const rawText = match[3].trim();
		let text = rawText;
		let reason: string | undefined;

		// Check if there's a reason separator in the text
		const sepIndex = rawText.indexOf(REASON_SEP);
		if (sepIndex !== -1) {
			text = rawText.slice(0, sepIndex).trim();
			reason = rawText.slice(sepIndex + REASON_SEP.length).trim();
		}

		const status = match[2] as TaskStatus;
		tasks.push({
			index: tasks.length + 1,
			text,
			status,
			reason: reason || undefined,
		});
	}

	return { goal, tasks };
}

// ── Serialization ──────────────────────────────────────────────────────────

/** Convert a PlanFileData back to markdown. */
export function serializePlan(data: PlanFileData): string {
	const lines: string[] = [`# Plan: ${data.goal}`];

	if (data.tasks.length === 0) {
		return lines.join("\n");
	}

	lines.push("");

	for (const task of data.tasks) {
		const checked = task.status === "DONE" ? "x" : " ";
		let line = `- [${checked}] ${task.status}: ${task.text}`;

		if (task.reason) {
			line += `${REASON_SEP}${task.reason}`;
		}

		lines.push(line);
	}

	// Ensure trailing newline
	if (!lines[lines.length - 1]) {
		lines.push("");
	}

	return lines.join("\n");
}

// ── Mutation helpers ──────────────────────────────────────────────────────

/** Update the status of a task by its 1-based index. */
export function updateTaskStatus(
	data: PlanFileData,
	taskIndex: number,
	status: TaskStatus,
	reason?: string,
): PlanFileData | null {
	const task = data.tasks.find((t) => t.index === taskIndex);
	if (!task) return null;

	task.status = status;
	if (status === "BLOCKED" || status === "UNKNOWN") {
		task.reason = reason ?? task.reason;
	} else {
		task.reason = undefined;
	}

	return data;
}

/** Find the first TODO task (the next task to execute). */
export function findNextTask(data: PlanFileData): PlanTask | null {
	return data.tasks.find((t) => t.status === "TODO") ?? null;
}

/** Count tasks by status. */
export function countByStatus(data: PlanFileData): Record<TaskStatus, number> {
	const counts: Record<TaskStatus, number> = {
		TODO: 0,
		DONE: 0,
		BLOCKED: 0,
		UNKNOWN: 0,
	};
	for (const task of data.tasks) {
		counts[task.status]++;
	}
	return counts;
}

/** Check if all tasks are completed (DONE, BLOCKED, or UNKNOWN). */
export function isPlanComplete(data: PlanFileData): boolean {
	return data.tasks.length > 0 && data.tasks.every((t) => t.status !== "TODO");
}

/** Build a summary string like "3 DONE, 1 BLOCKED, 1 UNKNOWN". */
export function buildSummary(data: PlanFileData): string {
	const counts = countByStatus(data);
	const parts: string[] = [];
	if (counts.DONE > 0) parts.push(`${counts.DONE} DONE`);
	if (counts.BLOCKED > 0) parts.push(`${counts.BLOCKED} BLOCKED`);
	if (counts.UNKNOWN > 0) parts.push(`${counts.UNKNOWN} UNKNOWN`);
	if (counts.TODO > 0) parts.push(`${counts.TODO} TODO`);
	return parts.join(", ");
}
