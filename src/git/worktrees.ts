/**
 * Phase 4 worktree isolation: writing agents get separate Git worktrees and
 * branches. Merges happen in throwaway integration worktrees — never in the
 * user's checkout. Nothing is ever deleted silently or overwritten blindly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export class GitError extends Error {
  constructor(
    public command: string,
    public cwd: string,
    public detail: string,
  ) {
    super(`git ${command} failed in ${cwd}: ${detail.slice(0, 300)}`);
    this.name = 'GitError';
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: unknown; message?: string };
    const detail = typeof err.stderr === 'string' && err.stderr ? err.stderr : (err.message ?? 'unknown error');
    throw new GitError(args.join(' '), cwd, detail);
  }
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  baseSha: string;
}

/** Resolve the repo root for any path inside a working tree. Throws if none. */
export function repoRoot(anywhereInside: string): string {
  return git(anywhereInside, ['rev-parse', '--show-toplevel']).trim().replace(/\//g, path.sep);
}

export function currentBranch(cwd: string): string {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export function branchExists(repoRootDir: string, branch: string): boolean {
  try {
    git(repoRootDir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    // Missing repo, missing branch, or git failure: all mean "not usable".
    // Callers treat false as reconcile-failed → escalate (safe direction).
    return false;
  }
}

export function headSha(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** True when no staged, unstaged, or untracked changes exist. */
export function isClean(worktreePath: string): boolean {
  return git(worktreePath, ['status', '--porcelain=v1']).trim() === '';
}

export function porcelain(worktreePath: string): string {
  return git(worktreePath, ['status', '--porcelain=v1']).trim();
}

function worktreeBaseDir(): string {
  return path.join(os.tmpdir(), 'autoslave-wt');
}

/**
 * Create an isolated worktree on a new branch from the repo's HEAD.
 * The path is always under the OS temp dir — never inside the user's checkout,
 * and never an existing worktree. Throws when the repo root is dirty? No:
 * the new branch starts at HEAD regardless; uncommitted work in the caller's
 * tree is left untouched (never moved, never committed here).
 */
export function createWorktree(repoRootDir: string, branch: string, label: string): WorktreeInfo {
  if (branchExists(repoRootDir, branch)) {
    throw new GitError('worktree create', repoRootDir, `branch already exists: ${branch}`);
  }
  const safe = label.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'wt';
  const wtPath = path.join(worktreeBaseDir(), `${safe}-${randomBytes(3).toString('hex')}`);
  const baseSha = headSha(repoRootDir);
  git(repoRootDir, ['worktree', 'add', '-b', branch, wtPath]);
  return { branch, path: wtPath, baseSha };
}

function isManagedWorktree(wtPath: string): boolean {
  const norm = path.resolve(wtPath);
  return norm.startsWith(worktreeBaseDir() + path.sep);
}

/**
 * Remove a worktree created by createWorktree. Refuses: unknown paths (never
 * deletes unrelated worktrees), dirty worktrees without force, the main
 * worktree of any repo. With force, uncommitted work is still listed in the
 * error detail — callers must confirm they mean it.
 */
export function removeWorktree(repoRootDir: string, wtPath: string, force = false): void {
  if (!isManagedWorktree(wtPath)) {
    throw new GitError('worktree remove', repoRootDir, `refusing to remove unmanaged path: ${wtPath}`);
  }
  let dirty = '';
  try {
    dirty = porcelain(wtPath);
  } catch {
    /* path may already be gone; fall through to prune */
  }
  if (dirty && !force) {
    throw new GitError('worktree remove', repoRootDir, `refusing to remove dirty worktree (use force explicitly):\n${dirty.slice(0, 500)}`);
  }
  git(repoRootDir, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
  try {
    git(repoRootDir, ['worktree', 'prune']);
  } catch {
    /* prune is best-effort */
  }
}

/** Commit all worktree content on its branch. Returns the new sha. */
export function commitWork(wtPath: string, message: string): string {
  git(wtPath, ['add', '-A']);
  try {
    git(wtPath, ['-c', 'user.name=autoslave', '-c', 'user.email=autoslave@localhost', 'commit', '-q', '-m', message]);
  } catch (e) {
    // Nothing to commit is an idempotent no-op (verified via status, since
    // -q suppresses git's own message). Anything actually dirty rethrows.
    if (porcelain(wtPath) !== '') throw e;
  }
  return headSha(wtPath);
}

export function isAncestor(repoRootDir: string, maybeAncestor: string, ref: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', maybeAncestor, ref], { cwd: repoRootDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface IntegrateResult {
  ok: boolean;
  /** True when the target already contained the source (no new merge). */
  already?: boolean;
  sha?: string;
  conflict?: boolean;
  conflictFiles?: string[];
  detail?: string;
}

/**
 * Controlled merge of sourceBranch into targetBranch, performed in the repo's
 * main checkout (repoRootDir). Rationale: merging into a detached worktree
 * cannot advance the target ref, and force-moving a checked-out ref would
 * silently desynchronize the user's files — both unacceptable. Instead:
 * refuse unless the checkout is ON targetBranch and CLEAN, merge, and abort
 * untouched on conflict. The author's worktree is never touched.
 */
export function integrate(repoRootDir: string, sourceBranch: string, targetBranch: string): IntegrateResult {
  for (const b of [sourceBranch, targetBranch]) {
    if (!branchExists(repoRootDir, b)) {
      return { ok: false, detail: `missing branch: ${b}` };
    }
  }
  if (isAncestor(repoRootDir, sourceBranch, targetBranch)) {
    const targetSha = git(repoRootDir, ['rev-parse', targetBranch]).trim();
    return { ok: true, already: true, sha: targetSha, detail: 'target already contains source' };
  }
  let current: string;
  try {
    current = currentBranch(repoRootDir);
  } catch (e) {
    return { ok: false, detail: `cannot determine checkout branch: ${(e as Error).message}` };
  }
  if (current !== targetBranch) {
    return { ok: false, detail: `checkout is on ${current}, not ${targetBranch}; refusing to merge elsewhere` };
  }
  if (porcelain(repoRootDir) !== '') {
    return { ok: false, detail: 'checkout has uncommitted changes; refusing to merge over them' };
  }
  try {
    git(repoRootDir, ['merge', '--no-ff', '--no-commit', sourceBranch]);
  } catch (e) {
    const files = git(repoRootDir, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean);
    try {
      git(repoRootDir, ['merge', '--abort']);
    } catch {
      /* best effort */
    }
    return { ok: false, conflict: true, conflictFiles: files, detail: `merge conflict, aborted and preserved: ${(e as GitError).detail.slice(0, 200)}` };
  }
  git(repoRootDir, ['commit', '-q', '--no-edit']);
  return { ok: true, sha: headSha(repoRootDir) };
}

/** List worktrees (porcelain) for diagnostics. Raw passthrough, bounded. */
export function listWorktrees(repoRootDir: string): string {
  return git(repoRootDir, ['worktree', 'list', '--porcelain']).slice(0, 4000);
}

export function cleanupOrphans(): string[] {
  // Only removes OUR temp dir entries that git no longer tracks. Never touches
  // live worktrees: removal goes through removeWorktree guards per path.
  const removed: string[] = [];
  let base = '';
  try {
    base = worktreeBaseDir();
    for (const entry of fs.readdirSync(base)) {
      const full = path.join(base, entry);
      try {
        if (fs.statSync(full).isDirectory() && !fs.existsSync(path.join(full, '.git'))) {
          // Not a live worktree admin dir (already removed by git): leftover shell.
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        }
      } catch {
        /* per-entry best effort */
      }
    }
  } catch {
    /* base dir may not exist */
  }
  return removed;
}
