// GP-5 — end-user label for the mock AI provider.
//
// The mock narrative used to include an operator instruction ("Set
// AI_PROVIDER=…"). That string must not render. New mock answers are already
// the short label; this also rewrites a saved or in-flight answer that still
// carries the old wording. A real model answer is returned unchanged.

export const DEMO_AI_LABEL = "Demo AI: sample text, not generated from your data.";

const MOCK_OR_OPERATOR =
  /AI_PROVIDER|ANTHROPIC_API_KEY|Replit Secrets|Mock AI Provider|No real model call was made/i;

export function userVisibleAiText(text: string | null | undefined): string {
  if (text == null || text === "") return "";
  if (!MOCK_OR_OPERATOR.test(text)) return text;
  const kept = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !MOCK_OR_OPERATOR.test(line));
  if (kept.length === 0) return DEMO_AI_LABEL;
  return `${DEMO_AI_LABEL}\n\n${kept.join("\n\n")}`;
}
