import { describe, it, expect } from "vitest";
import {
	parsePlan,
	serializePlan,
	updateTaskStatus,
	findNextTask,
	countByStatus,
	isPlanComplete,
	buildSummary,
	validatePlanSyntax,
} from "../plan-file.js";
import type { PlanFileData } from "../types.js";

// ── parsePlan ──────────────────────────────────────────────────────────────

describe("parsePlan", () => {
	it("parses goal and tasks", () => {
		const input = `# Plan: Build authentication system

- TODO: Set up user model
- TODO: Create login endpoint
- TODO: Add JWT middleware`;

		const result = parsePlan(input);
		expect(result.goal).toBe("Build authentication system");
		expect(result.tasks).toHaveLength(3);
		expect(result.tasks[0]).toEqual({
			index: 1,
			text: "Set up user model",
			status: "TODO",
			reason: undefined,
		});
		expect(result.tasks[1].text).toBe("Create login endpoint");
		expect(result.tasks[2].text).toBe("Add JWT middleware");
	});

	it("parses DONE tasks", () => {
		const input = `# Plan: Test plan

- DONE: Completed task`;

		const result = parsePlan(input);
		expect(result.tasks[0].status).toBe("DONE");
	});

	it("parses BLOCKED tasks with reason", () => {
		const input = `# Plan: Test

- BLOCKED: Some task — could not find API docs`;

		const result = parsePlan(input);
		expect(result.tasks[0].status).toBe("BLOCKED");
		expect(result.tasks[0].text).toBe("Some task");
		expect(result.tasks[0].reason).toBe("could not find API docs");
	});

	it("parses UNKNOWN tasks with reason", () => {
		const input = `# Plan: Test

- UNKNOWN: Unclear task — outcome was ambiguous`;

		const result = parsePlan(input);
		expect(result.tasks[0].status).toBe("UNKNOWN");
		expect(result.tasks[0].reason).toBe("outcome was ambiguous");
	});

	it("handles empty plan", () => {
		const result = parsePlan("# Plan: Empty\n\n");
		expect(result.goal).toBe("Empty");
		expect(result.tasks).toHaveLength(0);
	});

	it("handles plan without goal", () => {
		const result = parsePlan("- TODO: A task");
		expect(result.goal).toBe("");
		expect(result.tasks).toHaveLength(1);
	});

	it("handles mixed statuses", () => {
		const input = `# Plan: Mixed

- TODO: First
- DONE: Second
- BLOCKED: Third — reason here
- UNKNOWN: Fourth — unclear outcome`;

		const result = parsePlan(input);
		expect(result.tasks[0].status).toBe("TODO");
		expect(result.tasks[1].status).toBe("DONE");
		expect(result.tasks[2].status).toBe("BLOCKED");
		expect(result.tasks[2].reason).toBe("reason here");
		expect(result.tasks[3].status).toBe("UNKNOWN");
		expect(result.tasks[3].reason).toBe("unclear outcome");
	});

	it("keeps emdashes in TODO descriptions (no reason split)", () => {
		const input = `# Plan: Test

- TODO: Run integration-tests — smoke test`;

		const result = parsePlan(input);
		// TODO tasks never carry a reason: the whole rest of the line is the
		// description, emdashes included.
		expect(result.tasks[0].text).toBe("Run integration-tests — smoke test");
		expect(result.tasks[0].reason).toBeUndefined();
	});

	it("keeps emdashes in DONE descriptions (no reason split)", () => {
		const input = `# Plan: Test

- DONE: Reply to **each** of the 27 comments (established "Done — ..." style); for 3851331565 answer the question (not in the current book version → removed)`;

		const result = parsePlan(input);
		expect(result.tasks[0].text).toBe(
			'Reply to **each** of the 27 comments (established "Done — ..." style); for 3851331565 answer the question (not in the current book version → removed)',
		);
		expect(result.tasks[0].reason).toBeUndefined();
	});

	it("keeps colons in task descriptions", () => {
		const input = `# Plan: Test

- TODO: sheet2: renumber items to book numbers: Example 4.1.10 → 4.2.19
- BLOCKED: sheet3a: fix header — Source: Section 4.3 (was 4.2) — waiting on maintainer`;

		const result = parsePlan(input);
		expect(result.tasks[0].text).toBe(
			"sheet2: renumber items to book numbers: Example 4.1.10 → 4.2.19",
		);
		expect(result.tasks[0].reason).toBeUndefined();
		// Colons in the description are kept; the reason starts after the
		// LAST " — " separator.
		expect(result.tasks[1].text).toBe("sheet3a: fix header — Source: Section 4.3 (was 4.2)");
		expect(result.tasks[1].reason).toBe("waiting on maintainer");
	});

	it("splits BLOCKED description from reason at the LAST separator", () => {
		const input = `# Plan: Test

- BLOCKED: sheet2 — renumber 4.1.10 to 4.2.19 — maintainer asked to redo it first`;

		const result = parsePlan(input);
		// The extension always APPENDS the reason, so the last separator is
		// the boundary; emdashes in the description stay intact.
		expect(result.tasks[0].text).toBe("sheet2 — renumber 4.1.10 to 4.2.19");
		expect(result.tasks[0].reason).toBe("maintainer asked to redo it first");
	});

	it("splits UNKNOWN description from reason at the LAST separator", () => {
		const input = `# Plan: Test

- UNKNOWN: sheet3b — add the √2 example — Task completed but outcome was unclear (task_complete was not called)`;

		const result = parsePlan(input);
		expect(result.tasks[0].text).toBe("sheet3b — add the √2 example");
		expect(result.tasks[0].reason).toBe(
			"Task completed but outcome was unclear (task_complete was not called)",
		);
	});

	it("BLOCKED without separator keeps the whole line as text", () => {
		const input = `# Plan: Test

- BLOCKED: Sheet 2 header update`;

		const result = parsePlan(input);
		expect(result.tasks[0].text).toBe("Sheet 2 header update");
		expect(result.tasks[0].reason).toBeUndefined();
	});

	it("ignores non-task lines", () => {
		const input = `# Plan: Test

Some random text here.
## Section

- TODO: A real task
Not a task either.
- DONE: Another task`;

		const result = parsePlan(input);
		expect(result.tasks).toHaveLength(2);
	});

	it("handles task text with special characters", () => {
		const input = `# Plan: Test

- TODO: Add rate-limiting to /api/upload endpoint
- TODO: Support "quoted" values`;

		const result = parsePlan(input);
		expect(result.tasks[0].text).toBe("Add rate-limiting to /api/upload endpoint");
		expect(result.tasks[1].text).toBe('Support "quoted" values');
	});
});

