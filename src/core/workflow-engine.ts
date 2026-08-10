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
  }[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const runs = new Map<string, WorkflowRun>();
let runCounter = 0;

export async function startWorkflow(workflowId: string): Promise<WorkflowRun> {
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
  };

  runs.set(runId, run);

  // Exé·¢cuter les steps en séquence (simulation)
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

    // Simulation de l'exé·¢cution du step (1s)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    step.status = 'completed';
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
