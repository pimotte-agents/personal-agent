import { describe, it, expect } from "vitest";
import {
	buildContinueMessage,
	buildPersistMessage,
	decideTaskEnd,
	findDeliveredTaskIndex,
	isPiRecoverableLength,
	MAX_LENGTH_RETRIES,
	RETRY_COMPACT_PERCENT,
	RETRY_COMPACT_SAFETY_TIMEOUT_MS,
	TASK_PROMPT_RE,
	type TaskEndParams,
	type SessionBranchEntry,
} from "../execution.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function userMsg(text: string): SessionBranchEntry {
	return {
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
}

function assistantMsg(text?: string): SessionBranchEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
		},
	};
}

/** Baseline params for decideTaskEnd: a clean, matching, un-signalized run. */
function baseParams(overrides: Partial<TaskEndParams> = {}): TaskEndParams {
	return {
		deliveredTaskIndex: 3,
		currentTaskIndex: 3,
		taskCompleted: false,
		taskBlocked: false,
		stopReason: "stop",
		lastOutputTokens: 100,
		maxOutputTokens: 16384,
		lengthRetries: 0,
		maxLengthRetries: MAX_LENGTH_RETRIES,
		contextPercent: null,
		compactThresholdPercent: RETRY_COMPACT_PERCENT,
		...overrides,
	};
}

// ── findDeliveredTaskIndex ──────────────────────────────────────────────────

describe("findDeliveredTaskIndex", () => {
	it("finds the task index of the last task prompt", () => {
		const branch: SessionBranchEntry[] = [
			userMsg("Execute task 1 of 20: Prove descent"),
			assistantMsg("working..."),
			userMsg("Execute task 4 of 20: Prove fracDeg_two_weightSystem"),
			assistantMsg("more work"),
		];

		expect(findDeliveredTaskIndex(branch)).toBe(4);
	});

	it("matches the prompt format even with trailing instruction lines", () => {
		const branch: SessionBranchEntry[] = [
			userMsg(
				"Execute task 6 of 20: Prove fracDegMin_weightSystem\n\nThis is part of the plan: \"goal\"\nFull plan file: .pi/plan.md",
			),
		];

		expect(findDeliveredTaskIndex(branch)).toBe(6);
	});

	it("ignores continue messages (they must not resolve as task prompts)", () => {
		const branch: SessionBranchEntry[] = [
			userMsg("Execute task 5 of 20: Prove covering_half_minimals"),
			userMsg(
				"Continue task 5 of 20: Prove covering_half_minimals\n\nYour previous response ... was truncated ...",
			),
		];

		// Still 5 — the continue message must not be mistaken for a new prompt.
		expect(findDeliveredTaskIndex(branch)).toBe(5);
	});

	it("returns null when no task prompt exists", () => {
		const branch: SessionBranchEntry[] = [
			assistantMsg("hello"),
			userMsg("just some user text"),
			{ type: "compaction" },
		];

		expect(findDeliveredTaskIndex(branch)).toBeNull();
	});

	it("returns null for an empty branch", () => {
		expect(findDeliveredTaskIndex([])).toBeNull();
	});

	it("ignores non-user messages containing the prompt text", () => {
		const branch: SessionBranchEntry[] = [
			assistantMsg("Execute task 9 of 20: echoed by the model"),
		];

		expect(findDeliveredTaskIndex(branch)).toBeNull();
	});

	it("ignores entries without messages", () => {
		const branch: SessionBranchEntry[] = [{ type: "model_change" }];

		expect(findDeliveredTaskIndex(branch)).toBeNull();
	});

	it("handles user messages without content blocks", () => {
		const branch: SessionBranchEntry[] = [
			{ type: "message", message: { role: "user" } },
			userMsg("Execute task 2 of 5: something"),
		];

		expect(findDeliveredTaskIndex(branch)).toBe(2);
	});

	it("prefers the most recent prompt when several exist", () => {
		const branch: SessionBranchEntry[] = [
			userMsg("Execute task 1 of 3: a"),
			userMsg("Execute task 2 of 3: b"),
			userMsg("unrelated user message"),
			userMsg("Execute task 3 of 3: c"),
		];

		expect(findDeliveredTaskIndex(branch)).toBe(3);
	});
});