// ── serializePlan ──────────────────────────────────────────────────────────

describe("serializePlan", () => {
	it("serializes a simple plan", () => {
		const data: PlanFileData = {
			goal: "Test goal",
			tasks: [
				{ index: 1, text: "First task", status: "TODO" },
				{ index: 2, text: "Second task", status: "DONE" },
			],
		};

		const output = serializePlan(data);
		expect(output).toContain("# Plan: Test goal");
		expect(output).toContain("- TODO: First task");
		expect(output).toContain("- DONE: Second task");
	});

	it("serializes BLOCKED task with reason", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Blocked task", status: "BLOCKED", reason: "no API docs" },
			],
		};

		const output = serializePlan(data);
		expect(output).toContain("- BLOCKED: Blocked task — no API docs");
	});

	it("serializes UNKNOWN task with reason", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Unclear", status: "UNKNOWN", reason: "ambiguous" },
			],
		};

		const output = serializePlan(data);
		expect(output).toContain("- UNKNOWN: Unclear — ambiguous");
	});

	it("serializes empty plan", () => {
		const data: PlanFileData = { goal: "Empty", tasks: [] };
		const output = serializePlan(data);
		expect(output).toBe("# Plan: Empty");
	});

	it("round-trips through parse + serialize", () => {
		const original = `# Plan: Round trip

- TODO: Task one
- DONE: Task two
- BLOCKED: Task three — blocked reason
- UNKNOWN: Task four — unknown reason`;

		const parsed = parsePlan(original);
		const serialized = serializePlan(parsed);
		const reparsed = parsePlan(serialized);

		expect(reparsed.goal).toBe(parsed.goal);
		expect(reparsed.tasks).toEqual(parsed.tasks);
	});

	it("round-trips byte-identically with emdashes in TODO/DONE descriptions", () => {
		// Regression for the review.md incident: every line started with a
		// "sheetN — " prefix and the instructions lived after the first
		// emdash. Under the new rules the whole line is the description and
		// parse + serialize must be byte-identical.
		const original = `# Plan: Address PR #61 review round 4

- DONE: Re-verify the inventory above against GitHub and confirm exactly these 27 comment ids
- TODO: sheet2 — renumber items to book numbers: Example 4.1.10 → 4.2.19 (comments 2, 3, 5)
- TODO: sheet2 — add book Example 4.2.16 (product identity) as a visible example (comment 6)
- BLOCKED: sheet2 — update the header comment block and the design note — the 4.2.16 example task was interrupted
- UNKNOWN: sheet3b — add the sqrt-2 example — Task completed but outcome was unclear (task_complete was not called)`;

		const parsed = parsePlan(original);
		expect(serializePlan(parsed)).toBe(original);

		// And stable across repeated round-trips.
		const reparsed = parsePlan(serializePlan(parsed));
		expect(reparsed.tasks).toEqual(parsed.tasks);
	});
});

