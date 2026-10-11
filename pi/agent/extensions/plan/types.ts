/**
 * Shared types for the plan extension.
 */

/**
 * TODO    - not attempted yet (the only status that gets executed)
 * DONE    - finished; for "Prove X in F" tasks, verified sorry-free
 * PARTIAL - real progress, but the task itself is not finished
 * BLOCKED - cannot proceed without something from the user
 * FALSE   - the statement was shown false (its negation proved)
 * UNKNOWN - the run ended without the model reporting an outcome
 */
export type TaskStatus = "TODO" | "DONE" | "PARTIAL" | "BLOCKED" | "FALSE" | "UNKNOWN";

export const TASK_STATUSES: readonly TaskStatus[] = [
	"TODO",
	"DONE",
	"PARTIAL",
	"BLOCKED",
	"FALSE",
	"UNKNOWN",
];

export interface PlanTask {
	/** 1-based index in the plan */
	index: number;
	/** Description of the task */
	text: string;
	/** Current status */
	status: TaskStatus;
	/** Optional outcome note, written on an indented `reason:` line */
	reason?: string;
}

export interface PlanFileData {
	/** The goal/description for this plan */
	goal: string;
	/** Ordered list of tasks */
	tasks: PlanTask[];
}

export const PLAN_FILE_NAME = "plan.md";
export const PLAN_DIR = ".pi";