// ── isPiRecoverableLength ───────────────────────────────────────────────────

describe("isPiRecoverableLength", () => {
	it("true for a length stop below the output cap (context pressure)", () => {
		expect(isPiRecoverableLength("length", 1363, 16384)).toBe(true);
	});

	it("true for a 1-token truncation (extreme context pressure)", () => {
		expect(isPiRecoverableLength("length", 1, 16384)).toBe(true);
	});

	it("false when the output hit the cap exactly (normal long answer)", () => {
		expect(isPiRecoverableLength("length", 16384, 16384)).toBe(false);
	});

	it("false when the output cap is unknown", () => {
		expect(isPiRecoverableLength("length", 100, 0)).toBe(false);
	});

	it("false when the output count is unknown", () => {
		expect(isPiRecoverableLength("length", null, 16384)).toBe(false);
	});

	it("false for non-length stop reasons", () => {
		expect(isPiRecoverableLength("stop", 100, 16384)).toBe(false);
		expect(isPiRecoverableLength("aborted", 100, 16384)).toBe(false);
		expect(isPiRecoverableLength(null, 100, 16384)).toBe(false);
	});
});

// ── decideTaskEnd ───────────────────────────────────────────────────────────

describe("decideTaskEnd", () => {
	describe("skip guard (run belongs to an earlier task)", () => {
		it("skips when the delivered prompt is an earlier task", () => {
			const decision = decideTaskEnd(
				baseParams({ deliveredTaskIndex: 13, currentTaskIndex: 14 }),
			);
			expect(decision).toEqual({ kind: "skip" });
		});

		it("skips even when a completion flag is set (stale retry of an earlier turn)", () => {
			const decision = decideTaskEnd(
				baseParams({
					deliveredTaskIndex: 13,
					currentTaskIndex: 14,
					taskCompleted: true,
					stopReason: "length",
					lastOutputTokens: 500,
				}),
			);
			expect(decision).toEqual({ kind: "skip" });
		});

		it("skips for any stop reason", () => {
			for (const stopReason of ["stop", "length", "error", "aborted", null]) {
				const decision = decideTaskEnd(
					baseParams({
						deliveredTaskIndex: 1,
						currentTaskIndex: 2,
						stopReason,
					}),
				);
				expect(decision).toEqual({ kind: "skip" });
			}
		});

		it("falls through (no skip) when no prompt was found in the branch", () => {
			const decision = decideTaskEnd(
				baseParams({ deliveredTaskIndex: null, currentTaskIndex: 5 }),
			);
			expect(decision.kind).toBe("advance");
		});
	});

	describe("explicit completion signals", () => {
		it("advances DONE when task_complete was called, even on a clean stop", () => {
			const decision = decideTaskEnd(baseParams({ taskCompleted: true }));
			expect(decision).toEqual({
				kind: "advance",
				outcome: { status: "DONE", reason: undefined },
			});
		});

		it("advances with the status task_complete recorded (PARTIAL, FALSE, BLOCKED)", () => {
			for (const status of ["PARTIAL", "FALSE", "BLOCKED"] as const) {
				const decision = decideTaskEnd(
					baseParams({
						taskCompleted: true,
						completedOutcome: { status, reason: "why" },
					}),
				);
				expect(decision).toEqual({
					kind: "advance",
					outcome: { status, reason: "why" },
				});
			}
		});

		it("advances DONE even when the run was truncated after task_complete", () => {
			const decision = decideTaskEnd(
				baseParams({
					taskCompleted: true,
					stopReason: "length",
					lastOutputTokens: 100,
				}),
			);
			expect(decision).toEqual({
				kind: "advance",
				outcome: { status: "DONE", reason: undefined },
			});
		});

		it("advances DONE even when the run was aborted after task_complete", () => {
			const decision = decideTaskEnd(
				baseParams({ taskCompleted: true, stopReason: "aborted" }),
			);
			expect(decision.kind).toBe("advance");
			expect((decision as any).outcome.status).toBe("DONE");
		});

		it("advances BLOCKED (with reason) when ask_question was intercepted", () => {
			const decision = decideTaskEnd(
				baseParams({ taskBlocked: true, blockedReason: "Which API to use?" }),
			);
			expect(decision).toEqual({
				kind: "advance",
				outcome: { status: "BLOCKED", reason: "Which API to use?" },
			});
		});

		it("prefers DONE over BLOCKED when both flags are set", () => {
			const decision = decideTaskEnd(
				baseParams({ taskCompleted: true, taskBlocked: true }),
			);
			expect((decision as any).outcome.status).toBe("DONE");
		});
	});

	describe("aborted and error stops (no explicit signal)", () => {
		it("stops execution on a user abort instead of queueing the next task", () => {
			const decision = decideTaskEnd(
				baseParams({ stopReason: "aborted" }),
			);
			expect(decision).toEqual({
				kind: "stop",
				outcome: {
					status: "UNKNOWN",
					reason: "Aborted before completion (user interrupt or plan stop)",
				},
			});
		});

		it("stops execution on an error stop", () => {
			const decision = decideTaskEnd(baseParams({ stopReason: "error" }));
			expect(decision.kind).toBe("stop");
			expect((decision as any).outcome.status).toBe("UNKNOWN");
			expect((decision as any).outcome.reason).toContain("error");
		});
	});

	describe("truncated (length) stops without explicit signal", () => {
		it("retries (re-injects) the task within the retry budget", () => {
			const decision = decideTaskEnd(
				baseParams({ stopReason: "length", lastOutputTokens: 100 }),
			);
			expect(decision).toEqual({ kind: "retry", compact: false });
		});

		it("requests compaction when context is high and the stop is NOT pi-recoverable (output hit the cap)", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 16384, // == cap → pi will not handle it
					contextPercent: 92,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: true });
		});

		it("does NOT request compaction when context is high but pi's overflow recovery will handle it (output below cap)", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 1363, // below cap → pi compacts+retries
					contextPercent: 92,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: false });
		});

		it("does NOT request compaction when context usage is below the threshold", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 16384,
					contextPercent: 50,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: false });
		});

		it("does NOT request compaction when context usage is unknown", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 16384,
					contextPercent: null,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: false });
		});

		it("compacts at exactly the threshold percent", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 16384,
					contextPercent: RETRY_COMPACT_PERCENT,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: true });
		});

		it("does not compact below the threshold", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 16384,
					contextPercent: RETRY_COMPACT_PERCENT - 1,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: false });
		});

		it("issues the final (persist) retry when the retry budget is exhausted", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 100,
					lengthRetries: MAX_LENGTH_RETRIES,
				}),
			);
			expect(decision).toEqual({ kind: "retry", compact: false, final: true });
		});

		it("advances as UNKNOWN (truncated) only after the final persist attempt is also truncated", () => {
			const decision = decideTaskEnd(
				baseParams({
					stopReason: "length",
					lastOutputTokens: 100,
					lengthRetries: MAX_LENGTH_RETRIES + 1,
				}),
			);
			expect(decision.kind).toBe("advance");
			const outcome = (decision as any).outcome;
			expect(outcome.status).toBe("UNKNOWN");
			expect(outcome.reason).toContain("Truncated");
			expect(outcome.reason).toContain(String(MAX_LENGTH_RETRIES + 2));
			expect(outcome.reason).toContain("checkpoint");
		});
	});

	describe("clean stops without explicit signal", () => {
		it("advances as UNKNOWN (existing behavior) on a clean stop", () => {
			const decision = decideTaskEnd(baseParams({ stopReason: "stop" }));
			expect(decision).toEqual({
				kind: "advance",
				outcome: {
					status: "UNKNOWN",
					reason:
						"Task completed but outcome was unclear (task_complete was not called)",
				},
			});
		});

		it("advances as UNKNOWN when the stop reason is unknown/null", () => {
			const decision = decideTaskEnd(baseParams({ stopReason: null }));
			expect(decision.kind).toBe("advance");
			expect((decision as any).outcome.status).toBe("UNKNOWN");
		});

		it("advances as UNKNOWN for an unrecognized stop reason", () => {
			const decision = decideTaskEnd(
				baseParams({ stopReason: "weird-new-reason" }),
			);
			expect(decision.kind).toBe("advance");
		});
	});
});

