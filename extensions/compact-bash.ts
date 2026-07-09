/**
 * Compact Bash Output — overrides the built-in `bash` tool's result renderer
 * to use less vertical space, without touching pi's installed files.
 *
 * Changes vs. the default renderer:
 * - No standalone "(no output)" line. Empty output is shown inline with the
 *   duration as "0.6s · no output".
 * - Duration is compact: "0.6s" instead of "Took 0.6s" / "Elapsed 0.6s".
 * - Duration sits directly under the output (or alone when there is none),
 *   removing one trailing line.
 *
 * Execution and the call/title renderer are inherited from the built-in bash
 * tool (we only override `renderResult`), so streaming, truncation, temp-file
 * handling, and the `$ command` header are all unchanged.
 *
 * Toggle off with: pi --no-extension compact-bash  (or remove this file).
 */

import { type ExtensionAPI, createBashToolDefinition, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 20;

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Pull the literal text out of a tool result's content blocks.
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  // Spread the built-in definition so execute, renderCall, and promptSnippet are
  // inherited; we override only renderResult below.
  const builtin = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...builtin,

    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };

      // Keep the live timer ticking while partial, stop it when settled.
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const container = new Container();

      let output = resultText(result).trim();
      // The built-in executor bakes "(no output)" into the content; drop it so
      // we can fold emptiness into the duration line instead.
      if (output === "(no output)") output = "";

      // Strip the embedded truncation footer if we render our own warning below.
      const truncation = (result.details as { truncation?: unknown } | undefined)?.truncation as
        | {
            truncated?: boolean;
            truncatedBy?: string;
            outputLines?: number;
            totalLines?: number;
            maxBytes?: number;
          }
        | undefined;
      const fullOutputPath = (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
      if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
        const footerStart = output.lastIndexOf("\n\n[");
        if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
          output = output.slice(0, footerStart).trimEnd();
        }
      }

      if (output) {
        const styled = output
          .split("\n")
          .map((line) => theme.fg("toolOutput", line))
          .join("\n");

        if (options.expanded) {
          container.addChild(new Text(`\n${styled}`, 0, 0));
        } else {
          // Lazy preview with expand hint, mirroring the built-in behavior.
          const cache: { width?: number; lines?: string[]; skipped?: number } = {};
          container.addChild({
            render: (width: number) => {
              if (cache.lines === undefined || cache.width !== width) {
                const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
                cache.lines = preview.visualLines;
                cache.skipped = preview.skippedCount;
                cache.width = width;
              }
              if (cache.skipped && cache.skipped > 0) {
                const hint =
                  theme.fg("muted", `... (${cache.skipped} earlier lines,`) +
                  ` ${keyHint("app.tools.expand", "to expand")})`;
                return ["", truncateToWidth(hint, width, "..."), ...(cache.lines ?? [])];
              }
              return ["", ...(cache.lines ?? [])];
            },
            invalidate: () => {
              cache.width = undefined;
              cache.lines = undefined;
              cache.skipped = undefined;
            },
          });
        }
      }

      if (truncation?.truncated || fullOutputPath) {
        const warnings: string[] = [];
        if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
        if (truncation?.truncated) {
          if (truncation.truncatedBy === "lines") {
            warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
          } else {
            warnings.push(`Truncated: ${truncation.outputLines} lines shown`);
          }
        }
        container.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
      }

      // Compact duration: no "Took"/"Elapsed" label; fold no-output into this line.
      if (state.startedAt !== undefined) {
        const endTime = state.endedAt ?? Date.now();
        const dur = formatDuration(endTime - state.startedAt);
        const durText = output || options.isPartial ? dur : `${dur} \u00b7 no output`;
        const lead = output ? "\n" : "";
        container.addChild(new Text(`${lead}${theme.fg("muted", durText)}`, 0, 0));
      }

      return container;
    },
  });
}
