import { budgetText } from '../read-budget.js';
import type { ReadBudget } from '../read-budget.js';
import type { Report, Evidence } from './types.js';
const recovery = 'inspect the cited node/decision with ordinary mai tools, or call mai_navigate with fewer seeds and a narrower question';
function block(item: Evidence): string {
  const excerpted = item.truncated || item.text.length > 320;
  return `\n\n### ${item.id} [${item.kind}]\nReference: ${item.ref}\nFreshness: ${item.freshness}\nHash: ${item.hash ?? 'not supplied'}\nmodel relevance=${item.score ?? 'unassessed'}; unverified inference\n${item.text.slice(0, 320)}${excerpted ? '\n[excerpt; inspect original reference]' : ''}`;
}
export function renderNavigation(report: Report, budget: ReadBudget): string {
  const candidates = report.evidence.slice(0, 10);
  const header = (shown: number): string => {
    const localOmissions = report.evidence.length - shown;
    const shortened = candidates.slice(0, shown).some(item => item.truncated || item.text.length > 320);
    const partial = localOmissions > 0 || shortened;
    const status = partial && report.status === 'evidence' ? 'partial' : report.status;
    return `# Navigation: ${status} — bounded evidence; not exhaustive\nStop: ${report.stop}\n`
      + (partial ? 'Rendering omitted or excerpted evidence; coverage is partial.\n' : '')
      + report.gaps.slice(0, 6).map(gap => `- ${gap.slice(0, 180)}`).join('\n')
      + (report.gaps.length > 6 ? `\n${report.gaps.length - 6} further gaps.` : '')
      + `\nModel: ${report.model ?? 'not evaluated'}; rubric: ${report.rubric}`
      + `\nEvidence shown/total: ${shown}/${report.evidence.length}; omitted: ${report.omitted + localOmissions}; actions remaining: ${report.actionsRemaining}`
      + `\nEvaluations: ${report.evaluations}; HTTP attempts: ${report.attempts}; known tokens: input=${report.inputTokens}, output=${report.outputTokens}`
      + `\nTrace: ${report.trace.join(' → ') || 'none'}\nRecovery: ${recovery}`;
  };
  let shown = candidates.length;
  let result = '';
  while (shown >= 0) {
    result = header(shown) + candidates.slice(0, shown).map(block).join('');
    if (result.length <= budget.charBudget) break;
    shown--;
  }
  if (shown < 0) {
    const status = report.status === 'evidence' && report.evidence.length ? 'partial' : report.status;
    result = `Navigation: ${status}; not exhaustive. Evidence shown/total: 0/${report.evidence.length}; omitted: ${report.omitted + report.evidence.length}. Stop: ${report.stop}. Recovery: inspect original references with ordinary mai tools.`;
  }
  return budgetText(budget, result, recovery);
}
