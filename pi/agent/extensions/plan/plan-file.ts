/**
 * Plan file parsing and writing utilities.
 *
 * Plan file format:
 *
 *   # Plan: <goal>
 *
 *   - TODO: Short task description
 *   - DONE: Short task description
 *   - PARTIAL: Short task description
 *     reason: what was achieved and what is left
 *
 * Statuses: TODO, DONE, PARTIAL, BLOCKED, FALSE, UNKNOWN. A task's outcome
 * note goes on an indented `reason:` line directly below it, never on the
 * task line, so descriptions may contain " — " and colons freely.
 *
 * Legacy format (read, never written): a BLOCKED/UNKNOWN line with no
 * `reason:` line carries its reason after the LAST " — " separator. Writing
 * the plan back moves such a reason onto its own line.
 *
 * Only the header and the task lines survive a write: keep notes and
 * evidence in a separate file and reference it from the task.
 */

export type { PlanFileData, PlanTask, TaskStatus } from "./types.js";
export { PLAN_FILE_NAME, PLAN_DIR, TASK_STATUSES } from "./types.js";
import { TASK_STATUSES, type PlanFileData, type PlanTask, type TaskStatus } from "./types.js";

// ── Parsing ────────────────────────────────────────────────────────────────

const GOAL_RE = /^#\s*Plan:\s*(.+)$/im;
const TASK_LINE_RE = new RegExp(`^(\\s*)- (${TASK_STATUSES.join("|")}):\\s*(.+)$`);
const REASON_LINE_RE = /^\s+reason:\s*(.*)$/;
const LEGACY_REASON_SEP = " \u2014 "; // " — "

/** Longest task description validatePlanSyntax accepts. */
export const MAX_TASK_TEXT_LENGTH = 200;

/** Parse a plan markdown string into structured data. */
export function parsePlan(content: string): PlanFileData {
	const goalMatch = content.match(GOAL_RE);
	const goal = goalMatch ? goalMatch[1].trim() : "";

	const tasks: PlanTask[] = [];
	let last: PlanTask | null = null;
	let lastHasReasonLine = false;

	const finishLast = () => {
		// Legacy: reason after the last " — " on a BLOCKED/UNKNOWN line.
		if (
			last &&
			!lastHasReasonLine &&
			(last.status === "BLOCKED" || last.status === "UNKNOWN")
		) {
			const sepIndex = last.text.lastIndexOf(LEGACY_REASON_SEP);
			if (sepIndex !== -1) {
				const reason = last.text.slice(sepIndex + LEGACY_REASON_SEP.length).trim();
				last.text = last.text.slice(0, sepIndex).trim();
				last.reason = reason || undefined;
			}
		}
	};

	for (const line of content.split(/\r?\n/)) {
		const task = line.match(TASK_LINE_RE);
		if (task) {
			finishLast();
			last = {
				index: tasks.length + 1,
				text: task[3].trim(),
				status: task[2] as TaskStatus,
			};
			lastHasReasonLine = false;
			tasks.push(last);
			continue;
		}
		const reason = line.match(REASON_LINE_RE);
		if (reason && last && !lastHasReasonLine) {
			last.reason = reason[1].trim() || undefined;
			lastHasReasonLine = true;
			continue;
		}
		// Anything else ends the task block.
		finishLast();
		last = null;
	}
	finishLast();

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
		lines.push(`- ${task.status}: ${task.text}`);
		if (task.reason) {
			lines.push(`  reason: ${task.reason.replace(/\s*\n\s*/g, " ").trim()}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

// ── Mutation helpers ──────────────────────────────────────────────────────

/**
 * Update the status of a task by its 1-based index. The reason always
 * describes the latest outcome: it is replaced, and cleared when none is
 * given, so a DONE task never keeps a stale reason from an earlier attempt.
 */
export function updateTaskStatus(
	data: PlanFileData,
	taskIndex: number,
	status: TaskStatus,
	reason?: string,
): PlanFileData | null {
	const task = data.tasks.find((t) => t.index === taskIndex);
	if (!task) return null;

	task.status = status;
	task.reason = reason?.trim() || undefined;

	return data;
}

/** Find the first TODO task (the next task to execute). */
export function findNextTask(data: PlanFileData): PlanTask | null {
	return data.tasks.find((t) => t.status === "TODO") ?? null;
}

/** Count tasks by status. */
export function countByStatus(data: PlanFileData): Record<TaskStatus, number> {
	const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
		TaskStatus,
		number
	>;
	for (const task of data.tasks) {
		counts[task.status]++;
	}
	return counts;
}

/** Check if all tasks have an outcome (no TODO left). */
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

	for (const task of parsed.tasks) {
		if (!task.text.trim()) {
			errors.push(
				`Task ${task.index}: Empty task description. Every task must have a description after the status keyword.`,
			);
		} else if (task.text.length > MAX_TASK_TEXT_LENGTH) {
			errors.push(
				`Task ${task.index}: Description is ${task.text.length} characters (max ${MAX_TASK_TEXT_LENGTH}). Keep each task to one short line and move context and evidence into a notes file that the task references.`,
			);
		}
	}

	return errors;
}

/** Build a summary string like "3 DONE, 1 PARTIAL, 1 BLOCKED". */
export function buildSummary(data: PlanFileData): string {
	const counts = countByStatus(data);
	const order: TaskStatus[] = ["DONE", "FALSE", "PARTIAL", "BLOCKED", "UNKNOWN", "TODO"];
	return order
		.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${s}`)
		.join(", ");
}
