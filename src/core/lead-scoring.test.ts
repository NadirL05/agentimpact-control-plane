import { describe, it, expect } from 'vitest';
import {
  buildFiche,
  guessSector,
  priorityOf,
  renderDraft,
  scoreLead,
  type LeadRow,
} from './lead-scoring.js';

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    company_name: null,
    contact_name: null,
    contact_role: null,
    website: null,
    email: null,
    linkedin_url: null,
    source: null,
    signal: null,
    pain_point: null,
    status: 'new',
    priority: 'medium',
    fullenrich_status: null,
    contact_work_emails: null,
    contact_phones: null,
    created_at: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

describe('scoreLead', () => {
  it('un lead vide vaut zero et liste tout ce qui manque', () => {
    const { score, preuve, manques } = scoreLead(lead());
    expect(score).toBe(0);
    expect(preuve).toHaveLength(0);
    expect(manques).toContain('email professionnel');
    expect(manques).toContain('profil LinkedIn');
  });

  it('chaque point marque produit une preuve : jamais de score sans justification', () => {
    const { score, preuve } = scoreLead(
      lead({ company_name: 'Augely', website: 'https://augely.fr' }),
    );
    expect(score).toBe(20);
    expect(preuve).toHaveLength(2);
  });

  it('plafonne a 100 meme si tous les signaux sont presents', () => {
    const { score } = scoreLead(
      lead({
        company_name: 'Augely',
        website: 'https://augely.fr',
        linkedin_url: 'https://linkedin.com/in/x',
        email: 'a@b.fr',
        contact_work_emails: ['a@b.fr'],
        contact_phones: ['+33600000000'],
        signal: 'levee de fonds',
        contact_role: 'DG',
      }),
    );
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(100);
  });

  it('un email trouve par enrichissement compte autant qu un email direct', () => {
    const viaEnrich = scoreLead(lead({ contact_work_emails: ['a@b.fr'] })).score;
    const viaChamp = scoreLead(lead({ email: 'a@b.fr' })).score;
    expect(viaEnrich).toBe(viaChamp);
  });

  it('un tableau vide d emails ne vaut pas un email', () => {
    expect(scoreLead(lead({ contact_work_emails: [] })).score).toBe(0);
  });

  it('une valeur non-tableau ne fait pas planter le comptage', () => {
    expect(() => scoreLead(lead({ contact_phones: 'pas un tableau' as unknown }))).not.toThrow();
    expect(scoreLead(lead({ contact_phones: 'pas un tableau' as unknown })).score).toBe(0);
  });
});

describe('priorityOf', () => {
  it('respecte les seuils aux bornes exactes', () => {
    expect(priorityOf(70)).toBe('A');
    expect(priorityOf(69)).toBe('B');
    expect(priorityOf(45)).toBe('B');
    expect(priorityOf(44)).toBe('C');
    expect(priorityOf(0)).toBe('C');
  });
});

describe('guessSector', () => {
  it('reconnait un cabinet comptable sur le nom', () => {
    expect(guessSector(lead({ company_name: 'Augely Expert-Comptable' }))).toBe('Cabinet comptable');
  });

  it('reconnait le secteur via le role du contact', () => {
    expect(guessSector(lead({ contact_role: 'Avocat associe' }))).toBe('Juridique');
  });

  it('reconnait le secteur via le site quand le nom est neutre', () => {
    expect(guessSector(lead({ company_name: 'SARL Martin', website: 'https://piscines-martin.fr' }))).toBe(
      'Artisanat / BTP',
    );
  });

  it('assume son ignorance plutot que de deviner', () => {
    expect(guessSector(lead({ company_name: 'Zorglub SA' }))).toBe('Secteur non déterminé');
  });
});

describe('buildFiche', () => {
  it('dit explicitement quand le signal manque, au lieu de l inventer', () => {
    const fiche = buildFiche(lead({ company_name: 'Augely' }));
    expect(fiche.signal_detecte).toMatch(/Aucun signal/);
  });

  it('conserve le signal reel quand il existe', () => {
    const fiche = buildFiche(lead({ company_name: 'Augely', signal: 'recrute 3 comptables' }));
    expect(fiche.signal_detecte).toBe('recrute 3 comptables');
  });

  it('un pain_point saisi a la main prime sur le probleme type du secteur', () => {
    const fiche = buildFiche(
      lead({ company_name: 'Augely Expert-Comptable', pain_point: 'facturation manuelle' }),
    );
    expect(fiche.probleme_probable).toBe('facturation manuelle');
  });

  it('tombe sur le use case generique si le secteur est inconnu', () => {
    const fiche = buildFiche(lead({ company_name: 'Zorglub SA' }));
    expect(fiche.use_case_agentimpact).toMatch(/Diagnostic IA/);
  });
});

describe('renderDraft', () => {
  const base = lead({
    company_name: 'Augely Conseils',
    contact_name: 'Gilles Clapasson',
    contact_role: 'Expert-comptable associé',
    website: 'https://augely.fr',
    email: 'g@augely.fr',
  });

  it('utilise le prenom seul, pas le nom complet', () => {
    const { body } = renderDraft(buildFiche(base), base, 'email');
    expect(body).toContain('Bonjour Gilles,');
    expect(body).not.toContain('Clapasson');
  });

  it('ne repete pas la mention de validation humaine', () => {
    const { body } = renderDraft(buildFiche(base), base, 'email');
    expect(body.match(/validation humaine/gi)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('reste poli quand le nom du contact est absent', () => {
    const sansNom = { ...base, contact_name: null };
    const { body } = renderDraft(buildFiche(sansNom), sansNom, 'email');
    expect(body.startsWith('Bonjour,')).toBe(true);
    expect(body).not.toMatch(/Bonjour bonjour/i);
  });

  it('salue par le prenom des qu il est connu', () => {
    const { body } = renderDraft(buildFiche(base), base, 'email');
    expect(body.startsWith('Bonjour Gilles,')).toBe(true);
  });

  it('un nom compose ne coupe pas la salutation', () => {
    const compose = { ...base, contact_name: '  Jean-Pierre  Martin ' };
    const { body } = renderDraft(buildFiche(compose), compose, 'email');
    expect(body.startsWith('Bonjour Jean-Pierre,')).toBe(true);
  });

  it('le message LinkedIn est plus court que le mail', () => {
    const linkedin = renderDraft(buildFiche(base), base, 'linkedin').body;
    const email = renderDraft(buildFiche(base), base, 'email').body;
    expect(linkedin.length).toBeLessThan(email.length);
  });

  it('le sujet du mail porte le nom de l entreprise', () => {
    const { subject } = renderDraft(buildFiche(base), base, 'email');
    expect(subject).toContain('Augely Conseils');
  });
});