// ── buildContinueMessage ────────────────────────────────────────────────────

describe("buildContinueMessage", () => {
	const task = { index: 6, text: "Prove fracDegMin_weightSystem" };

	it("contains the task index, total, and text", () => {
		const msg = buildContinueMessage(task, 20, "goal", 1);
		expect(msg).toContain("Continue task 6 of 20: Prove fracDegMin_weightSystem");
		expect(msg).toContain('"goal"');
	});

	it("does NOT start with 'Execute task' (findDeliveredTaskIndex must ignore it)", () => {
		const msg = buildContinueMessage(task, 20, "goal", 1);
		expect(TASK_PROMPT_RE.test(msg)).toBe(false);
		expect(msg.startsWith("Execute task")).toBe(false);
	});

	it("tells the model to check current file state before resuming", () => {
		const msg = buildContinueMessage(task, 20, "goal", 1);
		expect(msg).toContain("check the current state");
	});

	it("does not include a retry hint on the first retry", () => {
		const msg = buildContinueMessage(task, 20, "goal", 1);
		expect(msg).not.toContain("This is retry");
	});

	it("includes a retry hint (and BLOCKED escape hatch) on later retries", () => {
		const msg = buildContinueMessage(task, 20, "goal", 2);
		expect(msg).toContain(`This is retry 2 of ${MAX_LENGTH_RETRIES}`);
		expect(msg).toContain("ask_question");
		expect(msg).toContain("BLOCKED");
	});

	it("keeps the task_complete and ask_question contract", () => {
		const msg = buildContinueMessage(task, 20, "goal", 1);
		expect(msg).toContain("task_complete");
		expect(msg).toContain("- DONE:");
		expect(msg).toContain("- PARTIAL:");
	});
});

