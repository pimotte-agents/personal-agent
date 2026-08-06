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
 *   /plan <goal>        - Create a plan interactively
 *   /plan-execute       - Execute tasks from the plan
 *   /plan-stop          - Stop plan execution
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

// ── Plan file I/O ──────────────────────────────────────────────────────────

function getPlanFilePath(cwd: string): string {
	return join(cwd, PLAN_DIR, PLAN_FILE_NAME);
}

async function readPlan(cwd: string): Promise<PlanFileData | null> {
	try {
		const path = getPlanFilePath(cwd);
		const content = await readFile(path, "utf-8");
		return parsePlan(content);
	} catch {
		return null;
	}
}

async function writePlan(cwd: string, data: PlanFileData): Promise<void> {
	const path = getPlanFilePath(cwd);
	await writeFile(path, serializePlan(data), "utf-8");
}

// ── TUI Widget ─────────────────────────────────────────────────────────────

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

	const lines: string[] = [];
	for (const task of data.tasks) {
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

		lines.push(line);
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

	// ── task_complete tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "task_complete",
		label: "Task Complete",
		description:
			"Signal that the current task is complete. Call this when you have finished executing the assigned task. Use status 'DONE' when the task succeeded. If the task cannot be completed, call ask_question instead (the plan extension will mark it BLOCKED).",
		parameters: Type.Object({
			status: StringEnum(["DONE"] as const),
			summary: Type.Optional(
				Type.String({ description: "Brief summary of what was accomplished" }),
			),
		}),
		promptSnippet:
			"Signal task completion with status DONE during plan execution",
		promptGuidelines: [
			"Use task_complete with status DONE at the end of each task during plan execution to signal completion. Include a brief summary of what was done.",
		],

		async execute(
			_toolCallId,
			params: { status: string; summary?: string },
			_signal,
			_onUpdate,
			_ctx,
		) {
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

	// ── Block ask_question during execution ──────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!exec.running || event.toolName !== "ask_question") return;

		exec.taskBlocked = true;

		const question = ((event.input as any)?.question ??
			"No question text") as string;
		return {
			block: true,
			reason: `[PLAN BLOCKED] Task blocked. Reason: ${question}. The plan extension will mark this task as BLOCKED and proceed to the next task.`,
		};
	});

	// ── Handle task completion at agent_end ──────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!exec.running || exec.stopped || planData === null || savedCwd === null)
			return;

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
		await writePlan(savedCwd, planData);

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
			updateWidget(ctx, planData, null);

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

			const taskContext = `Execute task ${nextTask.index} of ${planData.tasks.length}: ${nextTask.text}

This is part of the plan: "${planData.goal}"
Full plan file: ${PLAN_DIR}/${PLAN_FILE_NAME}

When you have finished this task, call task_complete with status DONE and a brief summary of what was accomplished.
If you need clarification from the user, call ask_question — the plan extension will mark this task as BLOCKED and proceed to the next task.`;

			pi.sendUserMessage(taskContext, { deliverAs: "followUp" });
		}
	});

	// ── /plan command ────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Create a plan using interactive questioning",
		handler: async (args, ctx) => {
			if (!args || !args.trim()) {
				ctx.ui.notify("Usage: /plan <goal>", "error");
				return;
			}

			const goal = args.trim();
			savedCwd = ctx.cwd;

			ctx.ui.notify(`Creating plan for: ${goal}`, "info");

			const planPrompt = `Create a detailed task plan for: ${goal}

Use the ask_question tool to resolve any ambiguities before finalizing the plan. Ask the user questions one at a time if needed.

Once you have all the information you need, create a flat list of tasks. Each task should be a specific, actionable step that can be completed independently.

Format the plan as follows:

# Plan: ${goal.replace(/"/g, '\\"')}

- [ ] TODO: First task description
- [ ] TODO: Second task description
- [ ] TODO: Third task description

Do NOT start executing any tasks — just create the plan.`;

			pi.sendUserMessage(planPrompt);
		},
	});

	// ── Write plan file when plan is created ─────────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		// Only save plan when not in execution mode
		if (exec.running) return;

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
				planData = parsed;
				await writePlan(savedCwd, parsed);
				ctx.ui.notify(`Plan saved: ${parsed.tasks.length} tasks`, "info");
				updateWidget(ctx, parsed, null);
			}
		}
	});

	// ── /plan-execute command ────────────────────────────────────────────

	pi.registerCommand("plan-execute", {
		description: "Execute tasks from the plan file",
		handler: async (_args, ctx) => {
			savedCwd = ctx.cwd;
			const data = await readPlan(ctx.cwd);

			if (!data || data.tasks.length === 0) {
				ctx.ui.notify(
					"No plan found. Create one first with /plan <goal>",
					"error",
				);
				return;
			}

			planData = data;

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

			// Add task_complete to active tools
			const active = pi.getActiveTools();
			if (!active.includes("task_complete")) {
				pi.setActiveTools([
					...new Set([...active, "task_complete"]),
				]);
			}

			// Send marker to establish clean context boundary
			pi.sendMessage(
				{
					customType: "plan-marker",
					content: `--- Task ${nextTask.index} ---`,
					display: false,
				},
				{ triggerTurn: false },
			);

			const taskContext = `Execute task ${nextTask.index} of ${data.tasks.length}: ${nextTask.text}

This is part of the plan: "${data.goal}"
Full plan file: ${PLAN_DIR}/${PLAN_FILE_NAME}

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

			exec.stopped = true;
			exec.running = false;
			exec.currentTaskIndex = null;
			updateWidget(ctx, planData, null);
			ctx.ui.notify("Plan execution stopped", "warning");
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

	// ── Session start: restore widget ────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		savedCwd = ctx.cwd;
		const data = await readPlan(ctx.cwd);

		if (data && ctx.hasUI) {
			planData = data;
			updateWidget(ctx, data, null);
		}
	});
}
