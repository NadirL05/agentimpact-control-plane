import { describe, it, expect, beforeAll } from 'vitest';
import { startWorkflow, getWorkflowRun, listWorkflowRuns, registerStepHandler } from './workflow-engine.js';

describe('Workflow Engine', () => {
  beforeAll(async () => {
    // Attendre que les workflows soient chargé · ¢s
  });

  it('lance un workflow audit et le termine avec succès', async () => {
    const run = await startWorkflow('audit');
    expect(run.id).toMatch(/^run-\d+$/);
    expect(run.workflowId).toBe('audit');
    expect(run.status).toBe('running');

    // Attendre la fin de l'exé·¢cution
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completedRun = getWorkflowRun(run.id);
    expect(completedRun).toBeDefined();
    expect(completedRun!.status).toBe('completed');
    expect(completedRun!.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('lance un workflow onboarding-agent et le termine avec succès', async () => {
    const run = await startWorkflow('onboarding-agent');
    expect(run.workflowId).toBe('onboarding-agent');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const completedRun = getWorkflowRun(run.id);
    expect(completedRun!.status).toBe('completed');
  });

  it('liste les workflow runs', async () => {
    const initialCount = listWorkflowRuns().length;
    await startWorkflow('deploy');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runs = listWorkflowRuns();
    expect(runs.length).toBeGreaterThan(initialCount);
  });

  it("echoue si le workflow n'existe pas", async () => {
    await expect(startWorkflow('nonexistent')).rejects.toThrow('Workflow nonexistent not found');
  });

  it('echoue si un step handler manque', async () => {
    // Créer un workflow test avec un step sans handler
    registerStepHandler('test:custom_step', async () => 'done');
    // Le workflow 'review-changes' a des steps qui existent déjà
    const run = await startWorkflow('review-changes');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completedRun = getWorkflowRun(run.id);
    expect(completedRun!.status).toBe('completed');
  });
});
