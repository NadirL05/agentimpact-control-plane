import { getWorkflows, Workflow } from './workflows.js';

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed';
  steps: {
    stepId: number;
    name: string;
    status: WorkflowStepStatus;
    startedAt?: string;
    completedAt?: string;
    result?: string;
  }[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  context: Record<string, any>;
}

const runs = new Map<string, WorkflowRun>();
let runCounter = 0;

// Registry des handlers de steps
const stepHandlers = new Map<string, (ctx: WorkflowRun, stepName: string) => Promise<string>>();

export function registerStepHandler(stepName: string, handler: (ctx: WorkflowRun, stepName: string) => Promise<string>) {
  stepHandlers.set(stepName, handler);
}

// Handlers par défaut pour les steps standards
registerStepHandler('collect:logs_and_metrics', async () => {
  // Simulation: collecte des logs et métriques
  return 'Logs and metrics collected';
});

registerStepHandler('verify:policies', async () => {
  // Simulation: vérification des policies
  return 'Policies verified';
});

registerStepHandler('generate:audit_report', async () => {
  // Simulation: génération du rapport
  return 'Audit report generated';
});

registerStepHandler('notify:operators_on_critical_issues', async () => {
  // Simulation: notification
  return 'Operators notified';
});

registerStepHandler('create:hermes_profile', async () => {
  return 'Hermes profile created';
});

registerStepHandler('configure:access_and_permissions', async () => {
  return 'Access and permissions configured';
});

registerStepHandler('verify:compliance', async () => {
  return 'Compliance verified';
});

registerStepHandler('activate:agent_and_notify', async () => {
  return 'Agent activated and notifications sent';
});

registerStepHandler('run:ci_checks', async () => {
  return 'CI checks passed';
});

registerStepHandler('review:peer', async () => {
  return 'Peer review completed';
});

registerStepHandler('review:security_if_policy_or_profile_change', async () => {
  return 'Security review completed';
});

registerStepHandler('merge:after_approval', async () => {
  return 'Changes merged after approval';
});

registerStepHandler('validate:prerequisites', async () => {
  return 'Prerequisites validated';
});

registerStepHandler('execute:deploy_pipeline', async () => {
  return 'Deploy pipeline executed';
});

registerStepHandler('verify:post_deploy_sanity', async () => {
  return 'Post-deploy sanity checks passed';
});

registerStepHandler('notify:update_dashboard', async () => {
  return 'Dashboard updated';
});

export async function startWorkflow(workflowId: string, context: Record<string, any> = {}): Promise<WorkflowRun> {
  const workflows = getWorkflows();
  const workflow = workflows.find((w) => w.id === workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }

  runCounter += 1;
  const runId = `run-${runCounter}`;

  const run: WorkflowRun = {
    id: runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    steps: workflow.steps.map((step, idx) => ({
      stepId: idx,
      name: step,
      status: 'pending',
    })),
    startedAt: new Date().toISOString(),
    context,
  };

  runs.set(runId, run);

  // Exé·¢cuter les steps en séquence
  executeSteps(run, workflow).catch((err) => {
    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = err.message;
  });

  return run;
}

async function executeSteps(run: WorkflowRun, workflow: Workflow) {
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    step.status = 'running';
    step.startedAt = new Date().toISOString();

    try {
      // Exé·¢cuter le handler du step
      const handler = stepHandlers.get(step.name);
      if (!handler) {
        throw new Error(`No handler for step: ${step.name}`);
      }
      const result = await handler(run, step.name);
      step.result = result;
      step.status = 'completed';
    } catch (err: any) {
      step.status = 'failed';
      step.result = err.message;
      throw err;
    }

    step.completedAt = new Date().toISOString();
  }

  run.status = 'completed';
  run.completedAt = new Date().toISOString();
}

export function getWorkflowRun(runId: string): WorkflowRun | undefined {
  return runs.get(runId);
}

export function listWorkflowRuns(): WorkflowRun[] {
  return Array.from(runs.values());
}
