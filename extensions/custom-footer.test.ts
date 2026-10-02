/**
 * Tests for the responsive footer layout in custom-footer.ts.
 *
 * Run: pnpm test  (or: npx tsx --test extensions/custom-footer.test.ts)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeFooterLine,
  fitFooterLine,
  FOOTER_DROP_ORDER,
  mcpCountsFromSnapshot,
  MCP_STATUS_EVENT,
  type FooterSegments,
} from "./custom-footer.ts";

// Plain (ANSI-free) segments matching the example footer:
// iris ⑂ fix-mcp-schema-sanitization      0%▕░░░░░░░░░░ $0 fable-5 ♞
const SEG: FooterSegments = {
  repo: "iris",
  sep: " ⑂ ",
  branch: "fix-mcp-schema-sanitization",
  bar: "▕░░░░░░░░░░",
  pct: "0%",
  cost: "$0",
  model: "fable-5 ♞",
};

const ALL_ON = { bar: true, repo: true, cost: true, branch: true, model: true, pct: true };

function widthOf(line: string): number {
  // Segments in tests are ANSI-free; plain length is the visible width.
  return [...line].length;
}

// ── composeFooterLine ────────────────────────────────────────────────

test("composes full footer, left/right justified to width", () => {
  const line = composeFooterLine(SEG, ALL_ON, 80);
  assert.equal(line, "iris ⑂ fix-mcp-schema-sanitization                    0%▕░░░░░░░░░░ $0 fable-5 ♞");
  assert.equal(widthOf(line), 80);
});

test("keeps at least one space between left and right when overflowing", () => {
  const line = composeFooterLine(SEG, ALL_ON, 10);
  assert.ok(line.includes("sanitization 0%")); // single-space gap
});

test("omits separator when branch is hidden", () => {
  const line = composeFooterLine(SEG, { ...ALL_ON, branch: false }, 60);
  assert.ok(line.startsWith("iris "));
  assert.ok(!line.includes("⑂"));
  assert.ok(!line.includes(SEG.branch));
});

test("omits separator when repo is hidden", () => {
  const line = composeFooterLine(SEG, { ...ALL_ON, repo: false }, 60);
  assert.ok(line.startsWith(SEG.branch));
  assert.ok(!line.includes("⑂"));
  assert.ok(!line.includes("iris"));
});

test("right side only: stays right-aligned via left padding", () => {
  const line = composeFooterLine(SEG, { ...ALL_ON, repo: false, branch: false }, 60);
  assert.equal(line, " ".repeat(34) + "0%▕░░░░░░░░░░ $0 fable-5 ♞");
  assert.equal(widthOf(line), 60);
});

test("left side only: no gap padding", () => {
  const line = composeFooterLine(
    SEG,
    { bar: false, repo: true, cost: false, branch: true, model: false, pct: false },
    60,
  );
  assert.equal(line, "iris ⑂ fix-mcp-schema-sanitization");
});

test("handles empty repo/branch segments (right-aligned)", () => {
  const seg = { ...SEG, repo: "", branch: "" };
  const line = composeFooterLine(seg, ALL_ON, 60);
  assert.equal(line.trimStart(), "0%▕░░░░░░░░░░ $0 fable-5 ♞");
  assert.equal(widthOf(line), 60);
});

// ── fitFooterLine: progressive hiding ────────────────────────────────

test("drop order is bar → repo → cost → branch → model → pct", () => {
  assert.deepEqual(FOOTER_DROP_ORDER, ["bar", "repo", "cost", "branch", "model", "pct"]);
});

test("wide terminal shows everything", () => {
  const line = fitFooterLine(SEG, 80);
  for (const s of [SEG.repo, SEG.branch, SEG.bar, SEG.pct, SEG.cost, SEG.model]) {
    assert.ok(line.includes(s), `expected "${s}" in "${line}"`);
  }
});

test("first drop: bar visual", () => {
  // Full line needs 61 (34 left + 1 gap + 26 right); without bar it's 50.
  const line = fitFooterLine(SEG, 55);
  assert.ok(!line.includes(SEG.bar));
  assert.ok(line.includes(SEG.repo));
  assert.ok(line.includes(SEG.pct));
  assert.ok(widthOf(line) <= 55);
});

test("second drop: repo name", () => {
  const line = fitFooterLine(SEG, 45);
  assert.ok(!line.includes(SEG.bar));
  assert.ok(!line.includes("iris"));
  assert.ok(line.includes(SEG.branch));
  assert.ok(widthOf(line) <= 45);
});

test("third drop: cost", () => {
  // branch(27) + gap(1) + pct(2)+cost+model needs > 40; without cost fits.
  const line = fitFooterLine(SEG, 40);
  assert.ok(!line.includes("$0"));
  assert.ok(line.includes(SEG.branch));
  assert.ok(widthOf(line) <= 40);
});

test("fourth drop: branch — remainder is right-aligned", () => {
  const line = fitFooterLine(SEG, 20);
  assert.ok(!line.includes(SEG.branch));
  assert.ok(line.includes(SEG.model));
  assert.ok(line.includes(SEG.pct));
  assert.equal(widthOf(line), 20); // padded to full width, flush right
  assert.ok(line.startsWith(" "));
});

test("fifth drop: model — pct survives, right-aligned", () => {
  const line = fitFooterLine(SEG, 4);
  assert.equal(line, "  0%");
});

test("pct is dropped last, leaving an empty line at extreme widths", () => {
  const seg = { ...SEG, pct: "100%" };
  const line = fitFooterLine(seg, 2);
  assert.equal(line, "");
});

test("every width from 1..90 renders without crashing", () => {
  for (let w = 1; w <= 90; w++) {
    assert.doesNotThrow(() => fitFooterLine(SEG, w));
  }
});

test("fitted lines never overflow once pct-only is reached", () => {
  for (let w = 4; w <= 90; w++) {
    const line = fitFooterLine(SEG, w);
    assert.ok(widthOf(line) <= w, `overflow at width ${w}: "${line}" (${widthOf(line)})`);
  }
});

// ── mcpCountsFromSnapshot ──
// Snapshots below match pi-mcp-adapter's McpStatusSnapshot (createMcpStatusSnapshot
// in mcp-status.ts). `total` is enabled servers, i.e. servers minus disabled.

const snapshot = (servers: Array<{ status: string; disabled?: boolean }>) => ({
  version: 1,
  servers: servers.map((s, i) => ({
    name: `s${i}`,
    status: s.status,
    toolCount: 3,
    disabled: s.disabled ?? false,
  })),
  totalTools: servers.length * 3,
  totalResources: 0,
  connectedCount: servers.filter((s) => s.status === "connected" && !s.disabled).length,
  disabledCount: servers.filter((s) => s.disabled).length,
});

test("MCP_STATUS_EVENT matches the adapter's versioned channel", () => {
  assert.equal(MCP_STATUS_EVENT, "pi-mcp-adapter/status/v1");
});

test("mcpCountsFromSnapshot: six lazy servers, none connected", () => {
  const snap = snapshot(Array.from({ length: 6 }, () => ({ status: "cached" })));
  assert.deepEqual(mcpCountsFromSnapshot(snap), { used: 0, total: 6 });
});

test("mcpCountsFromSnapshot: only 'connected' counts as used", () => {
  const snap = snapshot([
    { status: "connected" },
    { status: "cached" },
    { status: "not-connected" },
    { status: "needs-auth" },
    { status: "failed" },
    { status: "connected" },
  ]);
  assert.deepEqual(mcpCountsFromSnapshot(snap), { used: 2, total: 6 });
});

test("mcpCountsFromSnapshot: disabled servers leave the enabled total", () => {
  const snap = snapshot([
    { status: "connected" },
    { status: "cached" },
    { status: "disabled", disabled: true },
  ]);
  assert.deepEqual(mcpCountsFromSnapshot(snap), { used: 1, total: 2 });
});

test("mcpCountsFromSnapshot: empty snapshot on session shutdown", () => {
  assert.deepEqual(mcpCountsFromSnapshot(snapshot([])), { used: 0, total: 0 });
});

test("mcpCountsFromSnapshot: rejects a future snapshot version", () => {
  assert.equal(mcpCountsFromSnapshot({ ...snapshot([{ status: "connected" }]), version: 2 }), null);
});

test("mcpCountsFromSnapshot: rejects malformed or absent payloads", () => {
  assert.equal(mcpCountsFromSnapshot(undefined), null);
  assert.equal(mcpCountsFromSnapshot(null), null);
  assert.equal(mcpCountsFromSnapshot("MCP: 6 servers enabled"), null);
  assert.equal(mcpCountsFromSnapshot({ version: 1 }), null);
  assert.equal(mcpCountsFromSnapshot({ version: 1, servers: [] }), null);
});