// ── updateTaskStatus ──────────────────────────────────────────────────────

describe("updateTaskStatus", () => {
	it("updates status to DONE", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "TODO" },
			],
		};

		updateTaskStatus(data, 1, "DONE");
		expect(data.tasks[0].status).toBe("DONE");
		expect(data.tasks[0].reason).toBeUndefined();
	});

	it("updates status to BLOCKED with reason", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "TODO" },
			],
		};

		updateTaskStatus(data, 1, "BLOCKED", "API not found");
		expect(data.tasks[0].status).toBe("BLOCKED");
		expect(data.tasks[0].reason).toBe("API not found");
	});

	it("updates status to UNKNOWN with reason", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "TODO" },
			],
		};

		updateTaskStatus(data, 1, "UNKNOWN");
		expect(data.tasks[0].status).toBe("UNKNOWN");
	});

	it("returns null for non-existent task", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [],
		};

		const result = updateTaskStatus(data, 99, "DONE");
		expect(result).toBeNull();
	});

	it("keeps existing reason when marking DONE (no silent content loss)", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "BLOCKED", reason: "old reason" },
			],
		};

		updateTaskStatus(data, 1, "DONE");
		expect(data.tasks[0].status).toBe("DONE");
		expect(data.tasks[0].reason).toBe("old reason");
	});

	it("keeps description content parked in reason when marking DONE", () => {
		// Regression: a line written as "TODO: sheet2 — full instructions" was
		// parsed with the instructions as reason and then DROPPED when the
		// task was marked DONE, leaving only "sheet2" in the plan file.
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "sheet2", status: "TODO", reason: "renumber items to book numbers" },
			],
		};

		updateTaskStatus(data, 1, "DONE");
		expect(data.tasks[0].reason).toBe("renumber items to book numbers");
		// And the serialized line still contains the full instruction.
		expect(serializePlan(data)).toContain(
			"- DONE: sheet2 — renumber items to book numbers",
		);
	});

	it("preserves reason when updating to same status without new reason", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "BLOCKED", reason: "existing" },
			],
		};

		updateTaskStatus(data, 1, "BLOCKED");
		expect(data.tasks[0].reason).toBe("existing");
	});

	it("replaces reason when a new reason is given", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Task", status: "BLOCKED", reason: "old reason" },
			],
		};

		updateTaskStatus(data, 1, "BLOCKED", "new reason");
		expect(data.tasks[0].reason).toBe("new reason");
	});
});

// ── findNextTask ───────────────────────────────────────────────────────────

describe("findNextTask", () => {
	it("finds first TODO task", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Done", status: "DONE" },
				{ index: 2, text: "Pending", status: "TODO" },
				{ index: 3, text: "Also pending", status: "TODO" },
			],
		};

		const next = findNextTask(data);
		expect(next?.index).toBe(2);
	});

	it("skips DONE and terminal tasks", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Done1", status: "DONE" },
				{ index: 2, text: "Blocked", status: "BLOCKED" },
				{ index: 3, text: "Unknown", status: "UNKNOWN" },
				{ index: 4, text: "Pending", status: "TODO" },
			],
		};

		const next = findNextTask(data);
		expect(next?.index).toBe(4);
	});

	it("returns null when all DONE", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Done1", status: "DONE" },
				{ index: 2, text: "Done2", status: "DONE" },
			],
		};

		const next = findNextTask(data);
		expect(next).toBeNull();
	});

	it("skips BLOCKED and UNKNOWN tasks", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Blocked", status: "BLOCKED" },
				{ index: 2, text: "Unknown", status: "UNKNOWN" },
				{ index: 3, text: "Todo", status: "TODO" },
			],
		};

		const next = findNextTask(data);
		expect(next?.index).toBe(3);
	});
});

