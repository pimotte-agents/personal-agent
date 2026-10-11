import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	buildCommitMessage,
	buildTaskMessage,
	changedSince,
	commitTask,
	extractBlockedReason,
	filterTaskContext,
	parsePorcelainZ,
	resolveTaskOutcome,
	runHook,
	snapshotDirty,
	stashPaths,
	tailText,
	type GitExec,
	type SessionBranchEntry,
	type ContextMessage,
} from "../execution.js";

type Call = { cmd: string; args: string[] };
type Reply = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): Reply => ({ code, stdout: "", stderr });

/** An executor that records calls and answers with `fn` (default: success). */
function mockExec(fn: (cmd: string, args: string[]) => Reply = () => ok()): {
	executor: GitExec;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		executor: {
			exec: vi.fn(async (cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return fn(cmd, args);
			}),
		},
	};
}

// ── commitTask ─────────────────────────────────────────────────────────────

describe("commitTask", () => {
	it("stages and commits exactly the given paths, never add -A without pathspec", async () => {
		const { executor, calls } = mockExec((cmd, args) =>
			args[0] === "diff" ? fail() : ok(),
		);
		const result = await commitTask(executor, "/p", ["a.lean", ".pi/plan.md"], "msg");

		expect(result).toBe("committed");
		expect(calls.map((c) => c.args)).toEqual([
			["status", "--porcelain"],
			["add", "-A", "--", "a.lean", ".pi/plan.md"],
			["diff", "--cached", "--quiet", "--", "a.lean", ".pi/plan.md"],
			["commit", "-m", "msg", "--", "a.lean", ".pi/plan.md"],
		]);
		for (const c of calls) {
			if (c.args[0] === "add") expect(c.args).toContain("--");
		}
	});

	it("returns 'nothing to commit' when the paths have no staged change", async () => {
		const { executor, calls } = mockExec(() => ok());
		expect(await commitTask(executor, "/p", ["a"], "m")).toBe("nothing to commit");
		expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
	});

	it("returns 'nothing to commit' for an empty path list without staging", async () => {
		const { executor, calls } = mockExec();
		expect(await commitTask(executor, "/p", [], "m")).toBe("nothing to commit");
		expect(calls).toHaveLength(1);
	});

	it("returns 'not a git repo' when git status fails", async () => {
		const { executor, calls } = mockExec(() => fail("fatal"));
		expect(await commitTask(executor, "/p", ["a"], "m")).toBe("not a git repo");
		expect(calls).toHaveLength(1);
	});

	it("reports git add and git commit failures", async () => {
		const addFails = mockExec((_c, args) => (args[0] === "add" ? fail("denied") : ok()));
		expect(await commitTask(addFails.executor, "/p", ["a"], "m")).toBe(
			"git add failed: denied",
		);
		const commitFails = mockExec((_c, args) =>
			args[0] === "diff" ? fail() : args[0] === "commit" ? fail("no author") : ok(),
		);
		expect(await commitTask(commitFails.executor, "/p", ["a"], "m")).toBe(
			"git commit failed: no author",
		);
	});

	it("catches exceptions", async () => {
		const executor: GitExec = {
			exec: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		expect(await commitTask(executor, "/p", ["a"], "m")).toBe("git commit error");
	});
});

// ── buildCommitMessage ─────────────────────────────────────────────────────

describe("buildCommitMessage", () => {
	it("keeps a short task on one line", () => {
		expect(buildCommitMessage(3, "Prove foo in A.lean", "DONE")).toBe(
			"plan: task 3 (DONE): Prove foo in A.lean",
		);
	});

	it("truncates a long task to a <=72-char subject and puts the rest in the body", () => {
		const text = `Prove covering_half in UnionClosed/Conjectures/Covering.lean. ${"x".repeat(300)}`;
		const msg = buildCommitMessage(7, text, "PARTIAL", "lemmas proved", "summary here");
		const [subject, ...rest] = msg.split("\n");
		expect(subject.length).toBeLessThanOrEqual(72);
		expect(subject.startsWith("plan: task 7 (PARTIAL): Prove covering_half")).toBe(true);
		expect(subject.endsWith("…")).toBe(true);
		const body = rest.join("\n");
		expect(body).toContain(`Task: ${text}`);
		expect(body).toContain("Reason: lemmas proved");
		expect(body).toContain("Summary: summary here");
	});

	it("does not repeat a summary equal to the reason", () => {
		const msg = buildCommitMessage(1, "t", "BLOCKED", "why", "why");
		expect(msg.match(/why/g)).toHaveLength(1);
	});
});

// ── snapshots ──────────────────────────────────────────────────────────────

describe("parsePorcelainZ", () => {
	it("parses modified, untracked, deleted and renamed entries", () => {
		const out = parsePorcelainZ(
			" M a.lean\0?? dir/new file.lean\0 D gone.lean\0R  new.lean\0old.lean\0",
		);
		expect(out).toEqual([
			{ path: "a.lean", deleted: false },
			{ path: "dir/new file.lean", deleted: false },
			{ path: "gone.lean", deleted: true },
			{ path: "new.lean", deleted: false },
		]);
	});

	it("handles empty output", () => {
		expect(parsePorcelainZ("")).toEqual([]);
	});
});

describe("snapshotDirty", () => {
	it("hashes every dirty file and marks deletions", async () => {
		const { executor } = mockExec((_c, args) => {
			if (args[0] === "status") return ok(" M a\0 D b\0?? c\0");
			if (args[0] === "hash-object") return ok(`hash-${args[2]}\n`);
			return ok();
		});
		const snap = await snapshotDirty(executor, "/p");
		expect(snap && Object.fromEntries(snap)).toEqual({
			a: "hash-a",
			b: "<deleted>",
			c: "hash-c",
		});
	});

	it("returns null outside a git repository", async () => {
		const { executor } = mockExec(() => fail("fatal"));
		expect(await snapshotDirty(executor, "/p")).toBeNull();
	});
});

describe("changedSince", () => {
	it("returns new, modified and reverted files, not unchanged pre-existing dirt", () => {
		const before = new Map([
			["user-wip.md", "h1"], // dirty before, untouched by the task
			["edited.lean", "h2"], // dirty before, edited again by the task
			["reverted.lean", "h3"], // dirty before, reverted by the task
		]);
		const now = new Map([
			["user-wip.md", "h1"],
			["edited.lean", "h2b"],
			["new.lean", "h4"],
		]);
		expect(changedSince(before, now)).toEqual(["edited.lean", "new.lean", "reverted.lean"]);
	});
});

describe("stashPaths", () => {
	it("stashes only the given paths, including untracked ones", async () => {
		const { executor, calls } = mockExec();
		expect(await stashPaths(executor, "/p", ["x.lean"], "label")).toBe(true);
		expect(calls[0].args).toEqual([
			"stash", "push", "--include-untracked", "-m", "label", "--", "x.lean",
		]);
	});

	it("does nothing for no paths and reports failure", async () => {
		const none = mockExec();
		expect(await stashPaths(none.executor, "/p", [], "l")).toBe(true);
		expect(none.calls).toHaveLength(0);
		const bad = mockExec(() => fail());
		expect(await stashPaths(bad.executor, "/p", ["x"], "l")).toBe(false);
	});
});

// ── hooks ──────────────────────────────────────────────────────────────────

describe("runHook", () => {
	it("reports a missing hook without running it", async () => {
		const { executor, calls } = mockExec(() => fail());
		const r = await runHook(executor, "/p", "verify-done", ["a"], 1000);
		expect(r.exists).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ cmd: "test", args: ["-x", ".pi/hooks/verify-done"] });
	});

	it("runs an existing hook and returns its result", async () => {
		const { executor, calls } = mockExec((cmd) =>
			cmd === "test" ? ok() : { code: 1, stdout: "bad.lean\n", stderr: "err" },
		);
		const r = await runHook(executor, "/p", "check-files", ["bad.lean"], 1000);
		expect(r).toEqual({ exists: true, code: 1, stdout: "bad.lean\n", stderr: "err" });
		expect(calls[1]).toEqual({ cmd: ".pi/hooks/check-files", args: ["bad.lean"] });
	});
});

