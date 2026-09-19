/**
 * Plan file parsing and writing utilities.
 *
 * Plan file format:
 *
 *   # Plan: <goal>
 *
 *   - TODO: Task description
 *   - DONE: Task description
 *   - BLOCKED: Task description — reason
 *   - UNKNOWN: Task description — reason
 *
 * Only BLOCKED and UNKNOWN tasks carry a reason: the text after the LAST
 * " — " (U+2014) separator on the line. TODO/DONE descriptions may contain
 * " — " freely — the whole rest of the line is the description.
 */

export type { PlanFileData, PlanTask, TaskStatus } from "./types.js";
export { PLAN_FILE_NAME, PLAN_DIR } from "./types.js";

// ── Parsing ────────────────────────────────────────────────────────────────

const GOAL_RE = /^#\s*Plan:\s*(.+)$/im;
const TASK_RE = /^(\s*)- (TODO|DONE|BLOCKED|UNKNOWN):\s*(.+)$/gm;
const REASON_SEP = " \u2014 "; // " — "

/** Parse a plan markdown string into structured data. */
export function parsePlan(content: string): PlanFileData {
	const goalMatch = content.match(GOAL_RE);
	const goal = goalMatch ? goalMatch[1].trim() : "";

	const tasks: PlanTask[] = [];
	let match: RegExpExecArray | null;

	while ((match = TASK_RE.exec(content)) !== null) {
		const rawText = match[3].trim();
		const status = match[2] as TaskStatus;
		let text = rawText;
		let reason: string | undefined;

		// Only BLOCKED and UNKNOWN tasks carry a reason, written after a
		// " — " separator. TODO/DONE descriptions may contain " — " (and
		// colons) freely — the whole rest of the line is the description.
		//
		// The extension always APPENDS the reason at the end of the line,
		// so split at the LAST separator to keep descriptions containing
		// emdashes intact. (If the reason itself contains " — ", the part
		// before its last separator is read as description — the format is
		// inherently ambiguous there.)
		if (status === "BLOCKED" || status === "UNKNOWN") {
			const sepIndex = rawText.lastIndexOf(REASON_SEP);
			if (sepIndex !== -1) {
				text = rawText.slice(0, sepIndex).trim();
				reason = rawText.slice(sepIndex + REASON_SEP.length).trim();
			}
		}

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
		let line = `- ${task.status}: ${task.text}`;

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
	if (reason !== undefined) {
		task.reason = reason;
	}
	// An existing reason is kept when moving to TODO/DONE (or when no new
	// reason is given): it may hold description content that followed a
	// " — " separator on a BLOCKED/UNKNOWN line, and user content must
	// never be dropped silently.

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

// ── Syntax validation ─────────────────────────────────────────────────────

/**
 * Validate the markdown content of a plan for formatting issues.
 * Returns an array of error messages, or an empty array if valid.
 */
export function validatePlanSyntax(content: string): string[] {
	const errors: string[] = [];

	// Check for plan header
	if (!GOAL_RE.test(content)) {
		errors.push("Missing plan header. Expected: '# Plan: <goal>'");
	}

	// Parse and check tasks
	const parsed = parsePlan(content);
	if (parsed.tasks.length === 0 && !errors.length) {
		errors.push("No tasks found in the plan. Expected tasks in format: '- TODO: task description'");
	}

	// Check for empty task descriptions
	for (const task of parsed.tasks) {
		if (!task.text.trim()) {
			errors.push(
				`Task ${task.index}: Empty task description. Every task must have a description after the status keyword.`,
			);
		}
	}

	return errors;
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
