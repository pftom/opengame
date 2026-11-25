/** Explicit copy metadata; never infer it from a channel or the last copy. */
export const templateEntries = ['website', 'editor'] as const;
export type TemplateEntry = typeof templateEntries[number];
export const copyAttemptPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export function withTemplateAttribution(prompt: string, templateId: string, copyAttemptId: string, templateEntry: TemplateEntry): string {
  const args = JSON.stringify({ templateId, copyAttemptId, templateEntry });
  const legacyArgs = JSON.stringify({ templateId });
  return `If OpenMotion is not connected, follow the installation/connection instructions below first. Once connected, call openmotion_get_template with templateId; include copyAttemptId and templateEntry only if each is declared in the connected tool's input schema:\n${args}\n\nCopy attribution is optional. If the tool rejects optional metadata as unknown or unsupported arguments, retry once with only ${legacyArgs} and continue using the template. Keep the same copy metadata for retries that support it. Never block installation or template use, or require an upgrade solely for attribution.\n\n${prompt}`;
}
