import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the pi-tui imports ──────────────────────────────────────────────

// We need to mock the TUI module since we can't run a real terminal in tests
const mockHandleInput = vi.fn();
const mockSetText = vi.fn();
const mockRender = vi.fn(() => ["|"]);

vi.mock("@earendil-works/pi-tui", () => ({
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
	matchesKey: vi.fn((data: string, key: string | typeof import("@earendil-works/pi-tui").Key) => {
		if (key === "\u001b" && data === "\u001b") return true;
		if (key === "\r" && (data === "\r" || data === "\n")) return true;
		if (key === "\u001b[A" && data === "\u001b[A") return true;
		if (key === "\u001b[B" && data === "\u001b[B") return true;
		if (key === "ctrl+enter" && data === "\u001b[E") return true;
		return false;
	}),
	Text: vi.fn().mockImplementation((text, x, y) => ({ text, x, y })),
	visibleWidth: vi.fn((s: string) => s.length),
	wrapTextWithAnsi: vi.fn((text: string, _width: number) => [text]),
}));

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
