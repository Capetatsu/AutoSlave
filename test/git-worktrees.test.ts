/** Worktree manager tests against real disposable git repos. No OpenCode. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  branchExists,
  commitWork,
  createWorktree,
  currentBranch,
  headSha,
  cleanupOrphans,
  integrate,
  isAncestor,
  isClean,
  listWorktrees,
  porcelain,
  removeWorktree,
  repoRoot,
} from '../src/git/worktrees.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-git-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

describe('worktree basics', () => {
  it('repoRoot/currentBranch/branchExists/isClean', () => {
    assert.equal(repoRoot(repo), repo);
    assert.equal(currentBranch(repo), 'main');
    assert.equal(branchExists(repo, 'main'), true);
    assert.equal(branchExists(repo, 'nope'), false);
    assert.equal(branchExists(path.join(repo, 'missing'), 'main'), false);
    assert.equal(isClean(repo), true);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    assert.equal(isClean(repo), false);
    assert.ok(porcelain(repo).includes('dirty.txt'));
  });

  it('separate writing worktrees do not interfere', () => {
    const a = createWorktree(repo, 'autoslave/a', 'a');
    const b = createWorktree(repo, 'autoslave/b', 'b');
    assert.notEqual(a.path, b.path);
    assert.equal(a.baseSha, headSha(repo));
    fs.writeFileSync(path.join(a.path, 'only-a.txt'), 'A');
    fs.writeFileSync(path.join(b.path, 'only-b.txt'), 'B');
    assert.equal(fs.existsSync(path.join(b.path, 'only-a.txt')), false);
    assert.equal(fs.existsSync(path.join(a.path, 'only-b.txt')), false);
    assert.equal(fs.existsSync(path.join(repo, 'only-a.txt')), false);
    assert.ok(listWorktrees(repo).replace(/\//g, path.sep).includes(a.path));
    removeWorktree(repo, a.path, true);
    removeWorktree(repo, b.path, true);
  });

  it('duplicate branch is rejected', () => {
    createWorktree(repo, 'autoslave/dup', 'd');
    assert.throws(() => createWorktree(repo, 'autoslave/dup', 'd2'), /already exists/);
  });
});

describe('removal safety', () => {
  it('refuses dirty worktrees without force, and unmanaged paths always', () => {
    const wt = createWorktree(repo, 'autoslave/dirty', 'd');
    fs.writeFileSync(path.join(wt.path, 'work.txt'), 'wip');
    assert.throws(() => removeWorktree(repo, wt.path), /dirty/);
    assert.throws(() => removeWorktree(repo, repo), /unmanaged/);
    assert.throws(() => removeWorktree(repo, os.tmpdir()), /unmanaged/);
    removeWorktree(repo, wt.path, true);
    assert.equal(fs.existsSync(wt.path), false);
  });

  it('cleanupOrphans only removes stale non-worktree dirs', () => {
    const wt = createWorktree(repo, 'autoslave/live', 'l');
    const stale = path.join(((): string => {
      // reach into the manager's temp base via the live path's parent
      return path.dirname(wt.path);
    })(), 'stale-junk');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'junk.txt'), 'x');
    const removed = cleanupOrphans();
    assert.ok(removed.includes(stale), `stale dir removed: ${removed}`);
    assert.equal(fs.existsSync(wt.path), true, 'live worktree kept');
    removeWorktree(repo, wt.path, true);
  });
});

describe('controlled integration', () => {
  it('merges approved work and is idempotent', () => {
    const wt = createWorktree(repo, 'autoslave/feat', 'f');
    fs.writeFileSync(path.join(wt.path, 'feat.txt'), 'hello\n');
    const sha = commitWork(wt.path, 'autoslave: feat');
    assert.match(sha, /^[0-9a-f]{40}$/);
    const first = integrate(repo, 'autoslave/feat', 'main');
    assert.equal(first.ok, true);
    assert.match(first.sha ?? '', /^[0-9a-f]{40}$/);
    assert.ok(isAncestor(repo, 'autoslave/feat', 'main'));
    const mainFeat = execFileSync('git', ['show', 'main:feat.txt'], { cwd: repo, encoding: 'utf8' }).replace(/\r\n/g, '\n');
    assert.equal(mainFeat, 'hello\n');
    const second = integrate(repo, 'autoslave/feat', 'main');
    assert.equal(second.ok, true);
    assert.equal(second.already, true);
    assert.equal(second.sha, first.sha);
    removeWorktree(repo, wt.path, true);
  });

  it('conflicts abort with everything preserved', () => {
    const wt = createWorktree(repo, 'autoslave/clash', 'c');
    fs.writeFileSync(path.join(wt.path, 'base.txt'), 'theirs\n');
    commitWork(wt.path, 'autoslave: clash');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'ours\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'ours']);
    const res = integrate(repo, 'autoslave/clash', 'main');
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.deepEqual(res.conflictFiles, ['base.txt']);
    // Nothing overwritten, nothing lost.
    const oursWorktree = fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(oursWorktree, 'ours\n');
    const theirsWorktree = fs.readFileSync(path.join(wt.path, 'base.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(theirsWorktree, 'theirs\n');
    assert.equal(branchExists(repo, 'autoslave/clash'), true);
    removeWorktree(repo, wt.path, true);
  });

  it('missing branches fail closed', () => {
    const res = integrate(repo, 'autoslave/ghost', 'main');
    assert.equal(res.ok, false);
    assert.match(res.detail ?? '', /missing branch/);
  });

  it('refuses when checked out elsewhere or dirty', () => {
    const wt = createWorktree(repo, 'autoslave/other', 'o');
    fs.writeFileSync(path.join(wt.path, 'x.txt'), 'x\n');
    commitWork(wt.path, 'work');
    // Free the branch from its worktree, then check it out in main:
    // integrating "into main" while main is not checked out must refuse.
    removeWorktree(repo, wt.path, true);
    git(repo, ['checkout', '-q', 'autoslave/other']);
    const wrongBranch = integrate(repo, 'autoslave/other', 'main');
    assert.equal(wrongBranch.ok, false);
    assert.match(wrongBranch.detail ?? '', /not main/);
    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'local.txt'), 'uncommitted\n');
    const dirty = integrate(repo, 'autoslave/other', 'main');
    assert.equal(dirty.ok, false);
    assert.match(dirty.detail ?? '', /uncommitted/);
    fs.rmSync(path.join(repo, 'local.txt'));
  });

  it('commit with no changes is a no-op returning HEAD', () => {
    const wt = createWorktree(repo, 'autoslave/empty', 'e');
    assert.equal(commitWork(wt.path, 'nothing'), headSha(wt.path));
    removeWorktree(repo, wt.path, true);
  });
});
