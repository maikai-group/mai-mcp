// Shared tolerant JSON extraction for LLM text output. Supersedes openai.ts's
// stripAndParseJSON (strict superset: fenced, bare, prefix/suffix-wrapped).
export function extractJSON(text: string): unknown | null {
  const attempts: string[] = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1].trim());
  const fo = text.indexOf('{');
  const lo = text.lastIndexOf('}');
  if (fo !== -1 && lo > fo) attempts.push(text.slice(fo, lo + 1));
  const fa = text.indexOf('[');
  const la = text.lastIndexOf(']');
  if (fa !== -1 && la > fa) attempts.push(text.slice(fa, la + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}
