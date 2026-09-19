/** Conservative hints for task-scoped prime; the host owns skill invocation. */
const ROUTES = [
  ['receiving-plan-review', /^(?:address|fix|resolve|apply|repair)\b.{0,80}\bplan\b.{0,40}\b(?:findings|feedback)\b/],
  ['mai-receiving-code-review', /^(?:address|fix|resolve|apply|repair)\b.{0,80}\b(?:code|pr)\s+review\b.{0,40}\b(?:findings|feedback|comments)\b/],
  ['plan-compliance', /^(?:check|audit|verify)\b.{0,80}\b(?:matches?|follows?|compliance|fidelity|drift)\b.{0,40}\bplan\b/],
  ['plan-review-cycle', /^(?:run|coordinate|start)\b.{0,40}\bplan\s+review\s+cycle\b/],
  ['plan-review', /^(?:review|critique|assess)\b.{0,40}\b(?:implementation\s+)?plan\b/],
  ['plan-execute', /^(?:execute|implement|run|build|start executing)\b.{0,40}\bplan\b/],
  ['write-plan', /^(?:write|create|make|turn|convert)\b.{0,100}\b(?:spec|specification|requirements)\b.{0,80}\bplan\b|^(?:write|create|make)\b.{0,40}\bplan\b.{0,80}\b(?:spec|specification|requirements)\b/],
  ['mai-test-design', /^(?:design|plan|identify|map)\b.{0,60}\b(?:tests?|test coverage|test cases)\b/],
  ['mai-e2e', /^(?:run|exercise|test|verify)\b.{0,80}\b(?:end.to.end|e2e|user journeys?)\b/],
  ['mai-specialist-review', /^(?:review|audit|assess)\b.{0,80}\b(?:security|database|reliability|retrieval|test adequacy)\b/],
  ['mai-code-review', /^(?:review|audit|inspect)\b.{0,60}\b(?:diff|code|pull request|pr|changes)\b/],
  ['mai-debug', /^(?:debug|diagnose|investigate)\b|^why\b.{0,80}\b(?:failing|fails?|broken|crash(?:es|ing)?|timing out)\b|^(?:this|the build|ci|the tests?)\b.{0,40}\b(?:broken|failing|crashing)\b/],
  ['mai-explore', /^(?:trace|explore|understand)\b.{0,80}\b(?:code|flow|request|implementation|behavior|behaviour|cancellation)\b|^explain\b.{0,80}\b(?:code|flow|implementation|cancellation)\b/],
  ['mai-research', /^(?:research|compare|evaluate)\b.{0,100}\b(?:libraries|frameworks|apis?|technical|database|approaches|options|dependencies)\b/],
  ['mai-design', /^(?:design|scope|plan)\b.{0,100}\b(?:feature|architecture|api|workflow|integration)\b/],
  ['mai-verify', /^(?:verify|validate|check|confirm)\b.{0,80}\b(?:fix|release|ready to ship|readiness|implementation|checks|gates)\b/],
  ['mai-docs-sync', /^(?:update|sync|align|refresh)\b.{0,60}\b(?:docs|documentation|readme|examples)\b.{0,80}\b(?:behavior|behaviour|implementation|api|cli|changes)\b/],
  ['mai-skill-audit', /^(?:audit|assess|review)\b.{0,60}\bskills?\b/],
  ['mai-learn-workflow', /^(?:turn|convert|capture)\b.{0,60}\breviewed lessons?\b.{0,80}\b(?:workflow|guidance|skill)\b/],
] as const;

export type WorkflowName = (typeof ROUTES)[number][0];
export const WORKFLOW_HINT_MAX = 200;

/** A deliberately incomplete heuristic, not an authorization decision. */
export function selectWorkflow(task: string): WorkflowName | null {
  const normalized = task.slice(0, 2_000).toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:please|can you|could you|would you|help me|i want to|let's)\s+)+/, '');
  // Quoted/excluded terms are not evidence of intent. Abstain rather than guess
  // which clause the action owns; the host can still select a skill from context.
  // Straight apostrophes inside words (e.g. user's) are not quotation delimiters.
  if (/["`“”‘’]|(?:^|[^a-z])'|'(?:$|[^a-z])/.test(normalized)
      || /\b(?:not|never|no|without|except|excluding|avoid(?:ing)?|\w+n't)\b|\b(?:instead of|rather than)\b/.test(normalized)) {
    return null;
  }
  return ROUTES.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

/** Fixed text only: never interpolate the task description into the hint. */
export function renderWorkflowHint(task: string): string {
  const skill = selectWorkflow(task);
  return skill === null ? ''
    : `Workflow suggestion: \`${skill}\`. If available, read its SKILL.md and check its prerequisites. Advisory only; follow the user's scope.`;
}
