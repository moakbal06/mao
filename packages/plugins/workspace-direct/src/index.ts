import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@moakbal/mao-core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
const DEFAULT_BRANCH_FALLBACKS = ["main", "master"];

export const manifest = {
  name: "direct",
  slot: "workspace" as const,
  description: "Workspace plugin: direct repository workspace",
  version: "0.1.0",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
  return stdout.trimEnd();
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function dedupeBranches(branches: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    const trimmed = branch?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function hasOriginRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, "remote", "get-url", "origin");
    return true;
  } catch {
    return false;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const branch = await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
    if (!branch || branch === "HEAD") return null;
    return branch.trim();
  } catch {
    return null;
  }
}

async function ensureRepoHasCommits(repoPath: string): Promise<void> {
  try {
    await git(repoPath, "rev-parse", "--verify", "HEAD");
  } catch {
    throw new Error(
      "Repository has no commits yet. Create an initial commit on the default branch and push it before starting the orchestrator.",
    );
  }
}

async function resolveRemoteDefaultBranch(
  remoteUrl: string,
  candidates: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--symref", remoteUrl, "HEAD"],
      { timeout: GIT_TIMEOUT },
    );
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("ref: "));
    if (line) {
      const tokens = line.split(" ").filter(Boolean);
      const refToken = tokens[1];
      if (refToken?.startsWith("refs/heads/")) {
        return refToken.slice("refs/heads/".length);
      }
    }
  } catch {
    // Fall through to candidate probing
  }

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--heads", remoteUrl, candidate],
        { timeout: GIT_TIMEOUT },
      );
      if (stdout.trim().length > 0) return candidate;
    } catch {
      // Ignore and continue probing
    }
  }

  return undefined;
}

async function resolveBaseRef(
  repoPath: string,
  defaultBranch: string,
  options?: { branch?: string; hasOrigin?: boolean },
): Promise<string> {
  const hasOrigin = options?.hasOrigin ?? (await hasOriginRemote(repoPath));
  const candidates = dedupeBranches([defaultBranch, ...DEFAULT_BRANCH_FALLBACKS]);

  if (hasOrigin) {
    if (options?.branch) {
      const remoteBranch = `origin/${options.branch}`;
      if (await refExists(repoPath, remoteBranch)) return remoteBranch;
    }

    for (const candidate of candidates) {
      const remoteDefaultBranch = `origin/${candidate}`;
      if (await refExists(repoPath, remoteDefaultBranch)) return remoteDefaultBranch;
    }
  }

  for (const candidate of candidates) {
    const localDefaultBranch = `refs/heads/${candidate}`;
    if (await refExists(repoPath, localDefaultBranch)) return localDefaultBranch;
  }

  if (hasOrigin) {
    try {
      const remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      if (remoteUrl) {
        const remoteDefault = await resolveRemoteDefaultBranch(remoteUrl, candidates);
        if (remoteDefault) {
          const remoteRef = `origin/${remoteDefault}`;
          if (await refExists(repoPath, remoteRef)) return remoteRef;
          const localRef = `refs/heads/${remoteDefault}`;
          if (await refExists(repoPath, localRef)) return localRef;
        }
      }
    } catch {
      // Ignore and fall through
    }
  }

  const headBranch = await getCurrentBranch(repoPath);
  if (headBranch) {
    const remoteHead = `origin/${headBranch}`;
    if (hasOrigin && (await refExists(repoPath, remoteHead))) return remoteHead;
    const localHead = `refs/heads/${headBranch}`;
    if (await refExists(repoPath, localHead)) return localHead;
  }

  try {
    await git(repoPath, "rev-parse", "--verify", "HEAD");
    return "HEAD";
  } catch {
    throw new Error(
      `Unable to resolve base ref for default branches: ${candidates.join(", ")}`,
    );
  }
}

async function ensureRepoAvailable(repoPath: string): Promise<void> {
  if (!existsSync(repoPath)) {
    throw new Error(
      `Project path "${repoPath}" does not exist in direct workspace mode. Clone the repo first or switch to worktree mode.`,
    );
  }
  if (!lstatSync(repoPath).isDirectory()) {
    throw new Error(`Project path "${repoPath}" exists but is not a directory`);
  }
  try {
    await git(repoPath, "rev-parse", "--is-inside-work-tree");
  } catch {
    throw new Error(`Project path "${repoPath}" is not a git repository`);
  }
}

async function ensureCleanWorkingTree(repoPath: string): Promise<void> {
  // Ignore untracked files so local AO config files (.env, agent-orchestrator.yaml)
  // do not block direct mode on first run.
  const status = await git(repoPath, "status", "--porcelain", "--untracked-files=no");
  if (status.trim().length > 0) {
    throw new Error(
      `Direct workspace mode requires a clean tracked working tree at "${repoPath}". Commit/stash tracked changes first.`,
    );
  }
}

async function checkoutOrCreateBranch(
  repoPath: string,
  branch: string,
  baseRef: string,
  hasOrigin: boolean,
  defaultBranch: string,
): Promise<void> {
  const currentBranch = await getCurrentBranch(repoPath);
  const allowedBaseBranches = new Set(
    dedupeBranches([defaultBranch, ...DEFAULT_BRANCH_FALLBACKS]),
  );
  if (currentBranch && currentBranch !== branch && !allowedBaseBranches.has(currentBranch)) {
    throw new Error(
      `Direct workspace is currently on branch "${currentBranch}". Switch back to default branch or finish that session before starting a new one.`,
    );
  }

  const localBranch = `refs/heads/${branch}`;
  if (await refExists(repoPath, localBranch)) {
    await git(repoPath, "checkout", branch);
    return;
  }

  const remoteBranch = `origin/${branch}`;
  if (hasOrigin && (await refExists(repoPath, remoteBranch))) {
    await git(repoPath, "checkout", "-b", branch, remoteBranch);
    return;
  }

  await git(repoPath, "checkout", "-b", branch, baseRef);
}

export function create(): Workspace {
  return {
    name: "direct",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);
      await ensureRepoAvailable(repoPath);
      await ensureRepoHasCommits(repoPath);
      await ensureCleanWorkingTree(repoPath);

      const hasOrigin = await hasOriginRemote(repoPath);
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // Non-fatal when offline
        }
      }

      const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, {
        branch: cfg.branch,
        hasOrigin,
      });
      await checkoutOrCreateBranch(
        repoPath,
        cfg.branch,
        baseRef,
        hasOrigin,
        cfg.project.defaultBranch,
      );

      return {
        path: repoPath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(_workspacePath: string): Promise<void> {
      // Direct mode intentionally does not remove or reset the project directory.
    },

    async list(_projectId: string): Promise<WorkspaceInfo[]> {
      return [];
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await git(workspacePath, "rev-parse", "--is-inside-work-tree");
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);
      await ensureRepoAvailable(repoPath);
      await ensureRepoHasCommits(repoPath);
      await ensureCleanWorkingTree(repoPath);

      const hasOrigin = await hasOriginRemote(repoPath);
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // Non-fatal when offline
        }
      }

      const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, {
        branch: cfg.branch,
        hasOrigin,
      });
      await checkoutOrCreateBranch(
        repoPath,
        cfg.branch,
        baseRef,
        hasOrigin,
        cfg.project.defaultBranch,
      );

      return {
        path: repoPath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