// ── countByStatus ──────────────────────────────────────────────────────────

describe("countByStatus", () => {
	it("counts tasks by status", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "A", status: "TODO" },
				{ index: 2, text: "B", status: "DONE" },
				{ index: 3, text: "C", status: "DONE" },
				{ index: 4, text: "D", status: "BLOCKED" },
			],
		};

		const counts = countByStatus(data);
		expect(counts).toEqual({ TODO: 1, DONE: 2, BLOCKED: 1, UNKNOWN: 0 });
	});

	it("returns zeros for empty plan", () => {
		const data: PlanFileData = { goal: "Empty", tasks: [] };
		const counts = countByStatus(data);
		expect(counts).toEqual({ TODO: 0, DONE: 0, BLOCKED: 0, UNKNOWN: 0 });
	});
});

// ── isPlanComplete ────────────────────────────────────────────────────────

describe("isPlanComplete", () => {
	it("returns false when there are TODO tasks", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Done", status: "DONE" },
				{ index: 2, text: "Todo", status: "TODO" },
			],
		};

		expect(isPlanComplete(data)).toBe(false);
	});

	it("returns true when all tasks are terminal", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "Done", status: "DONE" },
				{ index: 2, text: "Blocked", status: "BLOCKED" },
				{ index: 3, text: "Unknown", status: "UNKNOWN" },
			],
		};

		expect(isPlanComplete(data)).toBe(true);
	});

	it("returns false for empty plan", () => {
		const data: PlanFileData = { goal: "Empty", tasks: [] };
		expect(isPlanComplete(data)).toBe(false);
	});
});

// ── buildSummary ───────────────────────────────────────────────────────────

describe("buildSummary", () => {
	it("builds a summary string", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "A", status: "DONE" },
				{ index: 2, text: "B", status: "DONE" },
				{ index: 3, text: "C", status: "BLOCKED" },
				{ index: 4, text: "D", status: "UNKNOWN" },
			],
		};

		const summary = buildSummary(data);
		expect(summary).toBe("2 DONE, 1 BLOCKED, 1 UNKNOWN");
	});

	it("omits zero counts", () => {
		const data: PlanFileData = {
			goal: "Test",
			tasks: [
				{ index: 1, text: "A", status: "DONE" },
			],
		};

		const summary = buildSummary(data);
		expect(summary).toBe("1 DONE");
	});
});

// ── validatePlanSyntax ─────────────────────────────────────────────────────

describe("validatePlanSyntax", () => {
	it("returns no errors for a valid plan", () => {
		const input = `# Plan: Valid plan

- TODO: First task
- TODO: Second task
- DONE: Third task`;

		const errors = validatePlanSyntax(input);
		expect(errors).toHaveLength(0);
	});

	it("detects missing plan header", () => {
		const input = `- TODO: A task`;

		const errors = validatePlanSyntax(input);
		expect(errors.some((e) => e.includes("Missing plan header"))).toBe(true);
	});

	it("detects no tasks in plan", () => {
		const input = `# Plan: No tasks here

Just some text without tasks.`;

		const errors = validatePlanSyntax(input);
		expect(errors.some((e) => e.includes("No tasks found"))).toBe(true);
	});

	it("accepts valid plan with mixed statuses and reasons", () => {
		const input = `# Plan: Complex plan

- TODO: First task
- DONE: Second task
- BLOCKED: Third task — API down
- UNKNOWN: Fourth task — unclear result`;

		const errors = validatePlanSyntax(input);
		expect(errors).toHaveLength(0);
	});

	it("accepts plan with only DONE tasks", () => {
		const input = `# Plan: All done

- DONE: Task one
- DONE: Task two`;

		const errors = validatePlanSyntax(input);
		expect(errors).toHaveLength(0);
	});
});