describe("tailText", () => {
	it("keeps short text and the end of long text", () => {
		expect(tailText("  short  ")).toBe("short");
		expect(tailText("abcdefghij", 4)).toBe("…ghij");
	});
});

// ── buildTaskMessage ───────────────────────────────────────────────────────

describe("buildTaskMessage", () => {
	it("starts with the task prompt the context filter keys on", () => {
		const msg = buildTaskMessage({ index: 2, text: "Prove x in A.lean" }, 5, "g", ".pi/p.md");
		expect(msg.startsWith("Execute task 2 of 5: Prove x in A.lean")).toBe(true);
		expect(msg).toContain("Full plan file: .pi/p.md");
		expect(msg).toContain("- PARTIAL:");
		expect(msg).not.toContain("earlier attempt");
	});

	it("passes on the reason of an earlier attempt", () => {
		const msg = buildTaskMessage(
			{ index: 2, text: "t", reason: "7 lemmas proved" },
			5,
			"g",
			".pi/p.md",
		);
		expect(msg).toContain("Outcome of an earlier attempt: 7 lemmas proved");
	});
});

// ── extractBlockedReason ───────────────────────────────────────────────────

describe("extractBlockedReason", () => {
	it("extracts reason from blocked ask_question tool result", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Working..." }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: How should auth work?",
						},
					],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe("How should auth work?");
	});

	it("returns undefined when no blocked tool result exists", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: "file content" }],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBeUndefined();
	});

	it("returns undefined when ask_question is not an error", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: false,
					content: [
						{ type: "text", text: "[PLAN BLOCKED] Task blocked. Reason: test" },
					],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBeUndefined();
	});

	it("finds the most recent blocked result", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: old reason",
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: newer reason",
						},
					],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe("newer reason");
	});

	it("handles multiline reason text", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: Could not find docs.\nPlease provide a link.",
						},
					],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe("Could not find docs.\nPlease provide a link.");
	});

	it("strips the interceptor boilerplate after the question", () => {
		// The tool_call handler in index.ts appends this exact tail after the
		// question; only the question itself may become the blocked reason.
		const text =
			// Real interceptor format: the handler appends ". The plan extension …"
		// (its own period) after the question, then the IMPORTANT block.
		"[PLAN BLOCKED] Task blocked. Reason: Task 6's design-note update references the new example — how should I proceed?. The plan extension will mark this task as BLOCKED and proceed to the next task.\n\nIMPORTANT: Do not keep calling ask_question — you are in an infinite loop. Instead:\n- If the task is complete, call task_complete with status DONE\n- If you truly need user input, this will be your last ask_question call before the task is marked BLOCKED";

		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [{ type: "text", text }],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe(
			"Task 6's design-note update references the new example — how should I proceed?",
		);
	});

	it("keeps a multiline question but strips the boilerplate", () => {
		// A question ending in its own period yields ".. The plan extension …"
		// in the raw text; the question's own period must be kept.
		const text =
			"[PLAN BLOCKED] Task blocked. Reason: Could not find the book page.\nPlease provide the source text.. The plan extension will mark this task as BLOCKED and proceed to the next task.\n\nIMPORTANT: Do not keep calling ask_question — you are in an infinite loop.";

		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [{ type: "text", text }],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe("Could not find the book page.\nPlease provide the source text.");
	});

	it("falls back to the first blank line when the suffix is absent", () => {
		// If the interceptor format changes, trailing guidance after a blank
		// line must still be dropped (a single-newline question is kept).
		const text =
			"[PLAN BLOCKED] Task blocked. Reason: Need the reviewer's decision.\nFollow up tomorrow.\n\nSOME OTHER APPENDED NOTE";

		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [{ type: "text", text }],
				},
			},
		];

		const reason = extractBlockedReason(branch);
		expect(reason).toBe("Need the reviewer's decision.\nFollow up tomorrow.");
	});

	it("returns undefined for empty branch", () => {
		const reason = extractBlockedReason([]);
		expect(reason).toBeUndefined();
	});
});

