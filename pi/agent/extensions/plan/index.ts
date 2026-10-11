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
	MAX_TASK_TEXT_LENGTH,
	type PlanFileData,
	type TaskStatus,
	PLAN_FILE_NAME,
	PLAN_DIR,
} from "./plan-file.js";
import {
	buildCommitMessage,
	buildContinueMessage,
	buildPersistMessage,
	buildTaskMessage,
	changedSince,
	commitTask,
	decideTaskEnd,
	extractBlockedReason,
	filterTaskContext,
	findDeliveredTaskIndex,
	MAX_LENGTH_RETRIES,
	RETRY_COMPACT_PERCENT,
	RETRY_COMPACT_SAFETY_TIMEOUT_MS,
	runHook,
	snapshotDirty,
	stashPaths,
	tailText,
	type DirtySnapshot,
	type SessionBranchEntry,
	type TaskOutcome,
} from "./execution.js";

/** DONE/FALSE claims that fail verification before the task is recorded as PARTIAL. */
const MAX_REJECTED_CLAIMS = 3;
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const CHECK_FILES_TIMEOUT_MS = 30 * 60 * 1000;

/** Plan format rules, shared by the /plan prompts and the syntax-fix prompts. */
const PLAN_FORMAT_RULES = `Required format:
# Plan: <goal>

- TODO: Short task description
- TODO: Prove foo_bar in Path/To/File.lean
- PARTIAL: Short task description
  reason: what was achieved and what is left

Rules:
- Header must be: # Plan: <goal>
- Each task is ONE short line (at most ${MAX_TASK_TEXT_LENGTH} characters): - STATUS: description
- For a proof task use exactly "Prove <name> in <file>" — the extension verifies such tasks.
- Put context, evidence and instructions in a separate notes file and reference it from the task (e.g. "see .pi/notes.md#foo"). Never append notes to a task line; anything that is not a header, task or reason line is dropped when the plan is rewritten.
- Valid statuses: TODO, DONE, PARTIAL, BLOCKED, FALSE, UNKNOWN
- An outcome note goes on an indented "reason:" line directly below its task.`;

// ── State ──────────────────────────────────────────────────────────────────

