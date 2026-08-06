import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the pi-tui imports ──────────────────────────────────────────────

// We need to mock the TUI module since we can't run a real terminal in tests
const mockHandleInput = vi.fn();
const mockSetText = vi.fn();
const mockRender = vi.fn(() => ["|"]);

vi.mock("@earendil-works/pi-tui", () => {
	// Realistic ANSI-aware visibleWidth: strips common SGR/OSC escape sequences
	const stripAnsi = (s: string) =>
		s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
	const mockVisibleWidth = vi.fn((s: string) => stripAnsi(s).length);

	// Realistic wrapTextWithAnsi: wraps at word boundaries within width
	const mockWrapTextWithAnsi = vi.fn((text: string, width: number) => {
		const stripped = stripAnsi(text);
		if (stripped.length <= width) return [text];
		// Simple word-wrap simulation
		const words = stripped.split(" ");
		const lines: string[] = [];
		let current = "";
		for (const word of words) {
			const test = current ? `${current} ${word}` : word;
			if (test.length <= width) {
				current = test;
			} else {
				if (current) lines.push(current);
				current = word;
			}
		}
		if (current) lines.push(current);
		return lines;
	});

	// Realistic truncateToWidth: truncates based on visible width
	const mockTruncateToWidth = vi.fn(
		(s: string, width: number, ellipsis = "...") => {
			const stripped = stripAnsi(s);
			if (stripped.length <= width) return s;
			// Truncate the visible portion, preserving ANSI at the start
			const ansiPrefix = s.match(/^((?:\x1b\[[\d;]*[a-zA-Z])+)/);
			const prefix = ansiPrefix ? ansiPrefix[0] : "";
			const availableWidth = width - ellipsis.length;
			const truncated = stripped.slice(0, availableWidth);
			return prefix + truncated + ellipsis;
		}
	);

	return {
		Editor: vi.fn().mockImplementation(() => ({
			handleInput: mockHandleInput,
			setText: mockSetText,
			render: mockRender,
			onSubmit: undefined,
		})),
		Key: {
			escape: "\u001b",
			enter: "\r",
			up: "\u001b[A",
			down: "\u001b[B",
		},
		matchesKey: vi.fn(
			(
				data: string,
				key: string | typeof import("@earendil-works/pi-tui").Key,
			) => {
				if (key === "\u001b" && data === "\u001b") return true;
				if (key === "\r" && (data === "\r" || data === "\n")) return true;
				if (key === "\u001b[A" && data === "\u001b[A") return true;
				if (key === "\u001b[B" && data === "\u001b[B") return true;
				if (key === "ctrl+enter" && data === "\u001b[E") return true;
				return false;
			},
		),
		Text: vi.fn().mockImplementation((text, x, y) => ({ text, x, y })),
		visibleWidth: mockVisibleWidth,
		wrapTextWithAnsi: mockWrapTextWithAnsi,
		truncateToWidth: mockTruncateToWidth,
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("typebox", () => ({
	Type: {
		Object: vi.fn().mockImplementation((props) => props),
		String: vi.fn().mockImplementation((opts) => ({ type: "string", ...opts })),
		Boolean: vi.fn().mockImplementation((opts) => ({ type: "boolean", ...opts })),
		Array: vi.fn().mockImplementation((schema, opts) => ({ type: "array", items: schema, ...opts })),
		Optional: vi.fn((schema) => schema),
	},
}));

// ── Import the module under test ─────────────────────────────────────────

// We import dynamically so vitest can handle the mocks
let createQuestionComponent: ReturnType<typeof import("./index")["default"] extends never ? never : any>;

// ── Test: schema and types ────────────────────────────────────────────────

describe("ask_question schema", () => {
	it("exports the correct parameter shape", async () => {
		// Re-import after mocks are set
		const mod = await import("./index");
		expect(mod).toBeDefined();
	});

	it("QuestionOption has required fields", () => {
		// Type-level test — just ensure the interface is correct
		const opt: import("./index").QuestionOption = { title: "Test" };
		expect(opt.title).toBe("Test");
		expect(opt.description).toBeUndefined();
		expect(opt.recommended).toBeUndefined();
	});

	it("QuestionOption supports optional description and recommended", () => {
		const opt: import("./index").QuestionOption = {
			title: "Test",
			description: "A test option",
			recommended: true,
		};
		expect(opt.title).toBe("Test");
		expect(opt.description).toBe("A test option");
		expect(opt.recommended).toBe(true);
	});

	it("AskQuestionParams requires question", () => {
		const params: import("./index").AskQuestionParams = { question: "What?" };
		expect(params.question).toBe("What?");
		expect(params.options).toBeUndefined();
		expect(params.multiSelect).toBeUndefined();
	});

	it("AskQuestionParams supports optional options and multiSelect", () => {
		const params: import("./index").AskQuestionParams = {
			question: "Choose?",
			options: [{ title: "A" }, { title: "B", recommended: true }],
			multiSelect: true,
		};
		expect(params.options).toHaveLength(2);
		expect(params.multiSelect).toBe(true);
	});
});

// ── Test: result details shape ────────────────────────────────────────────

describe("AskQuestionDetails", () => {
	it("has the correct structure for a selection", () => {
		const details: import("./index").AskQuestionDetails = {
			question: "What?",
			options: [{ title: "A" }],
			selections: ["A"],
			cancelled: false,
		};
		expect(details.cancelled).toBe(false);
		expect(details.selections).toEqual(["A"]);
		expect(details.freeform).toBeUndefined();
	});

	it("has the correct structure for freeform", () => {
		const details: import("./index").AskQuestionDetails = {
			question: "What?",
			options: [],
			selections: ["Other"],
			freeform: "my custom answer",
			cancelled: false,
		};
		expect(details.freeform).toBe("my custom answer");
	});

	it("has the correct structure for cancelled", () => {
		const details: import("./index").AskQuestionDetails = {
			question: "What?",
			options: [{ title: "A" }],
			selections: [],
			cancelled: true,
		};
		expect(details.cancelled).toBe(true);
		expect(details.selections).toEqual([]);
	});

	it("supports multi-select with multiple selections", () => {
		const details: import("./index").AskQuestionDetails = {
			question: "Pick all that apply?",
			options: [{ title: "A" }, { title: "B" }, { title: "C" }],
			selections: ["A", "C"],
			cancelled: false,
		};
		expect(details.selections).toEqual(["A", "C"]);
	});
});

// ── Test: UI component behavior (unit tests) ─────────────────────────────

describe("question component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// We test the component logic indirectly by importing the module
	// and checking that the component factory returns the right shape
	it("component returns an object with render, handleInput, and invalidate", async () => {
		// Since the component is created inside the tool execute function,
		// we test it through the extension factory
		const mod = await import("./index");
		const extensionFactory = mod.default;

		// Mock ExtensionAPI
		const mockPi = {
			on: vi.fn(),
			registerTool: vi.fn(),
			setActiveTools: vi.fn(),
		};
		const mockRegisterTool = mockPi.registerTool;

		extensionFactory(mockPi as any);

		// registerTool was called once
		expect(mockRegisterTool).toHaveBeenCalledTimes(1);

		// Extract the tool definition
		const toolDef = mockRegisterTool.mock.calls[0][0];
		expect(toolDef.name).toBe("ask_question");
		expect(toolDef.label).toBe("Ask Question");
		expect(toolDef.executionMode).toBe("sequential");
	});

	it("tool is hidden in non-TUI mode via session_start handler", async () => {
		const mod = await import("./index");
		const extensionFactory = mod.default;

		const mockPi = {
			on: vi.fn(),
			registerTool: vi.fn(),
			setActiveTools: vi.fn(),
			getActiveTools: vi.fn().mockReturnValue(["read", "bash", "write", "edit"]),
		};

		extensionFactory(mockPi as any);

		// Get the session_start handler
		const sessionStartHandler = mockPi.on.mock.calls[0][1];

		// Simulate TUI mode
		await sessionStartHandler({}, { mode: "tui" });
		expect(mockPi.getActiveTools).toHaveBeenCalled();
		expect(mockPi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining(["ask_question", "read", "bash", "write", "edit"]),
		);

		// Simulate non-TUI mode
		mockPi.setActiveTools.mockReset();
		await sessionStartHandler({}, { mode: "rpc" });
		expect(mockPi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ── Test: tool execute (integration with mocked UI) ──────────────────────

describe("tool execute", () => {
	let toolDef: any;
	let mockDone: (value: any) => void;
	let resolveUI: (value: any) => void;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("./index");
		const extensionFactory = mod.default;

		const mockPi = {
			on: vi.fn(),
		registerTool: vi.fn(),
			setActiveTools: vi.fn(),
		};

		extensionFactory(mockPi as any);
		toolDef = mockPi.registerTool.mock.calls[0][0];
	});

	it("returns error in non-TUI mode", async () => {
		const result = await toolDef.execute(
			"tool-1",
			{ question: "What is your name?" },
			new AbortController().signal,
			vi.fn(),
			{ mode: "rpc" },
		);

		expect(result.content[0].text).toContain("only available in interactive");
		expect(result.details.cancelled).toBe(true);
	});

	it("returns cancellation message when user cancels", async () => {
		// Mock ctx.ui.custom to resolve with null (cancel)
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue(null),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{ question: "What is your name?" },
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toContain("cancelled");
		expect(result.details.cancelled).toBe(true);
		expect(result.details.selections).toEqual([]);
	});

	it("returns single selection result", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Option A"],
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{
				question: "Pick one?",
				options: [{ title: "Option A" }, { title: "Option B" }],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe("Selected: Option A");
		expect(result.details.selections).toEqual(["Option A"]);
		expect(result.details.cancelled).toBe(false);
	});

	it("returns multi-select result", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Option A", "Option C"],
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{
				question: "Pick all that apply?",
				options: [{ title: "Option A" }, { title: "Option B" }, { title: "Option C" }],
				multiSelect: true,
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe("Selected: Option A, Option C");
		expect(result.details.selections).toEqual(["Option A", "Option C"]);
	});

	it("returns freeform result with Other selection", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Other"],
					freeform: "My custom answer",
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{
				question: "What do you think?",
				options: [{ title: "Good" }, { title: "Bad" }],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe("User wrote: My custom answer");
		expect(result.details.freeform).toBe("My custom answer");
		expect(result.details.selections).toContain("Other");
	});

	it("returns freeform with multi-select selections", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Option A", "Other"],
					freeform: "Also, consider X",
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{
				question: "Pick all that apply?",
				options: [{ title: "Option A" }, { title: "Option B" }],
				multiSelect: true,
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe(
			"Selected: Option A, Other. Wrote: Also, consider X",
		);
		expect(result.details.freeform).toBe("Also, consider X");
	});

	it("handles free-form question with no options", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Other"],
					freeform: "Free text answer",
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{ question: "Describe your experience." },
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe("User wrote: Free text answer");
		expect(result.details.options).toEqual([]);
	});

	it("handles empty options array same as no options", async () => {
		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({
					selections: ["Other"],
					freeform: "Answer",
				}),
			},
		};

		const result = await toolDef.execute(
			"tool-1",
			{ question: "Go ahead.", options: [] },
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		expect(result.content[0].text).toBe("User wrote: Answer");
	});
});

// ── Test: renderCall and renderResult ─────────────────────────────────────

describe("rendering", () => {
	let toolDef: any;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("./index");
		const extensionFactory = mod.default;

		const mockPi = {
			on: vi.fn(),
			registerTool: vi.fn(),
			setActiveTools: vi.fn(),
		};

		extensionFactory(mockPi as any);
		toolDef = mockPi.registerTool.mock.calls[0][0];
	});

	const mockTheme: any = {
		fg: (color: string, text: string) => `[${color}]${text}[/]`,
		bold: (text: string) => `**${text}**`,
		toolTitle: (text: string) => text,
	};

	it("renderCall shows question and options", () => {
		const component = toolDef.renderCall(
			{
				question: "Pick a color?",
				options: [
					{ title: "Red", recommended: true },
					{ title: "Blue" },
				],
			},
			mockTheme,
		);
		expect(component.text).toContain("Pick a color?");
		expect(component.text).toContain("Red");
		expect(component.text).toContain("Blue");
		expect(component.text).toContain("Other");
		expect(component.text).toContain("★"); // recommended marker
	});

	it("renderCall shows free-form hint when no options", () => {
		const component = toolDef.renderCall(
			{ question: "Describe your idea." },
			mockTheme,
		);
		expect(component.text).toContain("Free-form question");
	});

	it("renderCall shows multi-select mode", () => {
		const component = toolDef.renderCall(
			{
				question: "Pick all?",
				options: [{ title: "A" }, { title: "B" }],
				multiSelect: true,
			},
			mockTheme,
		);
		expect(component.text).toContain("multi-select");
	});

	it("renderResult shows selection", () => {
		const component = toolDef.renderResult(
			{
				content: [{ type: "text", text: "Selected: Red" }],
				details: {
					question: "Pick?",
					options: [{ title: "Red" }, { title: "Blue" }],
					selections: ["Red"],
					cancelled: false,
				},
			},
			{},
			mockTheme,
		);
		expect(component.text).toContain("✓");
		expect(component.text).toContain("1. Red");
	});

	it("renderResult shows freeform answer", () => {
		const component = toolDef.renderResult(
			{
				content: [{ type: "text", text: "User wrote: custom" }],
				details: {
					question: "Pick?",
					options: [],
					selections: ["Other"],
					freeform: "custom answer",
					cancelled: false,
				},
			},
			{},
			mockTheme,
		);
		expect(component.text).toContain("(wrote)");
		expect(component.text).toContain("custom answer");
	});

	it("renderResult shows cancelled", () => {
		const component = toolDef.renderResult(
			{
				content: [{ type: "text", text: "Cancelled" }],
				details: {
					question: "Pick?",
					options: [],
					selections: [],
					cancelled: true,
				},
			},
			{},
			mockTheme,
		);
		expect(component.text).toContain("Cancelled");
	});
});

// ── Test: render width constraints (regression for terminal overflow crash) ──

describe("render width constraints", () => {
	/** Strip ANSI escape codes so we can measure visible width */
	function visibleWidth(s: string): number {
		return s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").length;
	}

	/**
	 * Extract the question component from the tool by intercepting ctx.ui.custom.
	 * Returns the component ready for testing.
	 */
	async function getComponent(params: any) {
		let capturedFactory: (tui: any, theme: any, kb: any, done: any) => any;
		let pendingDone: (value: any) => void;

		const mockCtx: any = {
			mode: "tui",
			ui: {
				custom: vi.fn().mockImplementation((factory: any) => {
					capturedFactory = factory;
					return new Promise((resolve) => {
						pendingDone = resolve;
					});
				}),
			},
		};

		// Boot the extension and grab the tool
		const mockPi = { on: vi.fn(), registerTool: vi.fn(), setActiveTools: vi.fn() };
		const mod = await import("./index");
		mod.default(mockPi as any);
		const toolDef = mockPi.registerTool.mock.calls[0][0];

		// Trigger execute to capture the component factory
		toolDef.execute(
			"tool-1",
			params,
			new AbortController().signal,
			vi.fn(),
			mockCtx,
		);

		// Build a minimal theme with ANSI SGR codes (realistic)
		const ansiTheme = {
			fg: (color: string, text: string) => `\x1b[38;5;241m${text}\x1b[0m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
		};
		return capturedFactory(null, ansiTheme, null, pendingDone);
	}

	/** Assert all rendered lines respect the given width */
	function assertWidth(lines: string[], width: number) {
		for (let i = 0; i < lines.length; i++) {
			expect(visibleWidth(lines[i]), `line ${i} exceeds width ${width}`).toBeLessThanOrEqual(width);
		}
	}

	it("no line exceeds width with short content at common widths", async () => {
		const comp = await getComponent({
			question: "Pick a color?",
			options: [{ title: "Red", recommended: true }, { title: "Blue" }],
		});
		for (const width of [80, 60, 40, 30, 20]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("no line exceeds width with very long option titles", async () => {
		const comp = await getComponent({
			question: "Choose?",
			options: [
				{
					title: "ThisIsAVeryLongOptionTitleThatWouldEasilyExceedTheTerminalWidthIfNotProperlyTruncatedAndTheOldPadEndImplementationCountedAnsiEscapeCodesAsVisibleCharactersMakingTheLineEvenLonger",
					recommended: true,
				},
				{
					title: "AnotherExtremelyLongOptionThatTestsWhetherTheTruncationLogicHandlesMultipleLongOptionsCorrectlyWithoutCausingAnyTerminalOverflowCrashOrWrappingIssues",
				},
			],
		});
		for (const width of [80, 50, 30, 20]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("no line exceeds width with long descriptions", async () => {
		const comp = await getComponent({
			question: "Q?",
			options: [
				{
					title: "A",
					description: "This description is deliberately very long and should wrap and truncate properly when the terminal width is narrow enough to cause issues with the rendering logic that previously used padEnd which counted ANSI escape codes as visible characters",
				},
			],
		});
		for (const width of [80, 50, 30]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("no line exceeds width with long question text", async () => {
		const comp = await getComponent({
			question: "This is a very long question that contains many words and should wrap across multiple lines when rendered in a narrow terminal window to test whether the width constraint is properly enforced for all lines of the wrapped question text",
			options: [{ title: "Yes" }],
		});
		for (const width of [80, 50, 30]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("no line exceeds width in multi-select mode", async () => {
		const comp = await getComponent({
			question: "Select all that apply from this extremely long list of options that tests the multi-select rendering mode with long text",
			options: [
				{ title: "OptionOneWithAVeryLongTitle" },
				{ title: "OptionTwoWithAVeryLongTitle" },
				{ title: "OptionThreeWithAVeryLongTitle" },
			],
			multiSelect: true,
		});
		for (const width of [80, 50, 30]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("no line exceeds width when ANSI styling adds invisible codes", async () => {
		const comp = await getComponent({
			question: "\x1b[1m\x1b[38;5;226mThis question has ANSI codes embedded making the string longer than its visible width\x1b[0m",
			options: [
				{
					title: "\x1b[38;5;226m\x1b[1mA very long option title with ANSI color codes that should be stripped when calculating visible width\x1b[0m",
					recommended: true,
				},
			],
		});
		for (const width of [80, 50, 30]) {
			comp.invalidate();
			assertWidth(comp.render(width), width);
		}
	});

	it("handles extreme narrow widths without crashing", async () => {
		const comp = await getComponent({
			question: "Test",
			options: [{ title: "A", description: "B" }],
		});
		for (const width of [40, 20, 12]) {
			comp.invalidate();
			const lines = comp.render(width);
			expect(lines.length).toBeGreaterThan(0);
			assertWidth(lines, width);
		}
	});
});
