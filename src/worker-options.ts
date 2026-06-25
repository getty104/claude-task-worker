export interface WorkerOptions {
  projectId?: string;
  branch?: string;
  projects?: Record<string, string>;
}

export function resolveBranch(
  issueProjectIds: string[],
  projects: Record<string, string> | undefined,
  cliBranch: string | undefined,
  defaultBranch: string,
): string {
  if (projects) {
    for (const pid of issueProjectIds) {
      const branch = projects[pid];
      if (branch) return branch;
    }
  }
  if (cliBranch) return cliBranch;
  return defaultBranch;
}

export function needsProjectLookup(options: WorkerOptions): boolean {
  return Boolean(options.projectId || (options.projects && Object.keys(options.projects).length > 0));
}