// ── filterTaskContext ──────────────────────────────────────────────────────

describe("filterTaskContext", () => {
	const marker = (n: number): ContextMessage => ({
		role: "custom",
		customType: "plan-marker",
		content: `--- Task ${n} ---`,
	});
	const prompt = (n: number): ContextMessage => ({
		role: "user",
		content: [{ type: "text", text: `Execute task ${n} of 20: do thing ${n}` }],
	});

	it("returns undefined when not running", () => {
		const messages = [marker(1), prompt(1)];
		expect(filterTaskContext(messages, false)).toBeUndefined();
	});

	it("returns undefined when no task prompt exists", () => {
		const messages: ContextMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant" },
		];
		expect(filterTaskContext(messages, true)).toBeUndefined();
	});

	it("keeps the marker and everything from the task prompt onward", () => {
		const messages: ContextMessage[] = [
			{ role: "user", content: "old conversation" },
			{ role: "assistant" },
			marker(2),
			prompt(2),
			{ role: "assistant" },
		];
		const result = filterTaskContext(messages, true);
		expect(result).toEqual(messages.slice(2));
	});

	it("cuts at the LAST task, not the first (context must reset per task)", () => {
		const messages: ContextMessage[] = [
			marker(1),
			prompt(1),
			{ role: "assistant" },
			{ role: "toolResult" },
			marker(2),
			prompt(2),
			{ role: "assistant" },
			marker(3),
			prompt(3),
			{ role: "assistant" },
		];
		const result = filterTaskContext(messages, true);
		expect(result).toEqual(messages.slice(7));
	});

	it("keeps the task prompt when its marker is delivered after it", () => {
		// Observed in session logs: the queued follow-up prompt lands before
		// the marker. Cutting at the marker would drop the task statement.
		const messages: ContextMessage[] = [
			marker(1),
			prompt(1),
			{ role: "assistant" },
			prompt(2),
			marker(2),
			{ role: "assistant" },
		];
		const result = filterTaskContext(messages, true);
		expect(result).toEqual(messages.slice(3));
		expect(result![0]).toBe(messages[3]);
	});

	it("accepts string content in the task prompt", () => {
		const messages: ContextMessage[] = [
			prompt(1),
			{ role: "assistant" },
			{ role: "user", content: "Execute task 2 of 20: next" },
			{ role: "assistant" },
		];
		expect(filterTaskContext(messages, true)).toEqual(messages.slice(2));
	});

	it("does not reset on continue or persist prompts of the same task", () => {
		const messages: ContextMessage[] = [
			marker(4),
			prompt(4),
			{ role: "assistant" },
			{ role: "user", content: "Continue task 4 of 20: do thing 4" },
			{ role: "assistant" },
			{ role: "user", content: "Final attempt for task 4 of 20: do thing 4" },
		];
		expect(filterTaskContext(messages, true)).toEqual(messages);
	});

	it("ignores task-prompt text in non-user messages", () => {
		const messages: ContextMessage[] = [
			prompt(1),
			{ role: "assistant", content: [{ type: "text", text: "Execute task 9 of 20: x" }] },
			{ role: "toolResult", content: [{ type: "text", text: "Execute task 9 of 20: x" }] },
		];
		expect(filterTaskContext(messages, true)).toEqual(messages);
	});

	it("returns undefined when compaction removed the task prompt", () => {
		// The summary is the only record of the task; a stray marker left
		// after it must not cause it to be cut away.
		const messages: Array<ContextMessage & { summary?: string }> = [
			{ role: "compactionSummary", summary: "task 5: did X, next Y" },
			marker(5),
			{ role: "assistant" },
		];
		expect(filterTaskContext(messages, true)).toBeUndefined();
	});

	it("drops a compaction summary of earlier tasks once a new task starts", () => {
		const messages: Array<ContextMessage & { summary?: string }> = [
			{ role: "compactionSummary", summary: "tasks 1-5" },
			{ role: "assistant" },
			marker(6),
			prompt(6),
		];
		expect(filterTaskContext(messages, true)).toEqual(messages.slice(2));
	});
});

