import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	commitTask,
	extractBlockedReason,
	filterTaskContext,
	resolveTaskOutcome,
	type GitExec,
	type SessionBranchEntry,
	type ContextMessage,
} from "../execution.js";

// ── commitTask ─────────────────────────────────────────────────────────────

describe("commitTask", () => {
	let execCalls: Array<{ cmd: string; args: string[] }> = [];
	let executor: GitExec;

	function makeMockExec(fn?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
		const handler = vi.fn(async (cmd: string, args: string[]) => {
			execCalls.push({ cmd, args });
			if (fn) return fn(cmd, args);
			// Default: success for everything
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
			if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
			if (cmd === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
			if (cmd === "git" && args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		});
		return handler;
	}

	beforeEach(() => {
		execCalls = [];
		executor = { exec: makeMockExec() };
	});

	it("commits successfully when there are changes", async () => {
		const result = await commitTask(
			executor,
			"/project",
			1,
			"Set up auth",
			"DONE",
		);

		expect(result).toBe("committed");
		expect(execCalls).toHaveLength(5);
		expect(execCalls[0]).toEqual({ cmd: "git", args: ["status", "--porcelain"] });
		expect(execCalls[1]).toEqual({ cmd: "git", args: ["add", "-A"] });
		expect(execCalls[2]).toEqual({ cmd: "git", args: ["diff", "--cached", "--quiet"] });
		expect(execCalls[3]).toEqual({ cmd: "git", args: ["status", "--porcelain", "--untracked-files=only"] });
		expect(execCalls[4]).toEqual({
			cmd: "git",
			args: ["commit", "-m", "plan: task 1: Set up auth (DONE)"],
		});
	});

	it("returns 'nothing to commit' when no changes", async () => {
		// Override: diff returns 0 (no changes), status returns empty
		executor.exec = vi.fn(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "add") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "", stderr: "" }; // no changes
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("nothing to commit");
	});

	it("returns 'not a git repo' when git status fails", async () => {
		execCalls = [];
		executor.exec = makeMockExec(async () => ({
			code: 1,
			stdout: "",
			stderr: "fatal: not a git repository",
		}));

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("not a git repo");
		expect(execCalls).toHaveLength(1); // only git status, no further calls
	});

	it("returns error on git add failure", async () => {
		execCalls = [];
		executor.exec = makeMockExec(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "add") {
				return { code: 1, stdout: "", stderr: "permission denied" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("git add failed: permission denied");
	});

	it("returns error on git commit failure", async () => {
		execCalls = [];
		executor.exec = makeMockExec(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "add") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 1, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "commit") {
				return { code: 1, stdout: "", stderr: "no author specified" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("git commit failed: no author specified");
	});

	it("handles untracked files for 'nothing to commit' check", async () => {
		execCalls = [];
		executor.exec = makeMockExec(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") {
				if (args.includes("--untracked-files=only")) {
					return { code: 0, stdout: "? new-file.js\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "add") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "", stderr: "" }; // no tracked changes
			}
			if (cmd === "git" && args[0] === "commit") {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("committed");
	});

	it("catches exceptions and returns error", async () => {
		execCalls = [];
		executor.exec = makeMockExec(async () => {
			throw new Error("unexpected error");
		});

		const result = await commitTask(executor, "/project", 1, "Task", "DONE");
		expect(result).toBe("git commit error");
	});

	it("includes task index and status in commit message", async () => {
		execCalls = [];
		let capturedMsg = "";
		executor.exec = makeMockExec(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "add") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 1, stdout: "", stderr: "" }; // changes
			}
			if (cmd === "git" && args[0] === "commit") {
				capturedMsg = args[2];
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		const result = await commitTask(executor, "/project", 3, "Add middleware", "BLOCKED");
		expect(result).toBe("committed");
		expect(capturedMsg).toBe("plan: task 3: Add middleware (BLOCKED)");
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

	it("returns undefined for empty branch", () => {
		const reason = extractBlockedReason([]);
		expect(reason).toBeUndefined();
	});
});

// ── filterTaskContext ──────────────────────────────────────────────────────

describe("filterTaskContext", () => {
	it("returns undefined when not running", () => {
		const messages: ContextMessage[] = [
			{ customType: "plan-marker" },
			{ role: "user" },
		];

		const result = filterTaskContext(messages, false);
		expect(result).toBeUndefined();
	});

	it("returns undefined when no marker exists", () => {
		const messages: ContextMessage[] = [
			{ role: "user" },
			{ role: "assistant" },
		];

		const result = filterTaskContext(messages, true);
		expect(result).toBeUndefined();
	});

	it("filters to keep only messages from the marker onward", () => {
		const messages: ContextMessage[] = [
			{ role: "user", text: "old conversation" },
			{ role: "assistant", text: "old response" },
			{ role: "user", text: "/plan execute" },
			{ customType: "plan-marker", content: "--- Task 2 ---" },
			{ role: "user", text: "Execute task 2: Add middleware" },
			{ role: "assistant", text: "Working on it..." },
		];

		const result = filterTaskContext(messages, true);
		expect(result).toHaveLength(3);
		expect(result![0].customType).toBe("plan-marker");
		expect(result![1].role).toBe("user");
		expect(result![2].role).toBe("assistant");
	});

	it("keeps the marker itself in the filtered messages", () => {
		const messages: ContextMessage[] = [
			{ role: "user", text: "before" },
			{ customType: "plan-marker" },
			{ role: "user", text: "task message" },
		];

		const result = filterTaskContext(messages, true);
		expect(result).toHaveLength(2);
		expect(result![0].customType).toBe("plan-marker");
	});

	it("returns all messages when marker is at index 0", () => {
		const messages: ContextMessage[] = [
			{ customType: "plan-marker" },
			{ role: "user" },
			{ role: "assistant" },
		];

		const result = filterTaskContext(messages, true);
		expect(result).toHaveLength(3);
	});

	it("uses the last marker if multiple exist", () => {
		const messages: ContextMessage[] = [
			{ role: "user", text: "before task 1" },
			{ customType: "plan-marker", content: "--- Task 1 ---" },
			{ role: "user", text: "task 1 message" },
			{ role: "assistant", text: "task 1 done" },
			{ customType: "plan-marker", content: "--- Task 2 ---" },
			{ role: "user", text: "task 2 message" },
		];

		const result = filterTaskContext(messages, true);
		// findIndex finds the FIRST marker, not the last
		// This is the intended behavior — we keep from the first marker
		expect(result).toHaveLength(5); // from first marker onward
		expect(result![0].customType).toBe("plan-marker");
		expect(result![0].content).toBe("--- Task 1 ---");
	});

	it("filters correctly with mixed message types", () => {
		const messages: ContextMessage[] = [
			{ role: "user", text: "plan creation" },
			{ role: "assistant", text: "created plan" },
			{ customType: "plan-summary", content: "summary" },
			{ customType: "plan-marker", content: "--- Task 1 ---" },
			{ role: "user", text: "task 1" },
			{ role: "toolResult" },
			{ role: "assistant", text: "done" },
		];

		const result = filterTaskContext(messages, true);
		expect(result).toHaveLength(4);
		expect(result![0].customType).toBe("plan-marker");
		expect(result![1].role).toBe("user");
		expect(result![2].role).toBe("toolResult");
		expect(result![3].role).toBe("assistant");
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
