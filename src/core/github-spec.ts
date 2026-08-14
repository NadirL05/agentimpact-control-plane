/**
 * Redaction des specifications GitHub (semaine 6), sans I/O.
 *
 * Une specification sans critere d'acceptation testable n'est pas une
 * specification : la regle vit ici pour etre verifiee par test.
 */

export const AGENT_LABEL = 'agent-ready';

export type IssueSpec = {
  repo: string;
  title: string;
  need: string;
  acceptance_criteria: string[];
  edge_cases?: string[];
};

export const PROFILE = 'agentimpact-dev';

export function renderIssueBody(spec: IssueSpec): string {
  const edges = spec.edge_cases ?? [];

  return [
    '## Besoin',
    spec.need,
    '',
    "## Critères d'acceptation",
    ...spec.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`),
    '',
    '## Cas limites',
    edges.length > 0
      ? edges.map((edge) => `- ${edge}`).join('\n')
      : '- _à compléter avant de lancer le développement_',
    '',
    '---',
    `Spécification préparée par le control plane AgentImpact (profil \`${PROFILE}\`),`,
    'après validation humaine. Le merge reste manuel.',
  ].join('\n');
}


/** Fichiers de test presents dans une PR : critere de recevabilite. */
export function hasTestFiles(filenames: string[]): boolean {
  return filenames.some((filename) =>
    /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/.test(filename),
  );
}
