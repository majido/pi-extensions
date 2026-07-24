---
name: verify-change
description: Verify an existing change is correct and covered by tests, then make it pass. Use after implementing a change (not before), when preparing a diff for review/PR, or when asked to "verify my change", "make sure this is tested", "run the tests and fix failures", or "check coverage for this diff". Audits coverage, runs targeted tests plus the project floor, and fixes code to pass — never weakens tests.
---

# Verify Change

Post-hoc verification of an existing diff. This is **not** TDD — the code
already exists; your job is to prove it works and is covered, and to fix the
code (not the tests) where it doesn't. For test-first development use
`test-driven-development` instead.

## When to use

- After a feature/fix is implemented, before review or PR
- As the "test" gate of a quality pipeline
- When a diff lacks tests for the behavior it changed

## Inputs

- The current diff (`git diff`, `git diff --cached`, or against the base branch:
  `git diff origin/main...HEAD`).
- The project's test/build/lint commands (discover them from `package.json`
  scripts, `AGENTS.md`, a Makefile, or the CI config — use whatever that
  ecosystem uses).

## 1. Coverage audit

Enumerate the behaviors the diff **adds or changes** — new branches, edge
cases, error paths, boundary conditions. For each, confirm a test exists that
would fail if that behavior regressed.

Write the missing tests, targeting the **intended** behavior:

- A new test should pass immediately against the existing code.
- If a newly written test **fails**, you found a bug — fix the **code**, not
  the test. (This is the one place verify-change overlaps TDD's prove-it
  pattern.)

Follow good-test guidance (see `test-driven-development` for the full version):
test state/outcomes not interactions, DAMP over DRY, Arrange-Act-Assert, one
concept per test, descriptive names, prefer real implementations over mocks.

## 2. Select and run targeted tests

Pick the specs/suites actually relevant to this diff and run them first — fast
feedback before the full floor. Record what you picked and why (the ship
pipeline surfaces this as the stage one-liner).

## 3. Run the floor

Run the project's full configured verification command (the non-negotiable
gate). If the project expects formatting/pre-commit to run with the tests,
include it in the same invocation (format-then-test).

## 4. Fix loop

For any failure:

1. Diagnose root cause (see `debugging-and-error-recovery` for method).
2. Fix the **code** to satisfy the test.
3. Re-run the relevant test, then the floor.

**Never** weaken, skip, `@Ignore`, or delete a test to go green. If a test is
genuinely wrong (tests the old/incorrect behavior), correcting it is a
deliberate change — state the justification explicitly.

If a failure reveals a **design problem** (the change is wrong, not just
buggy), stop and escalate rather than forcing a fix.

## 5. Report

- Behaviors covered / tests added
- Targeted suites run + result
- Floor result
- Fixes applied (with reasoning)
- Any escalated design concern

## Red flags

- New tests that pass without exercising the changed behavior
- Weakening assertions or skipping tests to get green
- "All tests pass" with no test actually run
- Re-running an unchanged suite repeatedly for reassurance
- Changed behavior with no corresponding test