interface ExecutionState {
	running: boolean;
	stopped: boolean;       // user pressed escape / ran /plan-stop
	currentTaskIndex: number | null;
	taskCompleted: boolean;   // task_complete was called (and accepted) in current run
	completedOutcome?: TaskOutcome; // the status task_complete recorded
	completedSummary?: string; // task_complete's summary, for the commit body
	rejectedClaims: number;   // DONE/FALSE claims that failed verification
	taskBlocked: boolean;     // ask_question was blocked in current run
	lengthRetries: number;    // truncated re-injections used by current task
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
		PARTIAL: "◐",
		BLOCKED: "!",
		FALSE: "¬",
		UNKNOWN: "?",
	};

	const colorMap: Record<
		TaskStatus,
		"text" | "success" | "error" | "warning" | "muted"
	> = {
		TODO: "text",
		DONE: "success",
		PARTIAL: "warning",
		BLOCKED: "error",
		FALSE: "success",
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
		rejectedClaims: 0,
		lengthRetries: 0,
	};
	let planData: PlanFileData | null = null;
	let savedCwd: string | null = null;
	/** Dirty files when the current task started; see snapshotDirty(). */
	let taskSnapshot: DirtySnapshot | null = null;

	const git = { exec: pi.exec.bind(pi) };

	/** Record the working tree at the start of a task. */
	async function startTaskSnapshot(): Promise<void> {
		taskSnapshot = savedCwd ? await snapshotDirty(git, savedCwd) : null;
	}

	/** Plan file path relative to the project root, for staging. */
	function planRelPath(): string {
		return `${PLAN_DIR}/${planFileName ?? PLAN_FILE_NAME}`;
	}

	/**
	 * Finalize the current task with the given outcome: check that the files
	 * the task changed compile (stashing the ones that do not), update the
	 * plan file, commit exactly those files, reset turn-level flags. Used by
	 * agent_end (advance/stop) and plan-stop (forced stop).
	 */
	async function finalizeTask(
		ctx: ExtensionContext,
		outcome: { status: TaskStatus; reason?: string },
	): Promise<string> {
		if (planData === null || savedCwd === null || exec.currentTaskIndex === null) {
			return "no task to finalize";
		}

		const task = planData.tasks.find(
			(t) => t.index === exec.currentTaskIndex,
		);
		if (!task) return "task not found";

		let status = outcome.status;
		const notes: string[] = outcome.reason ? [outcome.reason] : [];

		// Files this task touched. Without a snapshot (extension reloaded
		// mid-task) every dirty file counts — the old behaviour.
		const now = await snapshotDirty(git, savedCwd);
		const planPath = planRelPath();
		let changed = now
			? changedSince(taskSnapshot ?? new Map(), now).filter((f) => f !== planPath)
			: [];

		// Do not commit files that fail to compile: stash them instead.
		if (changed.length > 0) {
			if (ctx.hasUI) ctx.ui.notify(`Checking ${changed.length} changed file(s)...`, "info");
			const check = await runHook(git, savedCwd, "check-files", changed, CHECK_FILES_TIMEOUT_MS);
			if (check.exists && check.code !== 0) {
				const failing = check.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => changed.includes(l));
				const label = `plan task ${task.index}: does not compile`;
				if (failing.length > 0 && (await stashPaths(git, savedCwd, failing, label))) {
					notes.push(`${failing.join(", ")} did not compile; stashed as "${label}" (git stash list)`);
				} else if (failing.length > 0) {
					notes.push(`${failing.join(", ")} did not compile; stash failed, left uncommitted in the working tree`);
				} else {
					notes.push(`check-files failed without naming a file: ${tailText(check.stdout + check.stderr, 300)}`);
				}
				changed = changed.filter((f) => !failing.includes(f));
				if (status === "DONE" || status === "FALSE") status = "PARTIAL";
			}
		}

		const reason = notes.join("; ") || undefined;
		updateTaskStatus(planData, exec.currentTaskIndex, status, reason);
		await writePlan(savedCwd, planData, planFileName ?? undefined);

		const commitResult = await commitTask(
			git,
			savedCwd,
			[...changed, planPath],
			buildCommitMessage(task.index, task.text, status, reason, exec.completedSummary),
		);

		// Update widget
		updateWidget(ctx, planData, exec.currentTaskIndex);

		// Reset turn-level flags
		exec.taskCompleted = false;
		exec.completedOutcome = undefined;
		exec.completedSummary = undefined;
		exec.taskBlocked = false;
		exec.rejectedClaims = 0;
		exec.lengthRetries = 0;

		return commitResult;
	}

	// ── task_complete tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "task_complete",
		label: "Task Complete",
		description:
			"Report the outcome of the current plan task. Only use this tool while actively executing a plan (after /plan-execute). DONE: fully done (checked — a 'Prove X in F' task must compile and X must not depend on sorry; a failed check comes back as an error and the task stays open). PARTIAL: real progress, not finished. FALSE: the statement is false and `declaration` names the proved negation (checked like DONE). BLOCKED: cannot proceed. If a plan is not running, this tool has no effect.",
		parameters: Type.Object({
			status: StringEnum(["DONE", "PARTIAL", "FALSE", "BLOCKED"] as const),
			summary: Type.Optional(
				Type.String({
					description:
						"What was accomplished; for PARTIAL also what is left, for BLOCKED the reason",
				}),
			),
			declaration: Type.Optional(
				Type.String({
					description:
						"Fully qualified name of the theorem that settles the task: required for FALSE (the negation), optional for DONE (defaults to X in 'Prove X in F')",
				}),
			),
		}),
		promptSnippet:
			"Report the outcome of a plan task: DONE, PARTIAL, FALSE or BLOCKED",
		promptGuidelines: [
			"Only call task_complete while actively executing a plan (after /plan-execute). Do not call it when no plan is running.",
			"Call task_complete once at the end of each task with the status that is true: DONE only when the task is fully done, PARTIAL when you made progress but did not finish. Never report partial progress as DONE.",
			"Do NOT use ask_question during plan execution — use task_complete instead.",
			"If you need user clarification, mark the task as BLOCKED by calling ask_question (it will be auto-blocked).",
		],

		async execute(
			_toolCallId,
			params: { status: "DONE" | "PARTIAL" | "FALSE" | "BLOCKED"; summary?: string; declaration?: string },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!exec.running || planData === null || savedCwd === null) {
				return {
					content: [{ type: "text", text: "Not in plan mode. Use /plan-execute to start." }],
					details: {},
				};
			}
			const task = planData.tasks.find((t) => t.index === exec.currentTaskIndex);
			const summary = params.summary?.trim() || undefined;
			let status: TaskStatus = params.status;
			let reason = status === "DONE" ? undefined : summary;

			if (status === "FALSE" && !params.declaration?.trim()) {
				throw new Error(
					"FALSE needs `declaration`: the name of the theorem proving the negation. If you have not proved the negation, report PARTIAL instead.",
				);
			}

			if ((status === "DONE" || status === "FALSE") && task) {
				const check = await runHook(
					git,
					savedCwd,
					"verify-done",
					[params.declaration?.trim() ?? "", task.text],
					VERIFY_TIMEOUT_MS,
				);
				if (check.exists && check.code !== 0) {
					exec.rejectedClaims += 1;
					const why = tailText(check.stdout + check.stderr);
					if (exec.rejectedClaims < MAX_REJECTED_CLAIMS) {
						throw new Error(
							`Verification failed — the task is NOT ${status}:\n${why}\n\nKeep working on it, or call task_complete with status PARTIAL and a summary of what was achieved if you cannot finish.`,
						);
					}
					// Repeated failed claims: record the truth and move on.
					const firstLine = why.split("\n").filter(Boolean).pop() ?? "verification failed";
					reason = `${status} claimed ${exec.rejectedClaims} times, verification failed: ${firstLine}${summary ? `. Summary: ${summary}` : ""}`;
					status = "PARTIAL";
				}
			}

			exec.taskCompleted = true;
			exec.completedOutcome = { status, reason };
			exec.completedSummary = summary;
			return {
				content: [
					{
						type: "text",
						text: `Task marked ${status}${summary ? `: ${summary}` : ""}`,
					},
				],
				details: { status, summary },
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
		const filtered = filterTaskContext(event.messages, exec.running);
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

	pi.on("agent_end", async (event, ctx) => {
		if (!exec.running || planData === null || savedCwd === null)
			return;

		// Handle stop requested during this turn
		if (exec.stopped) {
			exec.stopped = false; // reset for any future execution
			const commitResult = await finalizeTask(ctx, {
				status: "UNKNOWN",
				reason: "Execution stopped by user",
			});
			exec.running = false;
			exec.currentTaskIndex = null;
			exec.lengthRetries = 0;
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

		// --- Task-end decision ---
		if (exec.currentTaskIndex === null) return;

		const task = planData.tasks.find(
			(t) => t.index === exec.currentTaskIndex,
		);
		if (!task) return;

		const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];

		// The last assistant message of the ended run carries the stop reason
		// that decides whether the task is actually done.
		const endedMessages = event.messages as Array<{
			role?: string;
			stopReason?: string;
			usage?: { output?: number };
		}>;
		const lastMessage = endedMessages[endedMessages.length - 1];
		const isAssistant = lastMessage?.role === "assistant";

		const decision = decideTaskEnd({
			deliveredTaskIndex: findDeliveredTaskIndex(branch),
			currentTaskIndex: exec.currentTaskIndex,
			taskCompleted: exec.taskCompleted,
			completedOutcome: exec.completedOutcome,
			taskBlocked: exec.taskBlocked,
			blockedReason: extractBlockedReason(branch),
			stopReason: isAssistant ? (lastMessage.stopReason ?? null) : null,
			lastOutputTokens: isAssistant
				? (lastMessage.usage?.output ?? null)
				: null,
			maxOutputTokens: ctx.model?.maxTokens ?? 0,
			lengthRetries: exec.lengthRetries,
			maxLengthRetries: MAX_LENGTH_RETRIES,
			contextPercent: ctx.getContextUsage()?.percent ?? null,
			compactThresholdPercent: RETRY_COMPACT_PERCENT,
		});

		// The ended run belonged to an earlier task (e.g. pi's overflow
		// recovery re-sent a truncated turn after we had already advanced).
		// Finalize and queue nothing.
		if (decision.kind === "skip") return;

		// Truncated before task_complete: re-inject the same task instead of
		// abandoning unfinished work.
		if (decision.kind === "retry") {
			exec.lengthRetries += 1;
			updateWidget(ctx, planData, exec.currentTaskIndex);
			const continueMsg = decision.final
				? buildPersistMessage(task, planData.tasks.length, planData.goal)
				: buildContinueMessage(
						task,
						planData.tasks.length,
						planData.goal,
						exec.lengthRetries,
					);
			if (decision.final && ctx.hasUI) {
				ctx.ui.notify(
					`Task ${task.index} hit the output limit repeatedly — final attempt to persist partial results...`,
					"warning",
				);
			}
			let queued = false;
			const queueContinue = () => {
				if (queued) return;
				queued = true;
				pi.sendUserMessage(continueMsg, { deliverAs: "followUp" });
			};
			if (decision.compact) {
				// Context is high and pi's own overflow recovery will NOT handle
				// this stop (the output hit the cap exactly), so compact
				// manually before re-injecting. The continue message is queued
				// only once the compaction settles — prompt() refuses to run
				// while a compaction is in progress.
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Context is high — compacting before retrying task ${task.index}...`,
						"warning",
					);
				}
				const safety = setTimeout(queueContinue, RETRY_COMPACT_SAFETY_TIMEOUT_MS);
				(safety as { unref?: () => void }).unref?.();
				ctx.compact({
					customInstructions:
						"Summarize the current plan task in detail: what has been done, which files were read or modified, what remains, and the exact next steps. Keep the task statement and all file paths.",
					onComplete: () => {
						clearTimeout(safety);
						queueContinue();
					},
					onError: (err: Error) => {
						clearTimeout(safety);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Compaction before retrying task ${task.index} failed: ${err.message}`,
								"error",
							);
						}
						queueContinue();
					},
				});
			} else {
				queueContinue();
			}
			return;
		}

		// "advance" or "stop": finalize the current task.
		const commitResult = await finalizeTask(ctx, decision.outcome);

		if (decision.kind === "stop") {
			exec.running = false;
			exec.currentTaskIndex = null;
			exec.lengthRetries = 0;
			updateWidget(ctx, null, null);

			const summary = buildSummary(planData);
			pi.sendUserMessage(
				`Plan execution stopped: task ${task.index} ended without completion (${decision.outcome.reason}). Current status: ${summary}. ${
					commitResult !== "committed"
						? `(Note: git commit: ${commitResult})`
						: ""
				} Review the task, then run /plan-execute again to continue (set the task back to TODO first if you want it re-run).`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// Advance: check if there are more tasks
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
			await startTaskSnapshot();

			pi.sendUserMessage(
				buildTaskMessage(nextTask, planData.tasks.length, planData.goal, planRelPath()),
				{ deliverAs: "followUp" },
			);
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

Format the plan as follows, with the header "# Plan: ${goal.replace(/"/g, '\\"')}".

