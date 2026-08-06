/**
 * ask_question extension
 *
 * Registers a tool that lets the agent ask you a question with selectable options.
 * Always includes "Other" for free-text input.
 * Supports single-select and multi-select modes.
 * Only available in TUI (interactive) mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Schema ────────────────────────────────────────────────────────────────

export interface QuestionOption {
	title: string;
	description?: string;
	recommended?: boolean;
}

export interface AskQuestionParams {
	question: string;
	options?: QuestionOption[];
	multiSelect?: boolean;
}

export interface AskQuestionDetails {
	question: string;
	options: QuestionOption[];
	selections: string[];
	freeform?: string;
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	title: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Short description shown below the label" }),
	),
	recommended: Type.Optional(
		Type.Boolean({ description: "If true, mark this option as recommended (shown with ★)" }),
	),
});

const AskQuestionParamsSchema = Type.Object({
	question: Type.String({
		description: "The question to ask the user",
	}),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Options for the user to choose from. Omit or leave empty for a free-form question.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "If true, allow the user to select multiple options",
			default: false,
		}),
	),
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Render the question and options as a selectable UI component.
 */
function createQuestionComponent(
	tui: TUI,
	theme: NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"] extends (result: any, options: any, theme: infer T, ctx: any) => any ? T : never>,
	done: (result: { selections: string[]; freeform?: string } | null) => void,
	params: AskQuestionParams,
) {
	const multiSelect = params.multiSelect ?? false;
	const providedOptions = params.options ?? [];

	// Always append "Other"
	const otherOption: QuestionOption = {
		title: "Other",
		description: "Type your own answer",
	};
	const allOptions = [...providedOptions, otherOption];

	let cursorIndex = 0;
	let selectedIndices = new Set<number>(); // For multi-select
	let editMode = false; // Editing the "Other" freeform input
	let freeformText = "";

	const editorTheme: EditorTheme = {
		borderColor: (s: string) => theme.fg("accent", s),
	};
	const editor = new Editor(tui, editorTheme);
	editor.onSubmit = (value: string) => {
		freeformText = value.trim();
		if (freeformText) {
			// Submit
			const selections = multiSelect
				? [...selectedIndices].sort().map((i) => allOptions[i].title)
				: [allOptions[cursorIndex].title];
			if (selections.includes("Other") || freeformText) {
				done({ selections, freeform: freeformText || undefined });
			} else {
				done({ selections });
			}
		}
		refresh();
	};

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	let cachedLines: string[] | undefined;

	function handleInput(data: string) {
		if (editMode) {
			if (matchesKey(data, Key.escape)) {
				// Close editor, return to options
				if (multiSelect && selectedIndices.has(allOptions.length - 1)) {
					selectedIndices.delete(allOptions.length - 1);
				}
				freeformText = "";
				editor.setText("");
				editMode = false;
				refresh();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		// Navigation
		if (matchesKey(data, Key.up) || data === "k") {
			cursorIndex = Math.max(0, cursorIndex - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			cursorIndex = Math.min(allOptions.length - 1, cursorIndex + 1);
			refresh();
			return;
		}

		// Select / toggle
		if (matchesKey(data, Key.enter) || data === " ") {
			const isOther = cursorIndex === allOptions.length - 1;

			if (isOther) {
				// Open freeform editor
				editMode = true;
				editor.setText(freeformText);
				refresh();
				return;
			}

			if (multiSelect) {
				// Toggle selection
				if (selectedIndices.has(cursorIndex)) {
					selectedIndices.delete(cursorIndex);
				} else {
					selectedIndices.add(cursorIndex);
				}
				refresh();
				return;
			}

			// Single select — confirm
			done({ selections: [allOptions[cursorIndex].title] });
			return;
		}

		// Submit for multi-select (Ctrl+Enter)
		if (multiSelect && matchesKey(data, "ctrl+enter")) {
			const selections = [...selectedIndices]
				.sort()
				.map((i) => allOptions[i].title);
			if (selections.includes("Other") && !freeformText) {
				// "Other" selected but no text yet — open editor
				cursorIndex = allOptions.length - 1;
				editMode = true;
				editor.setText("");
				refresh();
				return;
			}
			done({ selections, freeform: freeformText || undefined });
			return;
		}

		// Cancel
		if (matchesKey(data, Key.escape)) {
			done(null);
			return;
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const lines: string[] = [];
		const renderWidth = Math.max(1, width);

		function addLine(text: string) {
			lines.push(text.padEnd(renderWidth));
		}

		function addWrapped(text: string) {
			lines.push(...wrapTextWithAnsi(text, renderWidth));
		}

		function addIndented(indent: number, text: string) {
			const prefix = " ".repeat(indent);
			const available = Math.max(1, renderWidth - indent);
			for (const line of wrapTextWithAnsi(text, available)) {
				lines.push((line.length < available ? line + " ".repeat(available - visibleWidth(line)) : line));
				lines[lines.length - 1] = prefix + line;
			}
		}

		// Title bar
		const title = multiSelect ? "Ask Question (multi-select)" : "Ask Question";
		addLine(theme.fg("accent", title));
		addLine(theme.fg("accent", "─".repeat(Math.min(renderWidth, title.length))));

		// Question
		addWrapped(theme.bold(theme.fg("text", params.question)));
		lines.push("");

		// Options
		for (let i = 0; i < allOptions.length; i++) {
			const opt = allOptions[i];
			const isCursor = i === cursorIndex;
			const isSelected = selectedIndices.has(i);
			const isOtherOpt = i === allOptions.length - 1;
			const isRecommended = opt.recommended ?? false;

			let prefix: string;
			if (multiSelect) {
				const check = isSelected ? theme.fg("accent", "█") : theme.fg("dim", "░");
				prefix = `${check} `;
			} else {
				prefix = isCursor ? theme.fg("accent", "> ") : "  ";
			}

			// Recommended marker
			const recMarker = isRecommended && !isOtherOpt ? theme.fg("accent", "★ ") : "";

			// Option label
			let labelColor: string;
			if (isCursor) {
				labelColor = "accent";
			} else if (isOtherOpt && editMode) {
				labelColor = "accent";
			} else if (multiSelect && isSelected) {
				labelColor = "success";
			} else {
				labelColor = "text";
			}

			const label = opt.title;
			const otherIcon = isOtherOpt && editMode ? " ✎" : "";
			const optionLine = `${prefix}${recMarker}${theme.fg(labelColor, label + otherIcon)}`;

			lines.push(optionLine.padEnd(renderWidth));

			// Description
			if (opt.description) {
				const descPrefix = multiSelect ? "  " : "  ";
				const descLine = `${descPrefix}${" ".repeat(isRecommended ? 2 : 0)}${theme.fg("muted", opt.description)}`;
				lines.push(descLine.padEnd(renderWidth));
			}

			// Edit mode: show editor under "Other"
			if (isOtherOpt && editMode) {
				lines.push("");
				addWrapped(theme.fg("muted", "Your answer:"));
				const editorLines = editor.render(Math.max(1, renderWidth - 2));
				for (const el of editorLines) {
					lines.push(` ${el}`.padEnd(renderWidth));
				}
			}
		}

		lines.push("");

		// Footer instructions
		if (editMode) {
			addLine(theme.fg("dim", "Enter to submit • Esc to go back"));
		} else if (multiSelect) {
			const hasSelections = selectedIndices.size > 0;
			const submitHint = hasSelections ? " • Ctrl+Enter to submit" : "";
			addLine(
				theme.fg("dim", `↑↓ navigate • Space/Enter to toggle${submitHint} • Esc to cancel`),
			);
		} else {
			addLine(theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
		}

		cachedLines = lines;
		return lines;
	}

	return {
		render,
		handleInput,
		invalidate: () => {
			cachedLines = undefined;
		},
	};
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let inTuiMode = false;

	pi.on("session_start", (_event, ctx) => {
		inTuiMode = ctx.mode === "tui";
		if (inTuiMode) {
			pi.setActiveTools(["ask_question"]);
		}
	});

	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a question with selectable options. Always includes an 'Other' option for free-text input. Supports single-select and multi-select modes.",
		parameters: AskQuestionParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Error: ask_question is only available in interactive (TUI) mode.",
						},
					],
					details: {
						question: params.question,
						options: params.options ?? [],
						selections: [],
						cancelled: true,
					} as AskQuestionDetails,
				};
			}

			const result = await ctx.ui.custom<
				{ selections: string[]; freeform?: string } | null
			>((tui, theme, _kb, done) => {
				return createQuestionComponent(tui, theme, done, params);
			});

			const details: AskQuestionDetails = {
				question: params.question,
				options: params.options ?? [],
				selections: [],
				cancelled: false,
			};

			if (result === null) {
				details.cancelled = true;
				return {
					content: [
						{
							type: "text",
							text: "The user cancelled the question. Stop interacting and wait for the user's next input.",
						},
					],
					details,
				};
			}

			details.selections = result.selections;

			// If "Other" was selected with freeform text
			if (result.freeform) {
				details.freeform = result.freeform;
				const summary = result.selections.length > 1
					? `Selected: ${result.selections.join(", ")}. Wrote: ${result.freeform}`
					: `User wrote: ${result.freeform}`;
				return {
					content: [{ type: "text", text: summary }],
					details,
				};
			}

			// Regular selection(s)
			const summary = result.selections.length > 1
				? `Selected: ${result.selections.join(", ")}`
				: `Selected: ${result.selections[0]}`;
			return {
				content: [{ type: "text", text: summary }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const parts: string[] = [
				theme.fg("toolTitle", theme.bold("ask_question ")),
				theme.fg("text", args.question),
			];

			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length > 0) {
				const labels = opts
					.map(
						(o: QuestionOption, i: number) =>
							`${i + 1}. ${o.title}${o.recommended ? " ★" : ""}`,
					)
					.join(", ") + ", Other";
				parts.push("");
				parts.push(theme.fg("dim", `  Options: ${labels}`));
			} else {
				parts.push("");
				parts.push(theme.fg("dim", "  Free-form question"));
			}

			if (args.multiSelect) {
				parts.push(theme.fg("dim", "  Mode: multi-select"));
			}

			return new Text(parts.join("\n"), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskQuestionDetails | undefined;
			if (!details) {
				const text = result.content?.[0];
				return new Text(
					text?.type === "text" ? text.text : "No result",
					0,
					0,
				);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
			}

			const parts: string[] = [];

			if (details.freeform) {
				parts.push(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "(wrote) ") +
						theme.bold(theme.fg("accent", details.freeform)),
				);
			}

			if (details.selections.length > 0) {
				const labels = details.selections.map((s) => {
					const idx = details.options.findIndex(
						(o) => o.title === s,
					);
					return idx >= 0 ? `${idx + 1}. ${s}` : s;
				});
				parts.push(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "(selected) ") +
						theme.fg("accent", labels.join(", ")),
				);
			}

			return new Text(parts.join("\n"), 0, 0);
		},
	});
}
