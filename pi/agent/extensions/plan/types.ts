/**
 * Shared types for the plan extension.
 */

export type TaskStatus = "TODO" | "DONE" | "BLOCKED" | "UNKNOWN";

export interface PlanTask {
	/** 1-based index in the plan */
	index: number;
	/** Description of the task */
	text: string;
	/** Current status */
	status: TaskStatus;
	/** Optional reason for BLOCKED or UNKNOWN */
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