${PLAN_FORMAT_RULES}

Do NOT start executing any tasks — just update the plan.`;
			} else {
				planPrompt = `Create a detailed task plan for: ${goal}

The plan should be saved to: ${PLAN_DIR}/${fileName}

Use the ask_question tool to resolve any ambiguities before finalizing the plan. Ask the user questions one at a time if needed.

Once you have all the information you need, create a flat list of tasks. Each task should be a specific, actionable step that can be completed independently.

Format the plan as follows, with the header "# Plan: ${goal.replace(/"/g, '\\"')}".

${PLAN_FORMAT_RULES}

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

${PLAN_FORMAT_RULES}`;

								await pi.sendUserMessage(fixPrompt, { deliverAs: "followUp" });
								return;
							}
						}

						// Save only a plan that has tasks: a fix reply without any
						// must not overwrite the plan file with an empty list.
						if (parsed.tasks.length === 0 || !savedCwd) {
							ctx.ui.notify("Plan fix contained no tasks; plan file left unchanged", "warning");
							return;
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

${PLAN_FORMAT_RULES}`;

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
				rejectedClaims: 0,
				lengthRetries: 0,
			};

			updateWidget(ctx, data, nextTask.index);

			// Send marker to establish clean context boundary
			pi.sendMessage(
				{
					customType: "plan-marker",
					content: `--- Task ${nextTask.index} ---`,
					display: false,
				},
				{ triggerTurn: false },
			);

			await startTaskSnapshot();
			pi.sendUserMessage(
				buildTaskMessage(nextTask, data.tasks.length, data.goal, planRelPath()),
			);
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

		// task_complete is active once registered; it checks exec.running itself
	});
}
