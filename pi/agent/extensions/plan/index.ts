/**
 * Plan extension
 *
 * Creates execution plans using ask_question to resolve ambiguities,
 * writes the plan to .pi/plan.md, and executes tasks in the foreground.
 *
 * Each task gets clean LLM context (history before the task is filtered out),
 * file changes persist in the working directory, and a git commit is made
 * after every task regardless of outcome.
 *
 * Commands:
 *   /plan <goal>           - Create a plan interactively
 *   /plan-execute [<f.md>] - Execute tasks from the plan
 *   /plan-stop             - Stop plan execution
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	serializePlan,
	parsePlan,
	findNextTask,
	updateTaskStatus,
	buildSummary,
	validatePlanSyntax,
	type PlanFileData,
	type TaskStatus,
	PLAN_FILE_NAME,
	PLAN_DIR,
} from "./plan-file.js";
import {
	commitTask,
	filterTaskContext,
	resolveTaskOutcome,
} from "./execution.js";

// ── State ──────────────────────────────────────────────────────────────────

interface ExecutionState {
	running: boolean;
	stopped: boolean;       // user pressed escape / ran /plan-stop
	currentTaskIndex: number | null;
	taskCompleted: boolean;   // task_complete was called in current run
	taskBlocked: boolean;     // ask_question was blocked in current run
}

/** Track the target plan file (filename, e.g. "plan.md" or "FEATURE.md") */
let planFileName: string | null = null;

/** Flag: waiting for the LLM to fix plan syntax errors */
let awaitingPlanFix: boolean = false;

// ── Plan file I/O ──────────────────────────────────────────────────────────

function getPlanFilePath(cwd: string, fileName?: string): string {
	const name = fileName ?? planFileName ?? PLAN_FILE_NAME;
	return join(cwd, PLAN_DIR, name);
}

/**
 * Parse /plan arguments.
 * If the first word ends with .md, treat it as the target plan file.
 * The rest is the goal.
 */
function parsePlanArgs(args: string): { fileName: string; goal: string } {
	const trimmed = args.trim();
	const firstWord = trimmed.split(/\s+/)[0];

	if (firstWord.endsWith(".md")) {
		const goal = trimmed.slice(firstWord.length).trim();
		if (!goal) {
			return { fileName: firstWord, goal: firstWord.replace(/\.md$/i, "").trim() };
		}
		return { fileName: firstWord, goal };
	}

	return { fileName: PLAN_FILE_NAME, goal: trimmed };
}

async function readPlan(cwd: string, fileName?: string): Promise<PlanFileData | null> {
	try {
		const path = getPlanFilePath(cwd, fileName);
		const content = await readFile(path, "utf-8");
		return parsePlan(content);
	} catch {
		return null;
	}
}

async function writePlan(cwd: string, data: PlanFileData, fileName?: string): Promise<void> {
	const path = getPlanFilePath(cwd, fileName);
	await writeFile(path, serializePlan(data), "utf-8");
}

// ── TUI Widget ─────────────────────────────────────────────────────────────

const PLAN_WIDGET_VISIBLE = 5;

