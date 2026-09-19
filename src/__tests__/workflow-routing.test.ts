import { describe, expect, it } from 'vitest';
import { renderWorkflowHint, selectWorkflow, WORKFLOW_HINT_MAX } from '../workflow-routing.js';

describe('ordinary task descriptions', () => {
  it.each([
    ["Please address the plan review findings.", "receiving-plan-review"],
    ["Fix the code review findings for this patch.", "mai-receiving-code-review"],
    ["Check that the implementation matches the approved plan.", "plan-compliance"],
    ["Run a plan review cycle for the export feature.", "plan-review-cycle"],
    ["Could you review this implementation plan?", "plan-review"],
    ["Implement the approved plan for bulk exports.", "plan-execute"],
    ["Turn this settled spec into an implementation plan.", "write-plan"],
    ["Write an implementation plan from these requirements.", "write-plan"],
    ["Design tests for cancellation and retry behavior.", "mai-test-design"],
    ["Exercise the user journeys in our staging app.", "mai-e2e"],
    ["Review the database migration for transaction risks.", "mai-specialist-review"],
    ["Review this diff before I merge it.", "mai-code-review"],
    ["Why is CI failing after the upgrade?", "mai-debug"],
    ["This is broken after the last release.", "mai-debug"],
    ["Can you please trace the request flow through the code?", "mai-explore"],
    ["Compare database options for our service.", "mai-research"],
    ["Help me design a bulk export feature.", "mai-design"],
    ["Check whether this fix is ready to ship.", "mai-verify"],
    ["Update the docs to match the new CLI behavior.", "mai-docs-sync"],
    ["Audit our installed skills for overlapping triggers.", "mai-skill-audit"],
    ["Turn these reviewed lessons into reusable workflow guidance.", "mai-learn-workflow"],
    ["Let's review this diff.", "mai-code-review"],
    ["Review the user's code changes.", "mai-code-review"],
  ])('routes %s to %s', (prompt, expected) => {
    expect(selectWorkflow(prompt)).toBe(expected);
    const hint = renderWorkflowHint(prompt);
    expect(hint).toContain('`' + expected + '`');
    expect(hint).toContain('Advisory only');
    expect(hint).not.toContain(prompt);
    expect(hint.length).toBeLessThanOrEqual(WORKFLOW_HINT_MAX);
  });

  it.each([
    "",
    "Thanks!",
    "Fix the spelling in this heading.",
    "Plan a holiday in Toronto.",
    "What does the word debugging mean?",
    "Do not review this diff; just count its lines.",
    "Please do not implement the plan.",
    "\"Review this diff\" is an example sentence; translate it.",
    "Summarize this log: debug the service and execute the plan.",
    "Explain how skill selection works.",
    "Change the button color to blue.",
    "The docs mention a security review and a test plan. Count the words.",
    "Review the quoted sentence \"implement the plan\" for grammar.",
    "Review this diff without a security review.",
    "Review the sentence 'implement the plan' for grammar.",
    "Review the sentence `implement the plan` for grammar.",
    "Review the sentence “implement the plan” for grammar.",
    "Review the sentence ‘implement the plan’ for grammar.",
    "Please review this diff, not the implementation plan.",
    "Review this diff; do not audit security.",
    "Review this diff; don't start a security review.",
    "Review this diff excluding the security changes.",
    "Review this diff rather than the plan.",
    "Review this diff instead of the plan.",
  ])('leaves %j without a suggestion', (prompt) => {
    expect(selectWorkflow(prompt)).toBeNull();
    expect(renderWorkflowHint(prompt)).toBe('');
  });
});
