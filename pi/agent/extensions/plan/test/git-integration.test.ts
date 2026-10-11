import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import {
	changedSince,
	commitTask,
	runHook,
	snapshotDirty,
	stashPaths,
	type GitExec,
} from "../execution.js";

const run = promisify(execFile);

/** A real executor, like pi.exec. */
const real: GitExec = {
	async exec(cmd, args, options) {
		try {
			const { stdout, stderr } = await run(cmd, args, { cwd: options?.cwd });
			return { code: 0, stdout, stderr };
		} catch (e: any) {
			return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
		}
	},
};

async function git(cwd: string, ...args: string[]) {
	return (await run("git", args, { cwd })).stdout;
}

describe("task commit flow against a real repository", () => {
	it("commits only the task's files and stashes the ones that fail the check", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plan-ext-"));
		await git(dir, "init", "-q");
		await git(dir, "config", "user.email", "t@example.com");
		await git(dir, "config", "user.name", "t");
		await mkdir(join(dir, ".pi/hooks"), { recursive: true });
		await writeFile(join(dir, "base.lean"), "base\n");
		await writeFile(join(dir, ".pi/plan.md"), "# Plan: x\n\n- TODO: t\n");
		// check-files hook: a file "fails" when it contains BROKEN.
		await writeFile(
			join(dir, ".pi/hooks/check-files"),
			'#!/bin/sh\ns=0\nfor f in "$@"; do grep -q BROKEN "$f" 2>/dev/null && { echo "$f"; s=1; }; done\nexit $s\n',
			{ mode: 0o755 },
		);
		await git(dir, "add", "-A");
		await git(dir, "commit", "-qm", "init");

		// Dirty before the task started: must be left alone.
		await writeFile(join(dir, "user-wip.md"), "someone else's notes\n");
		const before = await snapshotDirty(real, dir);

		// The task's work.
		await writeFile(join(dir, "good.lean"), "fine\n");
		await writeFile(join(dir, "base.lean"), "BROKEN edit\n");
		await writeFile(join(dir, "new-broken.lean"), "BROKEN\n");
		await writeFile(join(dir, ".pi/plan.md"), "# Plan: x\n\n- PARTIAL: t\n");

		const now = await snapshotDirty(real, dir);
		const changed = changedSince(before!, now!).filter((f) => f !== ".pi/plan.md");
		expect(changed).toEqual(["base.lean", "good.lean", "new-broken.lean"]);

		const check = await runHook(real, dir, "check-files", changed, 10000);
		expect(check.exists).toBe(true);
		const failing = check.stdout.split("\n").filter((l) => changed.includes(l));
		expect(failing).toEqual(["base.lean", "new-broken.lean"]);
		expect(await stashPaths(real, dir, failing, "plan task 1: does not compile")).toBe(true);

		const kept = changed.filter((f) => !failing.includes(f));
		expect(await commitTask(real, dir, [...kept, ".pi/plan.md"], "plan: task 1 (PARTIAL): t")).toBe(
			"committed",
		);

		const files = (await git(dir, "show", "--name-only", "--format=", "HEAD")).trim().split("\n");
		expect(files.sort()).toEqual([".pi/plan.md", "good.lean"]);
		// Broken edits are out of the tree but kept in the stash.
		expect(await readFile(join(dir, "base.lean"), "utf-8")).toBe("base\n");
		expect(await git(dir, "stash", "list")).toContain("plan task 1: does not compile");
		const stashed = await git(dir, "stash", "show", "--include-untracked", "--name-only", "stash@{0}");
		expect(stashed).toContain("base.lean");
		expect(stashed).toContain("new-broken.lean");
		// Pre-existing dirt untouched and uncommitted.
		expect((await git(dir, "status", "--porcelain")).trim()).toBe("?? user-wip.md");
	});
});