function renderPlanWidget(
	data: PlanFileData | null,
	currentTaskIndex: number | null,
	theme: NonNullable<
		Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]
	> extends (result: any, options: any, theme: infer T, ctx: any) => any
		? T
		: never,
): string[] | null {
	if (!data || data.tasks.length === 0) return null;

	const iconMap: Record<TaskStatus, string> = {
		TODO: "○",
		DONE: "✓",
		BLOCKED: "!",
		UNKNOWN: "?",
	};

	const colorMap: Record<
		TaskStatus,
		"text" | "success" | "error" | "warning" | "muted"
	> = {
		TODO: "text",
		DONE: "success",
		BLOCKED: "error",
		UNKNOWN: "warning",
	};

	/** Render a single task into a styled string. */
	function renderTask(task: { index: number; text: string; status: TaskStatus; reason?: string }): string {
		const icon = iconMap[task.status];
		const color = colorMap[task.status];
		const isActive = task.index === currentTaskIndex;

		const prefix = isActive
			? theme.fg("accent", `>${icon} `)
			: theme.fg(color, `${icon}  `);

		let line =
			prefix +
			theme.fg(color === "success" ? "muted" : color, task.text);

		if (task.reason) {
			line += theme.fg("dim", ` (${task.reason})`);
		}

		return line;
	}

	const totalTasks = data.tasks.length;
	if (totalTasks <= PLAN_WIDGET_VISIBLE) {
		// Few enough tasks to show all
		return data.tasks.map(renderTask);
	}

	// Determine the center of the visible window.
	// Center on the current task when one is active; otherwise center on the middle task.
	const centerIdx = currentTaskIndex !== null
		? data.tasks.findIndex((t) => t.index === currentTaskIndex)
		: Math.floor(totalTasks / 2);

	// Half-window on each side of center
	const half = Math.floor(PLAN_WIDGET_VISIBLE / 2);
	let startIdx = centerIdx - half;

	// Clamp: don't let the window go off the top edge
	if (startIdx < 0) startIdx = 0;

	// Clamp: don't let the window go off the bottom edge
	let endIdx = startIdx + PLAN_WIDGET_VISIBLE;
	if (endIdx > totalTasks) {
		endIdx = totalTasks;
		startIdx = endIdx - PLAN_WIDGET_VISIBLE;
		if (startIdx < 0) startIdx = 0;
	}

	const visibleTasks = data.tasks.slice(startIdx, endIdx);

	const lines: string[] = [];
	if (startIdx > 0) {
		lines.push(theme.fg("dim", `... (${startIdx} more above)`));
	}
	lines.push(...visibleTasks.map(renderTask));
	if (endIdx < totalTasks) {
		lines.push(theme.fg("dim", `... (${totalTasks - endIdx} more below)`));
	}

	return lines;
}