// ── resolveTaskOutcome ─────────────────────────────────────────────────────

describe("resolveTaskOutcome", () => {
	it("returns DONE when taskCompleted is true", () => {
		const outcome = resolveTaskOutcome(true, false, []);
		expect(outcome).toEqual({ status: "DONE", reason: undefined });
	});

	it("returns BLOCKED with reason when taskBlocked is true", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: missing API key",
						},
					],
				},
			},
		];

		const outcome = resolveTaskOutcome(false, true, branch);
		expect(outcome).toEqual({
			status: "BLOCKED",
			reason: "missing API key",
		});
	});

	it("returns BLOCKED with undefined reason when no blocked message found", () => {
		const outcome = resolveTaskOutcome(false, true, []);
		expect(outcome).toEqual({ status: "BLOCKED", reason: undefined });
	});

	it("returns UNKNOWN when neither completed nor blocked", () => {
		const outcome = resolveTaskOutcome(false, false, []);
		expect(outcome).toEqual({
			status: "UNKNOWN",
			reason:
				"Task completed but outcome was unclear (task_complete was not called)",
		});
	});

	it("prefers DONE over BLOCKED when both flags are set", () => {
		const branch: SessionBranchEntry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "ask_question",
					isError: true,
					content: [
						{
							type: "text",
							text: "[PLAN BLOCKED] Task blocked. Reason: some question",
						},
					],
				},
			},
		];

		const outcome = resolveTaskOutcome(true, true, branch);
		expect(outcome).toEqual({ status: "DONE", reason: undefined });
	});
});
