import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@moakbal/mao-core";

/** Timeout for git commands (30 seconds) */
const GIT_TIMEOUT = 30_000;

const DEFAULT_BRANCH_FALLBACKS = ["main", "master"];

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
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
      // Ignore and fall back to current branch
    }
  }

  const headBranch = await getCurrentBranch(repoPath);
  if (headBranch) {
    const remoteHead = `origin/${headBranch}`;
    if (hasOrigin && (await refExists(repoPath, remoteHead))) return remoteHead;
    const localHead = `refs/heads/${headBranch}`;
    if (await refExists(repoPath, localHead)) return localHead;
  }

  throw new Error(
    `Unable to resolve base ref for default branches: ${candidates.join(", ")}`,
  );
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
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

function normalizeRepoUrl(repo: string): string {
  const trimmed = repo.trim();
  const hasScheme = /^[a-z+]+:\/\//i.test(trimmed) || trimmed.startsWith("git@");
  if (hasScheme) return trimmed;
  const withGit = trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  return `https://github.com/${withGit}`;
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
      // Ignore and keep probing
    }
  }

  return undefined;
}

async function ensureRepoAvailable(repoPath: string, project: ProjectConfig): Promise<void> {
  if (existsSync(repoPath)) {
    if (!lstatSync(repoPath).isDirectory()) {
      throw new Error(`Project path "${repoPath}" exists but is not a directory`);
    }
    return;
  }

  if (!project.repo || typeof project.repo !== "string") {
    throw new Error(
      `Project path "${repoPath}" does not exist and no project.repo is configured to clone from`,
    );
  }

  const remoteUrl = normalizeRepoUrl(project.repo);
  const requested = project.defaultBranch || "main";
  const candidates = dedupeBranches([requested, ...DEFAULT_BRANCH_FALLBACKS]);
  const remoteDefault = await resolveRemoteDefaultBranch(remoteUrl, candidates);
  const branchCandidates = dedupeBranches([
    remoteDefault ?? "",
    ...candidates,
  ]);

  mkdirSync(dirname(repoPath), { recursive: true });

  let lastError: unknown;
  for (const branch of branchCandidates) {
    try {
      await execFileAsync(
        "git",
        ["clone", "--branch", branch, remoteUrl, repoPath],
        { timeout: GIT_TIMEOUT },
      );
      return;
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Remote branch") ||
        msg.includes("could not find remote branch") ||
        msg.includes("not found") && msg.includes("branch")
      ) {
        if (existsSync(repoPath)) {
          rmSync(repoPath, { recursive: true, force: true });
        }
        continue;
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
      throw new Error(`Failed to clone repo "${project.repo}": ${msg}`, { cause: err });
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(`Failed to clone repo "${project.repo}": ${msg}`);
}

async function resolveLocalDefaultBranch(
  repoPath: string,
  defaultBranch: string,
): Promise<string> {
  const candidates = dedupeBranches([defaultBranch, ...DEFAULT_BRANCH_FALLBACKS]);
  for (const candidate of candidates) {
    const ref = `refs/heads/${candidate}`;
    if (await refExists(repoPath, ref)) return ref;
  }
  throw new Error(
    `Unable to resolve local default branch from: ${candidates.join(", ")}`,
  );
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "worktree",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      await ensureRepoAvailable(repoPath, cfg.project);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });

      const hasOrigin = await hasOriginRemote(repoPath);

      // Fetch latest from remote when origin exists
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // Fetch may fail if offline — continue anyway
        }
      }

      const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, { hasOrigin });

      // Create worktree with a new branch
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        // Only retry if the error is "branch already exists"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${msg}`, {
            cause: err,
          });
        }
        // Branch already exists — create worktree and check it out
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        try {
          await git(worktreePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          // Checkout failed — remove the orphaned worktree before rethrowing
          try {
            await git(repoPath, "worktree", "remove", "--force", worktreePath);
          } catch {
            // Best-effort cleanup
          }
          const checkoutMsg =
            checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`, {
            cause: checkoutErr,
          });
        }
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        // git-common-dir returns something like /path/to/repo/.git
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);

        // NOTE: We intentionally do NOT delete the branch here. The worktree
        // removal is sufficient. Auto-deleting branches risks removing
        // pre-existing local branches unrelated to this workspace (any branch
        // containing "/" would have been deleted). Stale branches can be
        // cleaned up separately via `git branch --merged` or similar.
      } catch {
        // If git commands fail, try to clean up the directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      // Parse porcelain output — only include worktrees within our project directory
      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feat/INT-1234 → feat/INT-1234
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);
      await ensureRepoAvailable(repoPath, cfg.project);

      // Prune stale worktree entries
      try {
        await git(repoPath, "worktree", "prune");
      } catch {
        // Best effort
      }

      // Fetch latest
      const hasOrigin = await hasOriginRemote(repoPath);
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // May fail if offline
        }
      }

      // Try to create worktree on the existing branch
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, {
          branch: cfg.branch,
          hasOrigin,
        });

        if (!baseRef.startsWith("origin/")) {
          // No remote available — create from the local default branch
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
        } else {
          // Branch might not exist locally — try the remote ref first, then fall back
          // to the local default branch if the remote ref is unavailable.
          try {
            await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
          } catch {
            const fallbackRef = await resolveLocalDefaultBranch(
              repoPath,
              cfg.project.defaultBranch,
            );
            await git(
              repoPath,
              "worktree",
              "add",
              "-b",
              cfg.branch,
              workspacePath,
              fallbackRef,
            );
          }
        }
      }

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = expandPath(project.path);

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const stat = lstatSync(targetPath);
            if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], { cwd: info.path });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
