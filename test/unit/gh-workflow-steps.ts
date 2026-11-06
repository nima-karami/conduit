/**
 * Minimal GitHub Actions workflow step extraction (no YAML dependency).
 */

export type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  shell?: string;
};

function stripStepPrefix(line: string): string {
  return line.trimEnd().replace(/^- /, '');
}

function parseStepBlock(lines: string[]): WorkflowStep {
  const step: WorkflowStep = {};
  let runLines: string[] | null = null;
  let inEnv = false;
  for (const raw of lines) {
    const trimmed = stripStepPrefix(raw.trimEnd());
    if (trimmed.startsWith('uses:')) {
      step.uses = trimmed.slice('uses:'.length).trim();
      inEnv = false;
      continue;
    }
    if (trimmed.startsWith('run:')) {
      inEnv = false;
      const inline = trimmed.slice('run:'.length).trim();
      if (inline === '|' || inline === '>') {
        runLines = [];
      } else {
        step.run = inline;
      }
      continue;
    }
    if (runLines !== null) {
      runLines.push(trimmed);
      continue;
    }
    if (trimmed.startsWith('name:')) {
      step.name = trimmed.slice('name:'.length).trim();
      inEnv = false;
    } else if (trimmed.startsWith('if:')) {
      step.if = trimmed.slice('if:'.length).trim();
      inEnv = false;
    } else if (trimmed.startsWith('shell:')) {
      step.shell = trimmed.slice('shell:'.length).trim();
      inEnv = false;
    } else if (trimmed === 'env:') {
      step.env = step.env ?? {};
      inEnv = true;
    } else if (inEnv && step.env) {
      const m = /^(\w+):\s*(.*)$/.exec(trimmed);
      if (m) step.env[m[1]] = m[2].trim();
    }
  }
  if (runLines?.length) step.run = runLines.join('\n').trimEnd();
  return step;
}

/** Steps of `jobs.<jobId>` in a workflow file. */
export function jobSteps(yml: string, jobId: string): WorkflowStep[] {
  const lines = yml.split('\n');
  let inJobs = false;
  let inJob = false;
  let inSteps = false;
  const steps: WorkflowStep[] = [];
  let block: string[] = [];

  const flush = () => {
    if (block.length) {
      steps.push(parseStepBlock(block));
      block = [];
    }
  };

  for (const line of lines) {
    if (!inJobs) {
      if (line === 'jobs:') inJobs = true;
      continue;
    }
    if (!inJob) {
      if (new RegExp(`^  ${jobId}:\\s*$`).test(line)) inJob = true;
      continue;
    }
    if (inJob && !inSteps) {
      if (/^ {2}\w/.test(line) && !line.startsWith(`  ${jobId}`)) {
        inJob = false;
        continue;
      }
      if (/^ {4}steps:\s*$/.test(line)) {
        inSteps = true;
        continue;
      }
    }
    if (inSteps) {
      if (/^ {2}\w/.test(line) && !line.startsWith('    ')) {
        flush();
        inSteps = false;
        inJob = false;
        continue;
      }
      if (/^ {4}\w/.test(line) && !line.startsWith('      ')) {
        flush();
        inSteps = false;
        inJob = false;
        continue;
      }
      if (/^ {6}- /.test(line)) {
        flush();
        block = [line.replace(/^ {6}- /, '')];
      } else if (block.length && /^ {8}/.test(line)) {
        block.push(line.trimStart());
      } else if (block.length && line.trim() === '') {
        block.push('');
      }
    }
  }
  flush();
  return steps;
}

export function stepIndex(steps: WorkflowStep[], pred: (s: WorkflowStep) => boolean): number {
  return steps.findIndex(pred);
}