function updateWidget(
	ctx: ExtensionContext,
	data: PlanFileData | null,
	currentTaskIndex: number | null,
): void {
	if (!ctx.hasUI) return;

	const lines = renderPlanWidget(data, currentTaskIndex, ctx.ui.theme);
	if (lines) {
		ctx.ui.setWidget("plan-tasks", lines);
	} else {
		ctx.ui.setWidget("plan-tasks", undefined);
	}
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let exec: ExecutionState = {
		running: false,
		stopped: false,
		currentTaskIndex: null,
		taskCompleted: false,
		taskBlocked: false,
	};
	let planData: PlanFileData | null = null;
	let savedCwd: string | null = null;

	/**
	 * Finalize the current task: resolve outcome, update plan file, git commit.
	 * Used by both agent_end (normal flow) and plan-stop (forced stop).
	 */
	async function finalizeTask(ctx: ExtensionContext, forceStopped?: boolean): Promise<string> {
		if (planData === null || savedCwd === null || exec.currentTaskIndex === null) {
			return "no task to finalize";
		}

		const task = planData.tasks.find(
			(t) => t.index === exec.currentTaskIndex,
		);
		if (!task) return "task not found";

		let outcome: { status: TaskStatus; reason?: string };
		if (forceStopped) {
			outcome = {
				status: "UNKNOWN",
				reason: "Execution stopped by user",
			};
		} else {
			const branch = ctx.sessionManager.getBranch();
			outcome = resolveTaskOutcome(
				exec.taskCompleted,
				exec.taskBlocked,
				branch as any,
			);
		}

		// Update plan data and write to file
		updateTaskStatus(planData, exec.currentTaskIndex, outcome.status, outcome.reason);
		await writePlan(savedCwd, planData, planFileName ?? undefined);

		// Git commit
		const commitResult = await commitTask(
			{ exec: pi.exec.bind(pi) },
			savedCwd,
			task.index,
			task.text,
			outcome.status,
		);

		// Update widget
		updateWidget(ctx, planData, exec.currentTaskIndex);

		// Reset turn-level flags
		exec.taskCompleted = false;
		exec.taskBlocked = false;

		return commitResult;
	}

	// ── task_complete tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "task_complete",
		label: "Task Complete",
		description:
			"Signal that the current task is complete. Only use this tool while actively executing a plan (after /plan-execute). Call this when you have finished executing the assigned task. Use status 'DONE' when the task succeeded. If the task cannot be completed, call ask_question instead (the plan extension will mark it BLOCKED). If a plan is not running, this tool has no effect.",
		parameters: Type.Object({
			status: StringEnum(["DONE"] as const),
			summary: Type.Optional(
				Type.String({ description: "Brief summary of what was accomplished" }),
			),
		}),
		promptSnippet:
			"Signal task completion with status DONE during plan execution",
		promptGuidelines: [
			"Only call task_complete while actively executing a plan (after /plan-execute). Do not call it when no plan is running.",
			"Use task_complete with status DONE at the end of each task during plan execution to signal completion. Include a brief summary of what was done.",
			"Do NOT use ask_question during plan execution — use task_complete instead when the task is done.",
			"If you need user clarification, mark the task as BLOCKED by calling ask_question (it will be auto-blocked).",
		],

		defaultActive: true,
		async execute(
			_toolCallId,
			params: { status: string; summary?: string },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!exec.running) {
				return {
					content: [{ type: "text", text: "Not in plan mode. Use /plan-execute to start." }],
				};
			}
			exec.taskCompleted = true;
			return {
				content: [
					{
						type: "text",
						text: params.summary
							? `Task marked DONE: ${params.summary}`
							: "Task marked DONE",
					},
				],
				details: { status: params.status, summary: params.summary },
			};
		},

		renderCall(args: any, theme: any, _context: any) {
			return new Text(
				theme.fg("toolTitle", theme.bold("task_complete ")) +
					theme.fg("success", args.status) +
					(args.summary
						? theme.fg("dim", ` — ${args.summary}`)
						: ""),
				0,
				0,
			);
		},

		renderResult(result: any, _options: any, theme: any, _context: any) {
			const text = result.content?.[0];
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg(
						"muted",
						text?.type === "text" ? text.text : "Done",
					),
				0,
				0,
			);
		},
	});

	// ── Context filtering: clean slate per task ──────────────────────────

	pi.on("context", async (event) => {
		const filtered = filterTaskContext(
			event.messages as Array<{ customType?: string }>,
			exec.running,
		);
		if (filtered) return { messages: filtered };
		return undefined;
	});

	// ── ask_question interceptor ─────────────────────────────────────────
	// During execution: block it (marks task BLOCKED)

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "ask_question") return;

		if (!exec.running) return;

		const input = event.input as {
			question?: string;
			options?: Array<{ title: string; description?: string }>;
			multiSelect?: boolean;
		} | undefined;

		exec.taskBlocked = true;

		const question = (input?.question ??
			"No question text") as string;
		return {
			block: true,
			reason: `[PLAN BLOCKED] Task blocked. Reason: ${question}. The plan extension will mark this task as BLOCKED and proceed to the next task.

IMPORTANT: Do not keep calling ask_question — you are in an infinite loop. Instead:
- If the task is complete, call task_complete with status DONE
- If you truly need user input, this will be your last ask_question call before the task is marked BLOCKED`,
		};
	});

	// ── Handle task completion at agent_end ──────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!exec.running || planData === null || savedCwd === null)
			return;

		// Handle stop requested during this turn
		if (exec.stopped) {
			exec.stopped = false; // reset for any future execution
			const commitResult = await finalizeTask(ctx, true);
			exec.running = false;
			exec.currentTaskIndex = null;
			updateWidget(ctx, null, null);

			const summary = buildSummary(planData);
			pi.sendUserMessage(
				`Plan execution stopped. Current status: ${summary}. ${
					commitResult !== "committed"
						? `(Note: git commit: ${commitResult})`
						: ""
				} Please review the results and let me know if you need anything else.`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// --- Normal task completion flow ---
		if (exec.currentTaskIndex === null) return;

		const task = planData.tasks.find(
			(t) => t.index === exec.currentTaskIndex,
		);
		if (!task) return;

		// Determine outcome
		const branch = ctx.sessionManager.getBranch();
		const outcome = resolveTaskOutcome(
			exec.taskCompleted,
			exec.taskBlocked,
			branch as any,
		);

		// Update plan data and write to file
		updateTaskStatus(planData, exec.currentTaskIndex, outcome.status, outcome.reason);
		await writePlan(savedCwd, planData, planFileName ?? undefined);

		// Git commit
		const commitResult = await commitTask(
			{ exec: pi.exec.bind(pi) },
			savedCwd,
			task.index,
			task.text,
			outcome.status,
		);

		// Update widget
		updateWidget(ctx, planData, exec.currentTaskIndex);

		// Reset turn-level flags
		exec.taskCompleted = false;
		exec.taskBlocked = false;

		// Check if there are more tasks
		const nextTask = findNextTask(planData);

		if (!nextTask) {
			// All tasks complete — show summary
			exec.running = false;
			exec.currentTaskIndex = null;
			updateWidget(ctx, null, null);

			const summary = buildSummary(planData);
			const summaryMsg = `**Plan execution complete**\n\n${summary}`;

			pi.sendMessage(
				{
					customType: "plan-summary",
					content: summaryMsg,
					display: true,
				},
				{ triggerTurn: false },
			);

			pi.sendUserMessage(
				`Plan execution complete: ${summary}. ${
					commitResult !== "committed"
						? `(Note: final git commit: ${commitResult})`
						: ""
				} Please review the results and let me know if you need anything else.`,
				{ deliverAs: "followUp" },
			);
		} else {
			// Send marker to establish clean context boundary for the next task
			pi.sendMessage(
				{
					customType: "plan-marker",
					content: `--- Task ${nextTask.index} ---`,
					display: false,
				},
				{ triggerTurn: false },
			);

			// Execute next task
			exec.currentTaskIndex = nextTask.index;
			updateWidget(ctx, planData, nextTask.index);

			const planFile = planFileName ?? PLAN_FILE_NAME;
			const taskContext = `Execute task ${nextTask.index} of ${planData.tasks.length}: ${nextTask.text}

This is part of the plan: "${planData.goal}"
Full plan file: ${PLAN_DIR}/${planFile}

When you have finished this task, call task_complete with status DONE and a brief summary of what was accomplished.
If you need clarification from the user, call ask_question — the plan extension will mark this task as BLOCKED and proceed to the next task.`;

			pi.sendUserMessage(taskContext, { deliverAs: "followUp" });
		}
	});

	// ── /plan command ────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Create a plan using interactive questioning. Usage: /plan [<file.md>] <goal>",
		handler: async (args, ctx) => {
			if (!args || !args.trim()) {
				ctx.ui.notify("Usage: /plan [<file.md>] <goal>", "error");
				return;
			}

			const { fileName, goal } = parsePlanArgs(args);
			savedCwd = ctx.cwd;
			planFileName = fileName;
			awaitingPlanFix = false;

			ctx.ui.notify(
				fileName === PLAN_FILE_NAME
					? `Creating plan for: ${goal}`
					: `Creating plan for: ${goal} -> ${PLAN_DIR}/${fileName}`,
				"info",
			);

			const existingPlan = await readPlan(ctx.cwd, planFileName ?? undefined);

			let planPrompt: string;
			if (existingPlan && existingPlan.tasks.length > 0) {
				ctx.ui.notify(`Updating existing plan (${existingPlan.tasks.length} tasks)`, "info");

				planPrompt = `Update the task plan with the following instructions: ${goal}

The existing plan is stored at: ${PLAN_DIR}/${fileName}

Use the ask_question tool to resolve any ambiguities before finalizing the plan. Ask the user questions one at a time if needed.

Read the existing plan file, then create a flat list of tasks. Each task should be a specific, actionable step that can be completed independently. Modify, add, or reorder tasks as needed based on the new instructions.

Format the plan as follows:

# Plan: ${goal.replace(/"/g, '\\"')}

- TODO: First task description
- TODO: Second task description
- TODO: Third task description

Beyond TODO, valid task labels are DONE, UNKNOWN and BLOCKED. Only BLOCKED and UNKNOWN tasks may carry a reason, written after the LAST — separator (“ — ”); TODO/DONE descriptions may contain emdashes and colons freely.

Do NOT start executing any tasks — just update the plan.`;
			} else {
				planPrompt = `Create a detailed task plan for: ${goal}

The plan should be saved to: ${PLAN_DIR}/${fileName}

Use the ask_question tool to resolve any ambiguities before finalizing the plan. Ask the user questions one at a time if needed.

Once you have all the information you need, create a flat list of tasks. Each task should be a specific, actionable step that can be completed independently.

Format the plan as follows:

# Plan: ${goal.replace(/"/g, '\\"')}

- TODO: First task description
- TODO: Second task description
- TODO: Third task description

Only BLOCKED and UNKNOWN tasks may carry a reason, written after the LAST — separator (“ — ”); task descriptions may contain emdashes and colons freely.

Do NOT start executing any tasks — just create the plan.`;
			}

			await pi.sendUserMessage(planPrompt);
		},
	});

	// ── Write plan file when plan is created ─────────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		// Only save plan when not in execution mode
		if (exec.running) return;

		// If we're fixing syntax, don't re-validate — just save normally
		if (awaitingPlanFix) {
			awaitingPlanFix = false;

			const message = event.message;
			if (message && (message as any).role === "assistant") {
				const contentBlocks = (message as any).content;
				if (Array.isArray(contentBlocks)) {
					const textContent = contentBlocks
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text)
						.join("\n");

					if (textContent.includes("# Plan:")) {
						const parsed = parsePlan(textContent);
						if (parsed.tasks.length > 0 && savedCwd) {
							// Re-validate after fix attempt
							const fixErrors = validatePlanSyntax(textContent);
							if (fixErrors.length > 0) {
								awaitingPlanFix = true;
								ctx.ui.notify("Plan syntax still has errors, requesting fix...", "warning");

								const fixPrompt = `Your plan still has syntax errors:

${fixErrors.map((e) => "- " + e).join("\n")}

Please rewrite the plan with correct formatting.

Required format:
# Plan: <goal>

- TODO: Task description
- TODO: Task description
- DONE: Completed task description
- BLOCKED: Blocked task description — reason
- UNKNOWN: Unknown status task description — reason

Rules:
- Header must be: # Plan: <goal>
- Each task must have: - STATUS: description
- Valid statuses: TODO, DONE, BLOCKED, UNKNOWN
- Every task must have a non-empty description
- TODO/DONE descriptions may contain colons and emdashes freely
- Only BLOCKED and UNKNOWN tasks may carry a reason: the text after the LAST — separator (“ — ”) on the line`;

								await pi.sendUserMessage(fixPrompt, { deliverAs: "followUp" });
								return;
							}
						}

						planData = parsed;
						await writePlan(savedCwd, parsed, planFileName ?? undefined);
						ctx.ui.notify(`Plan saved: ${parsed.tasks.length} tasks`, "info");
					}
				}
			}
			return;
		}

		const message = event.message;
		if (!message || (message as any).role !== "assistant") return;

		const contentBlocks = (message as any).content;
		if (!Array.isArray(contentBlocks)) return;

		const textContent = contentBlocks
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");

		// Check if this looks like a plan (has "# Plan:" header and TODO items)
		if (textContent.includes("# Plan:") && textContent.includes("TODO:")) {
			const parsed = parsePlan(textContent);
			if (parsed.tasks.length > 0 && savedCwd) {
				// Run syntax validation
				const errors = validatePlanSyntax(textContent);
				if (errors.length > 0) {
					awaitingPlanFix = true;
					ctx.ui.notify("Plan has syntax errors, requesting fix...", "warning");

					const fixPrompt = `Your plan has syntax errors that need to be fixed:

${errors.map((e) => "- " + e).join("\n")}

Please rewrite the plan with correct formatting.

Required format:
# Plan: <goal>

- TODO: Task description
- TODO: Task description
- DONE: Completed task description
- BLOCKED: Blocked task description — reason
- UNKNOWN: Unknown status task description — reason

Rules:
- Header must be: # Plan: <goal>
- Each task must have: - STATUS: description
- Valid statuses: TODO, DONE, BLOCKED, UNKNOWN
- Every task must have a non-empty description
- TODO/DONE descriptions may contain colons and emdashes freely
- Only BLOCKED and UNKNOWN tasks may carry a reason: the text after the LAST — separator (“ — ”) on the line`;

					await pi.sendUserMessage(fixPrompt, { deliverAs: "followUp" });
					return;
				}

				planData = parsed;
				await writePlan(savedCwd, parsed, planFileName ?? undefined);
				ctx.ui.notify(`Plan saved: ${parsed.tasks.length} tasks`, "info");
			}
		}
	});

	// ── /plan-execute command ────────────────────────────────────────────

	// Parse optional file argument for /plan-execute (just the .md filename)
	function parseExecuteArgs(args: string | undefined): string | null {
		if (!args || !args.trim()) return null;
		const name = args.trim();
		if (!name.endsWith(".md")) return null;
		return name;
	}

	pi.registerCommand("plan-execute", {
		description: "Execute tasks from the plan file. Usage: /plan-execute [<file.md>]",
		handler: async (args, ctx) => {
			savedCwd = ctx.cwd;
			const explicitFile = parseExecuteArgs(args);
			const targetFile = explicitFile ?? planFileName;
			const data = await readPlan(ctx.cwd, targetFile ?? undefined);

			if (!data || data.tasks.length === 0) {
				ctx.ui.notify(
					"No plan found. Create one first with /plan <goal>",
					"error",
				);
				return;
			}

			// Use explicit file if provided, otherwise keep existing planFileName
			if (explicitFile) {
				planFileName = explicitFile;
			}
			planData = data;

			const displayPlanFile = targetFile ?? PLAN_FILE_NAME;
			ctx.ui.notify(
				`Executing plan: ${PLAN_DIR}/${displayPlanFile} (${data.tasks.length} tasks)`,
				"info",
			);

			const nextTask = findNextTask(data);
			if (!nextTask) {
				ctx.ui.notify("All tasks are complete!", "info");
				return;
			}

			// Start execution
			exec = {
				running: true,
				stopped: false,
				currentTaskIndex: nextTask.index,
				taskCompleted: false,
				taskBlocked: false,
			};

			updateWidget(ctx, data, nextTask.index);

			// task_complete is always active (defaultActive: true)
			// No need to enable/disable it

			// Send marker to establish clean context boundary
			pi.sendMessage(
				{
					customType: "plan-marker",
					content: `--- Task ${nextTask.index} ---`,
					display: false,
				},
				{ triggerTurn: false },
			);

			const planFile = planFileName ?? PLAN_FILE_NAME;
			const taskContext = `Execute task ${nextTask.index} of ${data.tasks.length}: ${nextTask.text}

This is part of the plan: "${data.goal}"
Full plan file: ${PLAN_DIR}/${planFile}

When you have finished this task, call task_complete with status DONE and a brief summary of what was accomplished.
If you need clarification from the user, call ask_question — the plan extension will mark this task as BLOCKED and proceed to the next task.`;

			pi.sendUserMessage(taskContext);
		},
	});

	// ── /plan-stop command ───────────────────────────────────────────────

	pi.registerCommand("plan-stop", {
		description: "Stop plan execution",
		handler: async (_args, ctx) => {
			if (!exec.running) {
				ctx.ui.notify("No plan execution in progress", "info");
				return;
			}

			// Signal agent_end to finalize the current task on next turn
			exec.stopped = true;
			ctx.ui.notify("Plan execution stopped (finalizing current task...)", "warning");
		},
	});

	// ── Entry renderer for plan summary ──────────────────────────────────

	pi.registerEntryRenderer(
		"plan-summary",
		(entry: any, { expanded }: any, theme: any) => {
			const box = new Container();
			const text =
				(entry.data as { content?: string } | undefined)?.content ??
				(entry.content as string) ??
				"Plan complete";

			box.addChild(
				new Text(theme.fg("accent", theme.bold(" Plan Results ")), 1, 0),
			);
			box.addChild(new Text(text, 1, 0));
			return box;
		},
	);

	// ── Session start: restore plan data, ensure task_complete is disabled ────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		savedCwd = ctx.cwd;
		const data = await readPlan(ctx.cwd);

		if (data) {
			planData = data;
		}

		// task_complete is always active but guards with exec.running check
	});
}