// ── buildPersistMessage ────────────────────────────────────────────────────

describe("buildPersistMessage", () => {
	const task = { index: 17, text: "Prove frankl_of_intersecting" };

	it("does NOT start with 'Execute task' (findDeliveredTaskIndex must ignore it)", () => {
		const msg = buildPersistMessage(task, 20, "goal");
		expect(TASK_PROMPT_RE.test(msg)).toBe(false);
		expect(msg.startsWith("Execute task")).toBe(false);
	});

	it("tells the model to persist partial results instead of continuing the work", () => {
		const msg = buildPersistMessage(task, 20, "goal");
		expect(msg).toContain("persist your partial results");
		expect(msg).toContain("Do not try to make further progress");
		expect(msg).toContain("checkpoint");
	});

	it("includes the task index, total, text, and plan goal", () => {
		const msg = buildPersistMessage(task, 20, "goal");
		expect(msg).toContain("task 17 of 20");
		expect(msg).toContain("Prove frankl_of_intersecting");
		expect(msg).toContain('"goal"');
	});

	it("keeps the BLOCKED escape hatch via ask_question", () => {
		const msg = buildPersistMessage(task, 20, "goal");
		expect(msg).toContain("ask_question");
		expect(msg).toContain("BLOCKED");
	});
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe("incident scenario (2026-09-21 session)", () => {
	it("retries the truncated task instead of queueing the next one", () => {
		// Task 13's run did 52 min of real work, then got truncated at 1,363
		// output tokens with ~98% context. Old behavior: mark UNKNOWN + queue
		// task 14 (abandoning unfinished work). New behavior: re-inject task 13.
		const d1 = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13,
				currentTaskIndex: 13,
				stopReason: "length",
				lastOutputTokens: 1363,
				contextPercent: 98,
			}),
		);
		// 1,363 < 16,384 → pi's overflow recovery will compact+retry the turn,
		// so the extension must NOT run its own (parallel) compaction.
		expect(d1).toEqual({ kind: "retry", compact: false });

		// pi's recovery retry re-truncates the same turn (second agent_end).
		// The branch still contains only task 13's prompt — nothing has moved.
		const d2 = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13,
				currentTaskIndex: 13,
				stopReason: "length",
				lastOutputTokens: 1363,
				contextPercent: 98,
				lengthRetries: 1,
			}),
		);
		expect(d2).toEqual({ kind: "retry", compact: false });

		// The budget is now exhausted: one final retry is issued, this time
		// with the persist-partial-results prompt (final: true).
		const d3 = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13,
				currentTaskIndex: 13,
				stopReason: "length",
				lastOutputTokens: 1363,
				contextPercent: 98,
				lengthRetries: MAX_LENGTH_RETRIES,
			}),
		);
		expect(d3).toEqual({ kind: "retry", compact: false, final: true });

		// Only if the checkpoint attempt is truncated too is the task finally
		// given up as UNKNOWN — after 4 truncated attempts, never silently.
		const d4 = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13,
				currentTaskIndex: 13,
				stopReason: "length",
				lastOutputTokens: 1363,
				contextPercent: 98,
				lengthRetries: MAX_LENGTH_RETRIES + 1,
			}),
		);
		expect(d4.kind).toBe("advance");
		expect((d4 as any).outcome.status).toBe("UNKNOWN");
		expect((d4 as any).outcome.reason).toContain("Truncated");
	});

	it("does not advance on a recovery retry of an earlier task (the desync)", () => {
		// After advancing to task 14 (e.g. via the exhausted-retries path),
		// pi's overflow recovery re-sends task 13's truncated turn. The old
		// code finalized task 14 here — before task 14's prompt was ever
		// delivered (02:31:34 vs 02:31:35 in the session log). The new code
		// skips: no finalize, no queue.
		const d = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13, // branch's last prompt
				currentTaskIndex: 14, // extension state already advanced
				stopReason: "length",
				lastOutputTokens: 1363,
				contextPercent: 98,
			}),
		);
		expect(d).toEqual({ kind: "skip" });
	});

	it("stops the whole plan when the user aborts (no more queued tasks)", () => {
		// 03:44:29: the user aborted task 16 to stop everything; the old code
		// queued task 17 32 ms later. New behavior: finalize + stop.
		const d = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 16,
				currentTaskIndex: 16,
				stopReason: "aborted",
			}),
		);
		expect(d).toEqual({
			kind: "stop",
			outcome: {
				status: "UNKNOWN",
				reason: "Aborted before completion (user interrupt or plan stop)",
			},
		});
	});

	it("compacts manually when the cap was hit exactly and context is high", () => {
		// Tasks 8-13 each ended with exactly 16,384 output tokens (the cap)
		// while context climbed past 85%: pi's overflow recovery will NOT
		// handle these, so the extension compacts before re-injecting.
		const d = decideTaskEnd(
			baseParams({
				deliveredTaskIndex: 13,
				currentTaskIndex: 13,
				stopReason: "length",
				lastOutputTokens: 16384,
				contextPercent: 92,
			}),
		);
		expect(d).toEqual({ kind: "retry", compact: true });
	});
});

describe("constants", () => {
	it("retried tasks are bounded", () => {
		expect(MAX_LENGTH_RETRIES).toBeGreaterThanOrEqual(1);
	});

	it("compaction threshold is a sane percent", () => {
		expect(RETRY_COMPACT_PERCENT).toBeGreaterThan(50);
		expect(RETRY_COMPACT_PERCENT).toBeLessThanOrEqual(95);
	});

	it("safety timeout is positive and long enough for a slow local model", () => {
		expect(RETRY_COMPACT_SAFETY_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1000);
	});
});
