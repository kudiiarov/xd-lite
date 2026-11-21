#!/usr/bin/env node
// XD Lite — single-file, zero-dependency review viewer.
//
//   xd-lite [path] [--wait] [--out FILE] [--vs REF] [--source working|staged|head]
//           [--port N] [--no-open] [--author NAME]
//
//   xd-lite .                 → open a review window for the working tree diff
//   xd-lite . --vs origin/main → show commits that are about to be pushed
//   xd-lite . --wait           → agent mode: block until "Send review" is clicked,
//                                write the review file, print REVIEW_FILE=<path>, exit 0.
//
// UI: resizable sidebar (file tree + sorted comment list) and a single-file diff
// with Unified/Split views and expandable context between hunks. Two remark kinds:
// **Task** (stored as `request-changes`; checkbox is a plain on/off toggle, the
// agent may tick it when done) and **Comment** (stored as `comment`).
// Comments anchored on removed lines keep `anchor.side: old` in the frontmatter
// (ignored by the full XD store — zod strips unknown keys).
//
// Threads are written to `<repo>/.xd/threads/<ulid>.md` in the exact format the
// full XD server/MCP reads — reviews collected here work in both worlds.
//
// Requires only Node >= 20 and the git binary. No npm install, no build step.
// This file is self-contained: copy it anywhere and run it.

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir, stat, unlink, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Own package version (single source of truth: package.json). */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0'; // file copied without package.json — degrade gracefully
  }
})();

// ============================================================================
// CLI
// ============================================================================

const USAGE = `XD Lite — lightweight single-file review viewer

Usage:
  xd-lite [path] [options]
  xd-lite mcp [path]    MCP stdio server for coding agents
                        (tools: get_diff, list_threads, get_thread,
                         add_comment, reply_thread, resolve_thread)

Options:
  --wait              block until "Send review to agent" is clicked, then
                      write the review file and print REVIEW_FILE=<path>
  --fail-on-open      with --wait: exit with code 2 (and REVIEW_FILE on stderr)
                      when open review threads remain — lets a PreToolUse hook
                      block "git push" until the human's tasks are handled
  --timeout MINUTES   with --wait: stop waiting after N minutes and collect
                      whatever threads exist (no browser click needed)
  --out FILE          where to write the review (default <repo>/.xd/review-<ts>.md)
  --vs REF            diff the worktree against REF (e.g. --vs origin/main —
                      "what is about to be pushed")
  --source KIND       working (default) | staged | head
  --port N            fixed port (default: OS-assigned, never clashes)
  --no-open           do not open the browser (headless harnesses)
  --author NAME       author recorded on comments (default: human:me)
  --help              show this help

Exit codes (--wait): 0 — review collected; 2 — --fail-on-open and open threads remain.

Install: npm install -g <this folder>  →  "xd-lite" on PATH (Windows shims included).
Or just copy this single file anywhere: node xd-lite.js <repo> --wait
`;

function parseArgs(argv) {
  const FLAG_VALUE = new Set(['--out', '--vs', '--source', '--port', '--author', '--timeout']);
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAG_VALUE.has(a)) {
      const val = argv[i + 1];
      if (val === undefined) throw new Error(`missing value for ${a}`);
      flags.set(a, val);
      i++;
    } else if (a.startsWith('--')) {
      flags.set(a, true);
    } else if (!a.startsWith('-')) {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function resolveSource(flags) {
  if (flags.has('--vs')) return { kind: 'vs', base: flags.get('--vs') };
  const s = flags.get('--source');
  if (!s || s === 'working') return { kind: 'working' };
  if (s === 'staged' || s === 'head') return { kind: s };
  throw new Error(`unknown --source: ${s} (working | staged | head)`);
}

function sourceKey(source) {
  if (source.kind === 'vs') return `vs:${source.base}`;
  if (source.kind === 'all') return `all:${source.base}`;
  if (source.kind === 'commit') return `commit:${source.sha}`;
  return source.kind;
}

/** Inverse of sourceKey: "commit:<sha>" / "vs:<base>" / "all:<base>" /
 *  working|staged|head → source. */
function parseSourceKey(key) {
  if (key === 'working' || key === 'staged' || key === 'head') return { kind: key };
  const m = String(key || '').match(/^(vs|all|commit):(.+)$/);
  if (!m || !m[2] || m[2].includes('..') || /[\s;&|`$]/.test(m[2])) return null;
  if (m[1] === 'commit' && !/^[0-9a-f]{7,40}$/i.test(m[2])) return null; // commit names are hex shas
  return m[1] === 'vs' ? { kind: 'vs', base: m[2] }
    : m[1] === 'all' ? { kind: 'all', base: m[2] }
    : { kind: 'commit', sha: m[2] };
}

function diffSourceLabel(source) {
  switch (source.kind) {
    case 'working': return 'Uncommitted';
    case 'staged': return 'Staged';
    case 'head': return 'Last commit';
    case 'vs': return `PR vs ${source.base}`;
    case 'all': return `All changes vs ${source.base}`;
    case 'commit': return `Commit ${String(source.sha).slice(0, 7)}`;
  }
}

/** Base ref for whole-branch/commit-list browsing: an explicit --vs base wins,
 *  else the first of upstream / origin-main / main-ish refs that exists and is
 *  not HEAD itself. Null when nothing suitable exists (e.g. single-branch repo). */
async function detectBase(worktreePath, source) {
  if (source.kind === 'vs') return source.base;
  const head = await runGit(worktreePath, ['rev-parse', 'HEAD']).catch(() => null);
  if (!head) return null;
  for (const c of ['@{upstream}', 'origin/main', 'origin/master', 'main', 'master']) {
    const sha = await runGit(worktreePath, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]).catch(() => null);
    if (sha && sha !== head) return c;
  }
  return null;
}

/** Commits on the branch (base..HEAD), newest first — the "iterations" list. */
async function listCommits(worktreePath, base) {
  if (!base) return [];
  return parseCommitLog(await runGit(worktreePath, [
    'log', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at', `${base}..HEAD`,
  ]).catch(() => ''));
}

/** Recent history when no base exists (single-branch repo): last n commits. */
async function listRecentCommits(worktreePath, n) {
  return parseCommitLog(await runGit(worktreePath, [
    'log', `-n${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at', 'HEAD',
  ]).catch(() => ''));
}

function parseCommitLog(out) {
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, short, subject, author, at] = line.split('\x1f');
    return { sha, short, subject, author, at: Number(at) * 1000 };
  });
}

/** True when something is staged (an empty Staged mode is just noise). */
async function hasStaged(worktreePath) {
  const out = await runGit(worktreePath, ['diff', '--cached', '--name-only']).catch(() => '');
  return Boolean(out);
}

// ============================================================================
// Git (ported from @xd/core packages/core/src/git — same behavior, no deps)
// ============================================================================

class GitError extends Error {
  constructor(args, exitCode, stderr) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        // avoid pager/color interference regardless of user config
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trimEnd());
      else reject(new GitError(args, code ?? -1, stderr));
    });
  });
}

const DIFF_FLAGS = ['--no-color', '-M', '--unified=3'];

function baseArgs(source) {
  switch (source.kind) {
    case 'working': return ['diff', 'HEAD'];
    case 'staged': return ['diff', '--cached', 'HEAD'];
    case 'head': return ['show', '--format=', '--root', 'HEAD'];
    // PR semantics: merge-base(base, HEAD)..HEAD — committed work only.
    // Uncommitted changes are the "Uncommitted" mode, they never reach a PR.
    case 'vs': return ['diff', `${source.base}...HEAD`];
    // everything the branch touches: commits + uncommitted + untracked,
    // base vs working tree
    case 'all': return ['diff', source.base];
    case 'commit': return ['show', '--format=', '--root', source.sha];
  }
}

/** Unified diff text for the given source. Empty string when there are no changes. */
async function getDiffText(worktreePath, source) {
  let text = '';
  try {
    text = await runGit(worktreePath, [...baseArgs(source), ...DIFF_FLAGS]);
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 128 && source.kind === 'head') {
      return ''; // empty repo: no HEAD yet
    }
    throw err;
  }
  // Working-tree diffs miss untracked files; append synthesized "new file" diffs.
  // The 'all' mode (base vs working tree) counts untracked files as edits too.
  if (source.kind === 'working' || source.kind === 'all') {
    const untracked = await listUntracked(worktreePath);
    for (const file of untracked) {
      text += `\n${await synthNewFileDiff(worktreePath, file)}`;
    }
  }
  return text.trimStart();
}

async function listUntracked(worktreePath) {
  const out = await runGit(worktreePath, ['ls-files', '--others', '--exclude-standard']);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

async function synthNewFileDiff(worktreePath, file) {
  const abs = path.join(worktreePath, file);
  let content;
  try {
    content = await readFile(abs);
  } catch {
    return '';
  }
  if (content.includes(0)) {
    return `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files ${file} differ`;
  }
  const realSha = await runGit(worktreePath, ['hash-object', '--', file]).catch(() => '1111111');
  const lines = content.toString('utf8').split('\n');
  const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((l) => `+${l}`).join('\n');
  const header = [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    `index 0000000..${realSha}`,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join('\n');
  const newlineNote = hasTrailingNewline ? '' : '\n\\ No newline at end of file';
  return `${header}\n${body}${newlineNote}`;
}

/** Git blob sha of a file's current content — used for thread outdated detection. */
async function fileBlobSha(worktreePath, file) {
  try {
    return await runGit(worktreePath, ['hash-object', '--', file]);
  } catch {
    return 'unknown';
  }
}

/** Worktree file content (or null for binary/missing) for context expansion. */
async function worktreeBlob(worktreePath, file) {
  let content;
  try {
    content = await readFile(path.join(worktreePath, file));
  } catch {
    return null;
  }
  if (content.includes(0)) return { binary: true };
  return { text: content.toString('utf8') };
}

/** Old-side blob (`<ref>:<path>`) for context expansion; null when unavailable. */
async function gitBlob(worktreePath, ref, file) {
  try {
    const text = await runGit(worktreePath, ['show', `${ref}:${file}`]);
    if (text.includes('\u0000')) return { binary: true };
    return { text };
  } catch {
    return null;
  }
}

// ============================================================================
// Thread store (markdown files at <repo>/.xd/threads/<ulid>.md — same format
// as @xd/core's ThreadStore, see packages/core/src/threads/store.ts)
// ============================================================================

const CATEGORIES = ['request-changes', 'question', 'comment'];
const XD_DIR = '.xd';
const THREADS_DIR = 'threads';

// ULID-shaped id (Crockford base32, 26 chars) — satisfies the store's id regex.
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function genId() {
  let time = Date.now();
  let ts = '';
  for (let i = 0; i < 10; i++) {
    ts = ULID_CHARS[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ULID_CHARS[Math.floor(Math.random() * 32)];
  return ts + rand;
}

// Single-quote anything YAML would misparse (matches js-yaml's output style for
// values like 'human:me'; plain scalars stay plain so files look familiar).
function yamlScalar(value) {
  const s = String(value);
  if (s === '' || /[:#]/.test(s) || /^[\s&*!|>'"%@`,{}[\]]/.test(s) || /\s$/.test(s)) {
    return `'${s.replaceAll("'", "''")}'`;
  }
  return s;
}

function serializeThread(thread) {
  const L = [
    '---',
    `id: ${thread.id}`,
    `file: ${yamlScalar(thread.file)}`,
    `status: ${thread.status}`,
    `category: ${thread.category}`,
    `author: ${yamlScalar(thread.author)}`,
    `created_at: ${yamlScalar(thread.createdAt)}`,
    'anchor:',
    `  ref: ${yamlScalar(thread.anchor.ref)}`,
    `  blob_sha: ${thread.anchor.blobSha}`,
    '  lines:',
    `    - ${thread.anchor.lines[0]}`,
    `    - ${thread.anchor.lines[1]}`,
  ];
  // Lite extension: a comment left on a removed line anchors to the old side.
  // The full XD store drops this unknown key silently (zod non-strict).
  if (thread.anchor.side === 'old') L.push('  side: old');
  if (thread.resolvedBy) L.push(`resolved_by: ${yamlScalar(thread.resolvedBy)}`);
  if (thread.resolvedAt) L.push(`resolved_at: ${yamlScalar(thread.resolvedAt)}`);
  L.push('---');
  let out = `${L.join('\n')}\n\n${thread.body.trimStart()}\n`;
  // replies are appended as `--- / author: / at: / ---` blocks (same as the core store)
  for (const reply of thread.replies) {
    out += `\n---\nauthor: ${reply.author}\nat: ${reply.at}\n---\n\n${reply.body.trim()}\n`;
  }
  return out;
}

function unquote(value) {
  const s = String(value);
  const m = s.match(/^'(.*)'$/) || s.match(/^"(.*)"$/);
  return m ? m[1].replaceAll("''", "'") : s;
}

function normalizeCategory(c) {
  if (c === 'issue') return 'request-changes';
  if (c === 'nitpick' || c === 'suggestion' || c === 'praise') return 'comment';
  return c;
}

/** Minimal frontmatter parser for the exact field set this format uses. */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const data = { anchor: {} };
  let inAnchor = false;
  let inLines = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (line === 'anchor:') { inAnchor = true; inLines = false; continue; }
    if (inAnchor && /^\s+lines:\s*$/.test(line)) { inLines = true; continue; }
    if (inLines && /^\s+-\s+\d+\s*$/.test(line)) {
      (data.anchor.lines ??= []).push(Number(line.match(/-\s+(\d+)/)[1]));
      continue;
    }
    const kv = line.match(/^\s*(\w+):\s*(.*)$/);
    if (!kv) continue;
    if (inAnchor && /^[ ]{2}\w/.test(line)) {
      data.anchor[kv[1]] = unquote(kv[2]);
      continue;
    }
    inAnchor = false;
    inLines = false;
    data[kv[1]] = unquote(kv[2]);
  }
  if (!Array.isArray(data.anchor.lines)) data.anchor.lines = [];
  return data;
}

function parseThread(raw, fileName) {
  const fm = parseFrontmatter(raw);
  if (!fm) throw new Error(`no frontmatter in ${fileName}`);
  const anchor = fm.anchor ?? {};

  // Split body into first message + replies. A reply starts with a `---` line
  // followed by `author:`; a bare `---` inside the body is a markdown hr.
  const lines = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split('\n');
  const messages = [{ body: [] }];
  let mode = 'body';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^---\s*$/.test(line)) {
      if (mode === 'body') {
        if ((lines[i + 1] ?? '').startsWith('author:')) {
          mode = 'meta';
          messages.push({ body: [] });
          continue;
        }
      } else {
        mode = 'body';
        continue;
      }
    }
    const last = messages[messages.length - 1];
    if (mode === 'meta') {
      const m2 = line.match(/^(author|at):\s*(.*)$/);
      if (m2) {
        if (m2[1] === 'author') last.author = m2[2].trim();
        else last.at = m2[2].trim();
        continue;
      }
      mode = 'body';
    }
    last.body.push(line);
  }
  const [first, ...rest] = messages.map((msg) => ({
    author: msg.author,
    at: msg.at,
    body: msg.body.join('\n').trim(),
  }));
  const replies = rest
    .filter((r) => r.body.length > 0 || r.author)
    .map((r) => ({ author: r.author ?? 'unknown', at: r.at ?? '', body: r.body }));

  return {
    id: String(fm.id ?? fileName.replace(/\.md$/, '')),
    file: String(fm.file ?? ''),
    status: String(fm.status ?? 'open'),
    category: normalizeCategory(String(fm.category ?? 'comment')),
    author: String(fm.author ?? 'unknown'),
    createdAt: String(fm.created_at ?? ''),
    anchor: {
      ref: String(anchor.ref ?? 'working'),
      blobSha: String(anchor.blob_sha ?? ''),
      lines: [Number(anchor.lines[0]) || 1, Number(anchor.lines[1]) || 1],
      side: anchor.side === 'old' ? 'old' : 'new',
    },
    resolvedBy: fm.resolved_by != null ? String(fm.resolved_by) : undefined,
    resolvedAt: fm.resolved_at != null ? String(fm.resolved_at) : undefined,
    body: first?.body ?? '',
    replies,
  };
}

function threadsDir(worktreePath) {
  return path.join(worktreePath, XD_DIR, THREADS_DIR);
}

function threadPath(worktreePath, id) {
  if (!/^[A-Z0-9]{10,26}$/i.test(id)) throw new Error(`Invalid thread id: ${id}`);
  return path.join(threadsDir(worktreePath), `${id}.md`);
}

function validateCreateInput(input) {
  if (!input || typeof input !== 'object') return 'JSON body required';
  if (typeof input.file !== 'string' || !input.file || input.file.includes('..') || path.isAbsolute(input.file)) {
    return 'invalid file';
  }
  if (!Array.isArray(input.lines) || input.lines.length !== 2 || !input.lines.every((n) => Number.isInteger(n) && n >= 1)) {
    return 'invalid lines (expected [start, end])';
  }
  if (!CATEGORIES.includes(input.category)) return `invalid category (one of ${CATEGORIES.join(', ')})`;
  if (input.side !== undefined && input.side !== 'old' && input.side !== 'new') return 'invalid side';
  if (typeof input.body !== 'string' || !input.body.trim()) return 'empty body';
  if (input.body.length > 100_000) return 'body too long';
  return null;
}

function createLiteStore(worktreePath) {
  return {
    /** Ensure `.xd/` is git-excluded (local-only, does not touch tracked files). */
    async ensureExcluded() {
      const gitDir = path.join(worktreePath, '.git');
      let resolvedGitDir = gitDir;
      try {
        const st = await stat(gitDir);
        if (st.isFile()) {
          // linked worktrees: .git is a file pointing at the real gitdir
          const content = await readFile(gitDir, 'utf8');
          const m = content.match(/gitdir:\s*(.+)/);
          if (m) resolvedGitDir = path.resolve(worktreePath, m[1].trim());
        }
      } catch {
        return;
      }
      const excludePath = path.join(resolvedGitDir, 'info', 'exclude');
      await mkdir(path.dirname(excludePath), { recursive: true });
      let content = '';
      try {
        content = await readFile(excludePath, 'utf8');
      } catch {
        // new file
      }
      const entry = `${XD_DIR}/`;
      if (!content.split('\n').some((line) => line.trim() === entry)) {
        const sep = content.endsWith('\n') || content === '' ? '' : '\n';
        const comment = content.includes('# Added by XD') ? '' : `${sep}# Added by XD — local review threads\n`;
        await writeFile(excludePath, `${content}${sep}${comment}${entry}\n`, 'utf8');
      }
    },

    async list() {
      let files;
      try {
        files = await readdir(threadsDir(worktreePath));
      } catch {
        return [];
      }
      const threads = [];
      for (const f of files.filter((f) => f.endsWith('.md'))) {
        try {
          const raw = await readFile(path.join(threadsDir(worktreePath), f), 'utf8');
          const thread = parseThread(raw, f);
          const currentSha = await fileBlobSha(worktreePath, thread.file);
          thread.outdated = currentSha !== thread.anchor.blobSha;
          threads.push(thread);
        } catch (err) {
          console.error(`[xd-lite] failed to parse thread ${f}:`, err.message);
        }
      }
      threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return threads;
    },

    async create(input) {
      const error = validateCreateInput(input);
      if (error) {
        const err = new Error(error);
        err.statusCode = 400;
        throw err;
      }
      const now = new Date().toISOString();
      const blobSha = await fileBlobSha(worktreePath, input.file);
      const thread = {
        id: genId(),
        file: input.file,
        status: 'open',
        category: input.category,
        author: (typeof input.author === 'string' && input.author.trim()) || 'human:me',
        createdAt: now,
        anchor: {
          ref: 'working',
          blobSha,
          lines: input.lines,
          side: input.side === 'old' ? 'old' : 'new',
        },
        body: input.body.trimStart(),
        replies: [],
      };
      await mkdir(threadsDir(worktreePath), { recursive: true });
      await writeFile(threadPath(worktreePath, thread.id), serializeThread(thread), 'utf8');
      return { ...thread, outdated: false };
    },

    /** Toggle the task checkbox: rewrite frontmatter with the new status. */
    async setStatus(id, status, actor) {
      if (status !== 'open' && status !== 'resolved') {
        throw Object.assign(new Error('invalid status (open | resolved)'), { statusCode: 400 });
      }
      const filePath = threadPath(worktreePath, id);
      const raw = await readFile(filePath, 'utf8');
      const thread = parseThread(raw, path.basename(id));
      thread.status = status;
      if (status === 'resolved') {
        thread.resolvedBy = (typeof actor === 'string' && actor.trim()) || thread.author;
        thread.resolvedAt = new Date().toISOString();
      } else {
        thread.resolvedBy = undefined;
        thread.resolvedAt = undefined;
      }
      await writeFile(filePath, serializeThread(thread), 'utf8');
      const currentSha = await fileBlobSha(worktreePath, thread.file);
      return { ...thread, outdated: currentSha !== thread.anchor.blobSha };
    },

    /** Replace the thread body (edit); replies and frontmatter stay intact. */
    async updateBody(id, body) {
      if (typeof body !== 'string' || !body.trim()) {
        throw Object.assign(new Error('empty body'), { statusCode: 400 });
      }
      const filePath = threadPath(worktreePath, id);
      const raw = await readFile(filePath, 'utf8');
      const thread = parseThread(raw, path.basename(id));
      thread.body = body.trim();
      await writeFile(filePath, serializeThread(thread), 'utf8');
      const currentSha = await fileBlobSha(worktreePath, thread.file);
      return { ...thread, outdated: currentSha !== thread.anchor.blobSha };
    },

    /** Append an agent/human reply block (same shape as the core store). */
    async reply(id, input) {
      if (typeof input?.body !== 'string' || !input.body.trim()) {
        throw Object.assign(new Error('empty body'), { statusCode: 400 });
      }
      const filePath = threadPath(worktreePath, id);
      const author = (typeof input.author === 'string' && input.author.trim()) || 'agent:mcp';
      const block = `\n---\nauthor: ${author}\nat: ${new Date().toISOString()}\n---\n\n${input.body.trim()}\n`;
      await appendFile(filePath, block, 'utf8');
      const raw = await readFile(filePath, 'utf8');
      const thread = parseThread(raw, path.basename(id));
      const currentSha = await fileBlobSha(worktreePath, thread.file);
      return { ...thread, outdated: currentSha !== thread.anchor.blobSha };
    },

    async remove(id) {
      await unlink(threadPath(worktreePath, id));
    },
  };
}

// ============================================================================
// Handoff — same REVIEW_FILE contract as the full xd CLI
// ============================================================================

function renderHandoff(repoPath, threads, { agentMayResolve = true } = {}) {
  const lines = [
    '# Code review feedback',
    '',
    `${threads.length} open review thread(s) in ${repoPath}.`,
    '',
    'How to act:',
    '- **request-changes (Task)** — fix the code, then resolve the thread if you actually fixed it.',
    '- **question** — answer in a reply (and fix code if the answer reveals a problem), then resolve.',
    '- **comment** — informational; reply briefly if useful and resolve.',
    '',
  ];
  if (!agentMayResolve) {
    lines.push(
      '> ❗ **The human resolves threads themselves.** Do NOT set threads to `resolved` —',
      '> no frontmatter edits, no resolve_thread calls. Fix the code, reply what you did,',
      '> and leave every thread open: the human will verify and resolve in the viewer.',
      '',
    );
  }
  lines.push(
    'Task checkboxes are a plain toggle: tick a task only when you are actually done with it.',
    'Resolve by setting `status: resolved` in the thread file frontmatter (or via xd mcp tools).',
    '',
  );
  for (const t of threads) {
    lines.push('---', '');
    lines.push(`## [${t.category}] ${t.file}:${t.anchor.lines[0]}${t.anchor.side === 'old' ? ' (removed line)' : ''}`);
    lines.push(`thread file: ${path.join(repoPath, XD_DIR, THREADS_DIR, `${t.id}.md`)}`);
    lines.push('');
    lines.push(t.body);
    for (const r of t.replies ?? []) {
      lines.push('', `> **${r.author}:** ${r.body.replaceAll('\n', '\n> ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// Client page — written as a real function, served via Function.toString(),
// so the client code keeps normal JS syntax (no escaping gymnastics).
// ============================================================================

function clientMain() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const WAIT_TOKEN = new URLSearchParams(location.search).get('wait') || '';
  let SENT = false;
  let LABEL = '';
  let BRANCH = '';
  let EXPANDABLE = false;
  let FILES = [];
  let THREADS = [];
  let curFile = null;        // selected file index
  let sel = null;            // { file, side: 'old'|'new', start, end }
  let currentCat = 'task';   // composer kind: 'task' | 'comment'
  let viewMode = 'unified';
  let sortKey = 'file';
  let showResolved = true;   // sidebar keeps resolved remarks visible by default
  let collapsed = new Set(); // collapsed dir paths

  // Lite remark kinds: Task (agent fixes it, checkbox is a plain toggle) and Comment.
  // Stored under the shared XD contract: task → request-changes, comment → comment.
  const CATS = [
    { key: 'task', api: 'request-changes', label: 'Task' },
    { key: 'comment', api: 'comment', label: 'Comment' },
  ];

  // ---------------------------------------------------------------- utilities

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(text, ms = 4200) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  /** "You" for the reviewer, the real name after the prefix for everyone else. */
  function authorLabel(a) {
    if (!a) return '';
    if (a === 'human:me' || a === 'human:') return 'You';
    const m = /^(human|agent):(.+)$/.exec(a);
    if (m) return m[2] || m[1];
    return a;
  }

  /** Role class for the author chip ('human' | 'agent'). */
  function authorRole(a) {
    return String(a || '').startsWith('agent:') ? 'agent' : 'human';
  }

  function authorChip(author) {
    return `<span class="t-author chip-${authorRole(author)}">${esc(authorLabel(author))}</span>`;
  }

  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return `${d.getDate()}.${d.getMonth() + 1}`;
  }

  async function api(url, method, body) {
    const res = await fetch(url, {
      method: method || 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {}
    return undefined;
  }

  // ------------------------------------------------------------------- theme

  function initTheme() {
    let t = store('xd-lite-theme');
    if (t !== 'dark' && t !== 'light') {
      t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = t;
    $('themeToggle').textContent = t === 'dark' ? '☀' : '☾';
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    $('themeToggle').textContent = next === 'dark' ? '☀' : '☾';
    store('xd-lite-theme', next);
  }

  // -------------------------------------------------- syntax highlighting
  // Small dependency-free tokenizer: strings, line/block comments, numbers,
  // keywords, function names. State (block comments, multiline strings)
  // carries across diff lines within a file. Not compiler-grade — review-grade.

  const KW_RAW = {
    js: 'var let const function return if else for while do switch case break continue new class extends super this import export from default try catch finally throw async await yield typeof instanceof in of null undefined true false static get set delete void debugger with',
    ts: 'interface type enum implements public private protected readonly namespace declare satisfies keyof infer is abstract any string number boolean unknown never as',
    python: 'def class return if elif else for while import from as with try except finally raise lambda yield pass break continue global nonlocal assert del in is not and or None True False async await match case self cls print',
    go: 'package import func var const type struct interface map chan go defer if else for range switch case default return break continue select fallthrough nil true false make new len cap append delete copy close panic recover',
    rust: 'fn let mut const static struct enum impl trait pub use mod match if else for while loop break continue return async await move ref where dyn as in true false Some None Ok Err self Self crate super unsafe extern box type',
    c: 'int char float double void long short unsigned signed struct union enum typedef static extern const volatile return if else for while do switch case default break continue goto sizeof class public private protected virtual override namespace using template typename new delete this nullptr NULL true false auto constexpr inline explicit operator friend mutable register',
    java: 'public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do switch case break continue throw throws try catch finally import package this super null true false abstract enum record sealed synchronized volatile transient instanceof default assert',
    csharp: 'using namespace class struct interface enum record public private protected internal static readonly const void var new return if else for foreach while do switch case break continue throw try catch finally in out ref this base null true false async await override virtual abstract sealed partial get set nameof',
    swift: 'import struct class enum protocol extension func var let return if else guard for while repeat switch case default break continue in out self Self nil true false public private internal open fileprivate typealias where deinit init subscript throw throws try catch defer async await actor some any',
    ruby: 'def end class module if elsif else unless while until for do begin rescue ensure raise yield require require_relative attr_accessor attr_reader attr_writer nil true false self proc lambda then case when puts',
    php: 'function return if else elseif foreach for while do switch case break continue class interface trait extends implements public private protected static const new echo print require include require_once include_once namespace use try catch finally throw isset unset global list as null true false abstract final',
    sql: 'select from where insert into values update set delete create table alter drop add index view join left right inner outer cross on group by order having limit offset union all distinct as and or not null is in like between exists case when then else end primary key foreign references default unique check constraint',
    sh: 'if then else elif fi for while until do done case esac function return export local readonly echo printf exit set unset shift source alias unalias in select time trap cd ls mkdir rm cp mv grep sed awk cat sudo',
    yaml: 'true false null yes no on off',
    json: 'true false null',
    toml: 'true false',
  };

  const KW = {};
  for (const lk of Object.keys(KW_RAW)) {
    const o = {};
    for (const w of KW_RAW[lk].split(' ')) if (w) o[w] = 1;
    KW[lk] = o;
  }

  const EXT_LANG = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    py: 'python', pyw: 'python',
    go: 'go', rs: 'rust',
    c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c',
    java: 'java', kt: 'java', kts: 'java', groovy: 'java', cs: 'csharp', swift: 'swift',
    rb: 'ruby', php: 'php', sql: 'sql',
    sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', astro: 'html',
    json: 'json', jsonc: 'json', json5: 'json',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', tml: 'toml', ini: 'conf', cfg: 'conf', conf: 'conf', env: 'conf', properties: 'conf',
    md: 'md', markdown: 'md',
  };
  const SLASH_COMMENT = { js: 1, ts: 1, c: 1, java: 1, csharp: 1, go: 1, rust: 1, swift: 1, php: 1, css: 1, sql: 1 };
  const HASH_COMMENT = { python: 1, sh: 1, yaml: 1, ruby: 1, conf: 1, toml: 1, php: 1 };

  const sp = (cls, s) => `<span class="tk-${cls}">${esc(s)}</span>`;

  function hlText(text, lang, st) {
    if (lang === 'md') {
      if (/^\s*#{1,6}\s/.test(text)) return sp('kw', text);
      return esc(text).replace(/`([^`]+)`/g, '<span class="tk-st">`$1`</span>');
    }
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
      if (st.block) {
        // st.block holds the block-comment end marker as a plain string ('*/' or '-->')
        const end = text.indexOf(st.block, i);
        if (end === -1) {
          out += sp('cm', text.slice(i));
          i = n;
        } else {
          out += sp('cm', text.slice(i, end + st.block.length));
          i = end + st.block.length;
          st.block = null;
        }
        continue;
      }
      if (st.str) {
        const q = st.str;
        let j = i;
        let found = -1;
        while (j < n) {
          if (q.length === 1 && text[j] === '\\') { j += 2; continue; }
          if (text.startsWith(q, j)) { found = j; break; }
          j++;
        }
        if (found === -1) {
          out += sp('st', text.slice(i));
          i = n;
          if (q.length === 1 && (q === '"' || q === "'")) st.str = null; // unterminated: stop at EOL
        } else {
          out += sp('st', text.slice(i, found + q.length));
          i = found + q.length;
          st.str = null;
        }
        continue;
      }
      const c = text[i];
      if (SLASH_COMMENT[lang] && c === '/' && text[i + 1] === '/') { out += sp('cm', text.slice(i)); break; }
      if (lang === 'sql' && c === '-' && text[i + 1] === '-') { out += sp('cm', text.slice(i)); break; }
      if (HASH_COMMENT[lang] && c === '#') { out += sp('cm', text.slice(i)); break; }
      if (SLASH_COMMENT[lang] && c === '/' && text[i + 1] === '*') { st.block = '*/'; out += sp('cm', '/*'); i += 2; continue; }
      if (lang === 'html' && text.startsWith('<!--', i)) { st.block = '-->'; out += sp('cm', '<!--'); i += 4; continue; }
      if (lang === 'html' && c === '<') {
        const mTag = /^<\/?[A-Za-z][\w:-]*/.exec(text.slice(i));
        if (mTag) { out += sp('kw', mTag[0]); i += mTag[0].length; continue; }
      }
      if (lang === 'css' && c === '@') {
        const mAt = /^@[\w-]+/.exec(text.slice(i));
        if (mAt) { out += sp('kw', mAt[0]); i += mAt[0].length; continue; }
      }
      if (lang === 'css' && c === '#') {
        const mHex = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(i));
        if (mHex) { out += sp('nu', mHex[0]); i += mHex[0].length; continue; }
      }
      if (lang === 'python' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const tq = text.slice(i, i + 3);
        const e3 = text.indexOf(tq, i + 3);
        if (e3 === -1) { st.str = tq; out += sp('st', text.slice(i)); i = n; }
        else { out += sp('st', text.slice(i, e3 + 3)); i = e3 + 3; }
        continue;
      }
      if (c === '"' || c === "'" || (c === '`' && (lang === 'js' || lang === 'ts'))) {
        let k = i + 1;
        let f = -1;
        while (k < n) {
          if (text[k] === '\\') { k += 2; continue; }
          if (text.startsWith(c, k)) { f = k; break; }
          k++;
        }
        if (f === -1) {
          out += sp('st', text.slice(i));
          i = n;
          if (c === '`') st.str = c; // template literals span lines
        } else {
          const isKey = lang === 'json' && c === '"' && /^\s*:/.test(text.slice(f + 1));
          out += sp(isKey ? 'prop' : 'st', text.slice(i, f + 1));
          i = f + 1;
        }
        continue;
      }
      if (/[0-9]/.test(c) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
        const mNum = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?[fFuUlLdD]*)/.exec(text.slice(i));
        if (mNum) { out += sp('nu', mNum[0]); i += mNum[0].length; continue; }
      }
      if (/[A-Za-z_$@]/.test(c)) {
        const mId = /^[A-Za-z_$@][\w$]*/.exec(text.slice(i));
        const word = mId[0];
        const kwHit = KW[lang] && (KW[lang][word] || KW[lang][word.toLowerCase()]);
        if (kwHit) out += sp('kw', word);
        else if (/^\s*\(/.test(text.slice(i + word.length))) out += sp('fn', word);
        else if ((lang === 'yaml' || lang === 'toml' || lang === 'conf') && text[i + word.length] === ':') out += sp('prop', word);
        else out += esc(word);
        i += word.length;
        continue;
      }
      out += esc(c);
      i++;
    }
    return out;
  }

  function extLang(filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    return EXT_LANG[ext] || null;
  }

  // -------------------------------------------------------------- diff parse

  function parseDiff(text) {
    const files = [];
    let f = null;
    let hunk = null;
    let oldNo = 0;
    let newNo = 0;
    const strip = (p) => {
      if (!p || p === '/dev/null') return null;
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p.replace(/^[ab]\//, '');
    };
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const mm = line.slice(11).match(/ b\/(.+)$/);
        f = { path: mm ? strip('b/' + mm[1]) : '', type: 'modify', binary: false, hunks: [], adds: 0, dels: 0 };
        files.push(f);
        hunk = null;
        continue;
      }
      if (!f) continue;
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { f.binary = true; continue; }
      if (line.startsWith('new file mode')) { f.type = 'add'; continue; }
      if (line.startsWith('deleted file mode')) { f.type = 'del'; continue; }
      if (line.startsWith('rename from ') || line.startsWith('rename to ')) { f.type = 'rename'; continue; }
      if (line.startsWith('--- ')) { const p = strip(line.slice(4)); if (p) f.path = p; continue; }
      if (line.startsWith('+++ ')) { const p = strip(line.slice(4)); if (p) f.path = p; continue; }
      if (
        line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('dissimilarity ') ||
        line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('copy ')
      ) continue;
      if (line.startsWith('@@')) {
        const mh = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        hunk = {
          header: line,
          oldStart: mh ? parseInt(mh[1], 10) : 1,
          oldCount: mh && mh[2] !== undefined ? parseInt(mh[2], 10) : 1,
          newStart: mh ? parseInt(mh[3], 10) : 1,
          newCount: mh && mh[4] !== undefined ? parseInt(mh[4], 10) : 1,
          rows: [],
        };
        f.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        continue;
      }
      if (!hunk) continue;
      if (line.startsWith('\\')) { hunk.rows.push({ t: 'meta', text: line }); continue; }
      const t = line.charAt(0);
      if (t === '+') { f.adds++; hunk.rows.push({ t: 'add', new: newNo++, text: line.slice(1) }); }
      else if (t === '-') { f.dels++; hunk.rows.push({ t: 'del', old: oldNo++, text: line.slice(1) }); }
      else if (t === ' ') { hunk.rows.push({ t: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) }); }
    }
    FILES = files;
    FILES.forEach((file, i) => { file.idx = i; });
    return files;
  }

  // ------------------------------------------------------ split-view pairing

  /** Pair del/ctx rows (old side) with add/ctx rows (new side) within a hunk. */
  function alignHunk(rows) {
    const pairs = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.t === 'meta') { pairs.push({ meta: r }); i++; continue; }
      if (r.t === 'ctx') { pairs.push({ l: r, r }); i++; continue; }
      if (r.t === 'del') {
        const dels = [];
        while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
        const adds = [];
        while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) pairs.push({ l: dels[k] || null, r: adds[k] || null });
        continue;
      }
      pairs.push({ l: null, r }); // lone add
      i++;
    }
    return pairs;
  }

  // ------------------------------------------------------------------ render

  function typeChip(f) {
    if (f.type === 'add') return '<span class="badge type-badge">new</span>';
    if (f.type === 'del') return '<span class="badge del">deleted</span>';
    if (f.type === 'rename') return '<span class="badge type-badge">renamed</span>';
    return '';
  }

  function rowHtml(r, lang, st) {
    const cls = r.t === 'add' ? ' add' : r.t === 'del' ? ' del' : '';
    const dataNew = r.new != null ? ` data-new="${r.new}"` : '';
    const dataOld = r.old != null ? ` data-old="${r.old}"` : '';
    const code = hlText(r.text, lang, st) || '&#8203;';
    return (
      `<tr class="row${cls}"${dataNew}${dataOld}>` +
      `<td class="num num-old">${r.old != null ? r.old : ''}</td>` +
      `<td class="num num-new">${r.new != null ? r.new : ''}</td>` +
      `<td class="code">${code}</td></tr>`
    );
  }

  function pairHtml(pair, lang, st) {
    if (pair.meta) {
      return `<tr class="meta-row"><td class="num"></td><td class="code tk-meta">${esc(pair.meta.text)}</td><td class="num"></td><td class="code"></td></tr>`;
    }
    const l = pair.l;
    const r = pair.r;
    const lcls = l && l.t === 'del' ? ' del' : '';
    const rcls = r && r.t === 'add' ? ' add' : '';
    const dataNew = r && r.new != null ? ` data-new="${r.new}"` : '';
    const dataOld = l && l.old != null ? ` data-old="${l.old}"` : '';
    const lcode = l ? (hlText(l.text, lang, st) || '&#8203;') : '';
    const rcode = r ? (hlText(r.text, lang, st) || '&#8203;') : '';
    return (
      `<tr class="row${lcls || rcls}"${dataNew}${dataOld}>` +
      `<td class="num num-old${lcls}">${l && l.old != null ? l.old : ''}</td>` +
      `<td class="code code-old${lcls}">${lcode}</td>` +
      `<td class="num num-new${rcls}">${r && r.new != null ? r.new : ''}</td>` +
      `<td class="code code-new${rcls}">${rcode}</td></tr>`
    );
  }

  function hunkHeadHtml(header, cols, hi) {
    if (cols === 3) {
      return `<tr class="hunk-head" data-hunkhead="${hi}"><td class="num"></td><td class="num"></td><td class="code"><span class="tk-meta">${esc(header)}</span></td></tr>`;
    }
    return `<tr class="hunk-head" data-hunkhead="${hi}"><td class="num"></td><td class="code"><span class="tk-meta">${esc(header)}</span></td><td class="num"></td><td class="code"></td></tr>`;
  }

  /** Twitter-minimal widget: big task checkbox (if any) + You/name · time. */
  function widgetCardHtml(t) {
    const isTask = t.category === 'request-changes';
    const done = t.status === 'resolved';
    let h = `<div class="thread ${isTask ? 'is-task' : 'is-comment'}${done ? ' resolved' : ''}" data-thread="${t.id}">`;
    if (isTask) {
      h += `<span class="task-cb${done ? ' done' : ''}" data-task="${t.id}" title="${done ? 'Done — click to reopen' : 'Mark done'}">✓</span>`;
    }
    h += '<div class="t-main">';
    h += `<div class="t-head">${authorChip(t.author)}<span class="t-time">${esc(relTime(t.createdAt))}</span><span class="flex"></span>`;
    if (!done && !SENT) {
      h += `<button class="icon-btn edit-thread" data-editstart="${t.id}" title="Edit">✎</button>`;
      h += `<span class="del-zone" id="dz-${t.id}"><button class="icon-btn del-thread" data-delstart="${t.id}" title="Delete">✕</button></span>`;
    }
    if (done && t.resolvedBy) {
      h += `<span class="t-resolvedby" title="Who marked this done">✓ ${esc(authorLabel(t.resolvedBy))}</span>`;
    }
    h += '</div>';
    h += `<div class="thread-body">${mdHtml(t.body)}</div>`;
    for (const r of t.replies ?? []) {
      h += `<div class="reply"><div class="reply-head">${authorChip(r.author)} <span class="t-time">${esc(relTime(r.at))}</span></div><div class="reply-body">${mdHtml(r.body)}</div></div>`;
    }
    h += '</div></div>';
    return h;
  }

  /** Inline body editor swapped in for .thread-body while editing a remark. */
  function threadEditHtml(id, body) {
    return '<div class="thread-edit">' +
      `<textarea class="composer-text edit-ta" data-editid="${esc(id)}">${esc(body)}</textarea>` +
      '<div class="composer-actions">' +
      '<span class="hint">Ctrl/⌘+Enter — save · Esc — cancel</span><span class="flex"></span>' +
      `<button type="button" class="btn ghost" data-editcancel="${esc(id)}">Cancel</button>` +
      `<button type="button" class="btn primary" data-editsave="${esc(id)}">Save</button>` +
      '</div></div>';
  }

  /** In split view a widget stays on the half it was written on. */
  function widgetRowHtml(t, cols) {
    const card = widgetCardHtml(t);
    if (cols === 4) {
      if (t.anchor.side === 'old') {
        return `<tr class="widget-row"><td colspan="2" class="wcell">${card}</td><td class="wvoid"></td><td class="wvoid"></td></tr>`;
      }
      return `<tr class="widget-row"><td class="wvoid"></td><td class="wvoid"></td><td colspan="2" class="wcell">${card}</td></tr>`;
    }
    return `<tr class="widget-row"><td colspan="3">${card}</td></tr>`;
  }

  /** Gap ids ('0', '1', … before that hunk; 't' trailing) with expanded context. */
  let expandedGaps = new Set();

  /** Hide a hunk's @@ header once context flows continuously around it (GitHub-style). */
  function updateHunkHeaders() {
    const f = FILES[curFile];
    if (!f) return;
    const hs = f.hunks;
    document.querySelectorAll('#content [data-hunkhead]').forEach((el) => {
      const h = Number(el.dataset.hunkhead);
      // gap `h` sits right before hunk `h`; for the first hunk it may not exist
      // at all when the hunk starts at the top of the file
      const beforeKnown =
        expandedGaps.has(String(h)) || (h === 0 && hs[0].newStart === 1 && hs[0].oldStart === 1);
      const isLast = h === hs.length - 1;
      const afterKnown = isLast
        ? (EXPANDABLE ? expandedGaps.has('t') : false)
        : expandedGaps.has(String(h + 1));
      el.classList.toggle('hidden', beforeKnown && afterKnown);
    });
  }

  function fileTableHtml(f) {
    expandedGaps = new Set();
    const lang = extLang(f.path);
    const st = { block: null, str: null };
    const split = viewMode === 'split';
    const cols = split ? 4 : 3;
    let s = `<div class="diff-scroll"><table class="diff${split ? ' split' : ''}">`;
    const byNew = {};
    const byOld = {};
    for (const t of THREADS) {
      if (t.file !== f.path) continue;
      const map = t.anchor.side === 'old' ? byOld : byNew;
      (map[t.anchor.lines[0]] ??= []).push(t);
    }
    const placeWidgets = (r) => {
      let out = '';
      if (r.new != null && byNew[r.new]) for (const t of byNew[r.new]) out += widgetRowHtml(t, cols);
      if (r.old != null && byOld[r.old]) for (const t of byOld[r.old]) out += widgetRowHtml(t, cols);
      return out;
    };
    const hs = f.hunks;
    hs.forEach((hk, hi) => {
      // collapsible unchanged context before/between hunks (needs blob access)
      if (EXPANDABLE) {
        let g;
        if (hi === 0) {
          g = { oF: 1, oT: hk.oldStart - 1, nF: 1, nT: hk.newStart - 1 };
        } else {
          const prev = hs[hi - 1];
          g = { oF: prev.oldStart + prev.oldCount, oT: hk.oldStart - 1, nF: prev.newStart + prev.newCount, nT: hk.newStart - 1 };
        }
        if (g.nT >= g.nF || g.oT >= g.oF) s += gapRowHtml(f.idx, hi, g, cols);
      }
      s += hunkHeadHtml(hk.header, cols, hi);
      if (split) {
        for (const pair of alignHunk(hk.rows)) {
          if (pair.meta) {
            s += `<tr class="meta-row"><td class="num"></td><td class="code tk-meta">${esc(pair.meta.text)}</td><td class="num"></td><td class="code"></td></tr>`;
            continue;
          }
          s += pairHtml(pair, lang, st);
          s += placeWidgets({ new: pair.r ? pair.r.new : null, old: pair.l ? pair.l.old : null });
        }
      } else {
        for (const r of hk.rows) {
          if (r.t === 'meta') {
            s += `<tr class="meta-row"><td class="num"></td><td class="num"></td><td class="code tk-meta">${esc(r.text)}</td></tr>`;
            continue;
          }
          s += rowHtml(r, lang, st);
          s += placeWidgets(r);
        }
      }
    });
    if (hs.length && EXPANDABLE) {
      s += `<tr class="gap-row" data-gaprow="${f.idx}:t"><td colspan="${cols}">` +
        `<button class="gap-btn" data-gap="${f.idx}:t">⋯ Expand trailing context</button></td></tr>`;
    }
    s += '</table></div>';
    return s;
  }

  function gapRowHtml(fi, gi, g, cols) {
    const n = Math.max(g.nT - g.nF + 1, g.oT - g.oF + 1, 1);
    return `<tr class="gap-row" data-gaprow="${fi}:${gi}"><td colspan="${cols}">` +
      `<button class="gap-btn" data-gap="${fi}:${gi}" data-n="${n}">⋯ Expand ${n} unchanged line${n === 1 ? '' : 's'}</button></td></tr>`;
  }

  async function ensureBlobs(fi) {
    const f = FILES[fi];
    if (f._blobs !== undefined) return f._blobs;
    if (!EXPANDABLE) { f._blobs = null; return null; }
    try {
      const [nb, ob] = await Promise.all([
        api('/api/blob?path=' + encodeURIComponent(f.path) + '&side=new'),
        api('/api/blob?path=' + encodeURIComponent(f.path) + '&side=old'),
      ]);
      if (nb.binary || ob.binary || nb.text == null || ob.text == null) {
        f._blobs = null;
      } else {
        f._blobs = { newLines: nb.text.split('\n'), oldLines: ob.text.split('\n') };
      }
    } catch {
      f._blobs = null;
    }
    return f._blobs;
  }

  async function expandGap(fi, gi) {
    const f = FILES[fi];
    const gapRow = document.querySelector(`[data-gaprow="${fi}:${gi}"]`);
    if (!gapRow) return;
    const btn = gapRow.querySelector('.gap-btn');
    if (btn) btn.textContent = '⋯ Loading…';
    const blobs = await ensureBlobs(fi);
    if (!blobs) {
      toast('Cannot expand context for this file (no blob or binary).');
      if (btn) btn.textContent = '⋯ Expand';
      return;
    }
    // the gap is now "known" even if it turns out empty — affects @@ header hiding
    expandedGaps.add(String(gi));
    updateHunkHeaders();
    const trailing = gi === 't';
    const hs = f.hunks;
    let g;
    if (trailing) {
      const last = hs[hs.length - 1];
      g = {
        oF: last.oldStart + last.oldCount,
        oT: blobs.oldLines.length,
        nF: last.newStart + last.newCount,
        nT: blobs.newLines.length,
      };
    } else if (gi === 0) {
      const hk = hs[0];
      g = { oF: 1, oT: hk.oldStart - 1, nF: 1, nT: hk.newStart - 1 };
    } else {
      const prev = hs[gi - 1];
      const hk = hs[gi];
      g = { oF: prev.oldStart + prev.oldCount, oT: hk.oldStart - 1, nF: prev.newStart + prev.newCount, nT: hk.newStart - 1 };
    }
    const nT = Math.min(g.nT, blobs.newLines.length);
    const oT = Math.min(g.oT, blobs.oldLines.length);
    const count = Math.max(Math.min(nT - g.nF + 1, oT - g.oF + 1), 0);
    if (count <= 0) {
      gapRow.remove();
      return;
    }
    const lang = extLang(f.path);
    const split = viewMode === 'split';
    let html = '';
    for (let k = 0; k < count; k++) {
      const text = blobs.newLines[g.nF - 1 + k] ?? '';
      const o = g.oF + k;
      const nw = g.nF + k;
      html += split
        ? pairHtml({ l: { t: 'ctx', old: o, text }, r: { t: 'ctx', new: nw, text } }, lang, { block: null, str: null })
        : rowHtml({ t: 'ctx', old: o, new: nw, text }, lang, { block: null, str: null });
    }
    gapRow.outerHTML = html;
  }

  /** Toolbar button: expand every context gap at once, or collapse them back.
   *  Expanding mutates the DOM in place (renderMain would reset expandedGaps). */
  async function toggleAllGaps() {
    const f = FILES[curFile];
    if (!f || !EXPANDABLE) return;
    const anyCollapsed = document.querySelector('#content [data-gaprow]');
    if (!anyCollapsed) {
      expandedGaps = new Set();
      renderMain();
      return;
    }
    if (!(await ensureBlobs(curFile))) {
      toast('Cannot expand context for this file (no blob or binary).');
      return;
    }
    for (let gi = 0; gi < f.hunks.length; gi++) await expandGap(curFile, gi);
    await expandGap(curFile, 't');
    // repaint just the toolbar button — a full render would reset expandedGaps
    const btn = document.querySelector('#toolbar [data-expandall]');
    if (btn) {
      btn.textContent = '⤡';
      btn.title = 'Collapse context';
    }
  }

  function mdHtml(text) {
    const parts = String(text).split('```');
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        let code = parts[i];
        const nl = code.indexOf('\n');
        if (nl !== -1) code = code.slice(nl + 1); // drop the language line
        out += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      } else {
        let t = esc(parts[i]);
        t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/\n/g, '<br>');
        out += t;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ sidebar

  function buildTree() {
    const root = { dirs: new Map(), files: [] };
    for (const f of FILES) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [], path: p });
        node = node.dirs.get(parts[i]);
      }
      node.files.push(f);
    }
    return root;
  }

  function openThreadCount(filePaths) {
    const set = new Set(filePaths);
    return THREADS.filter((t) => set.has(t.file) && t.status !== 'resolved').length;
  }

  function collectFilePaths(node, acc = []) {
    for (const f of node.files) acc.push(f.path);
    for (const d of node.dirs.values()) collectFilePaths(d, acc);
    return acc;
  }

  function treeHtml(node, depth) {
    let h = '';
    const dirs = [...node.dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const d of dirs) {
      const isOpen = !collapsed.has(d.path);
      const count = openThreadCount(collectFilePaths(d));
      h += `<button class="tree-row dir" data-dir="${esc(d.path)}" style="--depth:${depth}">` +
        `<span class="tw">${isOpen ? '▾' : '▸'}</span>` +
        `<span class="entry-name">${esc(d.path.split('/').pop())}</span>` +
        (count ? `<span class="pill-count">${count}</span>` : '') +
        `</button>`;
      if (isOpen) h += treeHtml(d, depth + 1);
    }
    for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
      const active = curFile === f.idx;
      const tc = openThreadCount([f.path]);
      const ico = f.type === 'add' ? 'A' : f.type === 'del' ? 'D' : 'M';
      h += `<button class="tree-row file${active ? ' active' : ''}" data-file="${f.idx}" style="--depth:${depth}" title="${esc(f.path)}">` +
        `<span class="file-ico ico-${ico}">${ico}</span>` +
        `<span class="entry-name">${esc(f.path.split('/').pop())}</span>` +
        `<span class="file-stats"><i class="sa">+${f.adds}</i><i class="sd">−${f.dels}</i></span>` +
        (tc ? `<span class="pill-count">${tc}</span>` : '') +
        `</button>`;
    }
    return h;
  }

  function sortedThreads() {
    const arr = [...THREADS];
    const byFileLine = (a, b) => a.file.localeCompare(b.file) || a.anchor.lines[0] - b.anchor.lines[0];
    const statusRank = (t) => (t.status === 'resolved' ? 2 : t.category === 'request-changes' ? 0 : 1);
    if (sortKey === 'status') arr.sort((a, b) => statusRank(a) - statusRank(b) || byFileLine(a, b));
    else if (sortKey === 'time') arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    else if (sortKey === 'type') arr.sort((a, b) => a.category.localeCompare(b.category) || byFileLine(a, b));
    else arr.sort(byFileLine);
    return arr;
  }

  function commentItemHtml(t) {
    const done = t.status === 'resolved';
    const isTask = t.category === 'request-changes';
    const box = isTask
      ? `<span class="task-box${done ? ' done' : ''}" data-task="${t.id}" title="Toggle task">${done ? '✓' : ''}</span>`
      : '<span class="c-ico"></span>'; // plain filled dot — not a button
    const snip = t.body.replace(/\s+/g, ' ').trim().slice(0, 80);
    const sideMark = t.anchor.side === 'old' ? '−' : '';
    const [l1, l2] = t.anchor.lines;
    const lineStr = l2 > l1 ? `${l1}–${l2}` : `${l1}`; // shift-click range is visible
    const resolvedTxt = done && t.resolvedBy ? ` · ✓ ${esc(authorLabel(t.resolvedBy))}` : '';
    return `<div class="c-item${done ? ' resolved' : ''}" data-goto="${t.id}">` +
      box +
      `<span class="c-body">` +
      `<span class="c-meta">${esc(t.file.split('/').pop())}:${sideMark}${lineStr} · ${esc(authorLabel(t.author))} · ${esc(relTime(t.createdAt))}${resolvedTxt}</span>` +
      `<span class="c-snip">${esc(snip)}</span>` +
      `</span></div>`;
  }

  function renderSidebar() {
    // header aggregate: brand · repo · branch · +adds −dels
    const adds = FILES.reduce((a, f) => a + f.adds, 0);
    const dels = FILES.reduce((a, f) => a + f.dels, 0);
    $('stats').textContent = `+${adds} −${dels}`;
    // counters live next to the Send review button
    const tasks = THREADS.filter((t) => t.category === 'request-changes');
    const done = tasks.filter((t) => t.status === 'resolved').length;
    const others = THREADS.length - tasks.length;
    const open = THREADS.filter((t) => t.status !== 'resolved').length;
    $('footMeta').innerHTML =
      `<span><span class="done">✓ ${done}</span>/${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>` +
      '<span>·</span>' +
      `<span class="open-t">${open} open</span>` +
      '<span>·</span>' +
      `<span>${others} comment${others === 1 ? '' : 's'}</span>`;
    $('commentCount').textContent = THREADS.length || '';
    $('fileCount').textContent = FILES.length || '';
    $('tree').innerHTML = FILES.length ? treeHtml(buildTree(), 0) : '<div class="tree-empty">No changes</div>';
    const sorted = sortedThreads().filter((t) => showResolved || t.status !== 'resolved');
    $('commentList').innerHTML = sorted.length
      ? sorted.map(commentItemHtml).join('')
      : '<div class="tree-empty">No comments yet — hover a line in the diff and pick Task or Comment.</div>';
    $('sendBtn').textContent = 'Send review to agent';
  }

  // -------------------------------------------------------------------- main

  function renderMain() {
    const content = $('content');
    const toolbar = $('toolbar');
    if (curFile == null || !FILES.length) {
      toolbar.innerHTML = '';
      content.innerHTML = `<div class="empty">${FILES.length
        ? 'Select a file in the tree.'
        : SRC_KEY === 'working'
          ? 'Everything is committed — no uncommitted changes.<br>Switch the source to <b>PR</b> to see what the branch adds.'
          : `Nothing to show — <b>${esc(LABEL)}</b> has no changes.`}</div>`;
      return;
    }
    const f = FILES[curFile];
    // (a fresh render is always collapsed — fileTableHtml resets expandedGaps —
    //  so the expand-all button starts in its "expand" state; toggleAllGaps
    //  flips it in place after expanding)
    toolbar.innerHTML =
      `<span class="toolbar-path">${esc(f.path)}</span>${typeChip(f)}` +
      `<span class="badge add">+${f.adds}</span><span class="badge del">−${f.dels}</span>` +
      `<span class="flex"></span>` +
      (EXPANDABLE ? `<button class="icon-btn" data-expandall title="Expand all context">⤢</button>` : '') +
      `<button class="icon-btn" id="viewToggle" title="${viewMode === 'split' ? 'Switch to unified view' : 'Switch to split view'}">${viewMode === 'split' ? '◫' : '☰'}</button>`;
    if (f.binary) {
      content.innerHTML = '<div class="empty">Binary file — contents not shown.</div>';
      return;
    }
    content.innerHTML = fileTableHtml(f);
  }

  function renderAll(preserveScroll) {
    const main = $('mainArea');
    const st = main.scrollTop;
    renderSidebar();
    renderMain();
    if (preserveScroll) main.scrollTop = st;
  }

  // -------------------------------------------------------------- selection

  function composerInner() {
    // The kind (Task/Comment) is picked on the hover pill before the composer
    // opens — no duplicate category buttons inside (they read as stray pills).
    const primary = currentCat === 'task' ? 'Add task' : 'Add comment';
    return '<div class="composer">' +
      '<textarea class="composer-text" placeholder="Leave a comment — markdown is ok"></textarea>' +
      '<div class="composer-actions"><span class="hint">Ctrl/⌘+Enter — send · Esc — cancel</span><span class="flex"></span>' +
      '<button type="button" class="btn ghost" data-act="cancel">Cancel</button>' +
      `<button type="button" class="btn primary" data-act="send">${primary}</button>` +
      '</div></div>';
  }

  const composerTr = document.createElement('tr');
  composerTr.className = 'composer-row';
  composerTr.innerHTML = `<td colspan="3">${composerInner()}</td>`;

  composerTr.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'send') submitComment();
    else if (btn.dataset.act === 'cancel') cancelComposer();
  });

  function placeComposer(row) {
    composerTr.remove();
    hideHoverBar();
    const side = sel && sel.side === 'old' ? 'old' : 'new';
    if (viewMode === 'split') {
      const inner = `<td colspan="2" class="wcell">${composerInner()}</td><td class="wvoid"></td><td class="wvoid"></td>`;
      composerTr.innerHTML = side === 'old'
        ? inner
        : `<td class="wvoid"></td><td class="wvoid"></td><td colspan="2" class="wcell">${composerInner()}</td>`;
    } else {
      composerTr.innerHTML = `<td colspan="3">${composerInner()}</td>`;
    }
    row.after(composerTr);
    composerTr.querySelector('textarea').focus();
  }

  function cancelComposer() {
    composerTr.remove();
    hideHoverBar();
    sel = null;
    document.querySelectorAll('tr.row.sel').forEach((r) => r.classList.remove('sel'));
  }

  function paintSelection(fi) {
    document.querySelectorAll('#content tr.row').forEach((r) => {
      let inRange = false;
      if (sel && sel.file === fi) {
        const s = sel.side === 'old' ? r.dataset.old : r.dataset.new;
        if (s != null) {
          const n = Number(s);
          inRange = n >= sel.start && n <= sel.end;
        }
      }
      r.classList.toggle('sel', inRange);
    });
  }

  async function submitComment() {
    if (sel == null || curFile == null || SENT) return;
    const ta = composerTr.querySelector('textarea');
    const body = ta.value;
    if (!body.trim()) {
      ta.focus();
      return;
    }
    const cat = CATS.find((c) => c.key === currentCat) || CATS[1];
    try {
      await api('/api/threads', 'POST', {
        file: FILES[curFile].path,
        lines: [sel.start, sel.end],
        side: sel.side,
        category: cat.api,
        body,
      });
      cancelComposer();
      THREADS = (await api('/api/threads')).threads;
      renderAll(true);
    } catch (err) {
      toast('Could not save comment: ' + err.message);
    }
  }

  async function toggleTask(id, checked) {
    try {
      await api('/api/threads/' + encodeURIComponent(id), 'PATCH', {
        status: checked ? 'resolved' : 'open',
        actor: 'human:me',
      });
      THREADS = (await api('/api/threads')).threads;
      renderAll(true);
    } catch (err) {
      toast('Could not update task: ' + err.message);
    }
  }

  async function deleteThread(id) {
    try {
      await api('/api/threads/' + encodeURIComponent(id), 'DELETE');
      THREADS = (await api('/api/threads')).threads;
      renderAll(true);
    } catch (err) {
      toast('Could not delete comment: ' + err.message);
    }
  }

  async function saveThreadEdit(id) {
    const ta = document.querySelector(`.edit-ta[data-editid="${id}"]`);
    if (!ta) return;
    if (!ta.value.trim()) {
      ta.focus();
      return;
    }
    try {
      await api('/api/threads/' + encodeURIComponent(id), 'PATCH', { body: ta.value });
      THREADS = (await api('/api/threads')).threads;
      renderAll(true);
    } catch (err) {
      toast('Could not save edit: ' + err.message);
    }
  }

  function jumpToThread(id) {
    const t = THREADS.find((x) => x.id === id);
    if (!t) return;
    const fi = FILES.findIndex((f) => f.path === t.file);
    if (fi === -1) {
      toast('This comment is on a file that is not in the current diff.');
      return;
    }
    curFile = fi;
    cancelComposer();
    renderAll(false);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-thread="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
      }
    });
  }

  // ------------------------------------------------------------- delegations

  // ------------------------------------------------------ hover quick-add
  // Hovering a diff line (with its highlight) shows a small Task/Comment pill
  // under the cursor: the remark kind is picked before the click, and the
  // composer opens pre-set to that kind — no click-then-choose roundtrip.
  const hoverBar = $('hoverBar');
  let hoverRow = null; // tr.row the bar is anchored to
  let hoverPos = null; // { side, line } under the cursor

  function hideHoverBar() {
    if (hoverRow) hoverRow.classList.remove('hb-hl');
    hoverRow = null;
    hoverPos = null;
    hoverBar.classList.remove('show');
  }

  /** Which side/line of the row the pointer is on (split view: the half decides). */
  function rowSideAt(tr, e) {
    if (viewMode === 'split') {
      const onLeft = e.target.closest('td.code-old, td.num-old');
      if (onLeft && tr.dataset.old != null) return { side: 'old', line: Number(tr.dataset.old) };
      if (tr.dataset.new != null) return { side: 'new', line: Number(tr.dataset.new) };
      if (tr.dataset.old != null) return { side: 'old', line: Number(tr.dataset.old) };
      return null;
    }
    if (tr.dataset.new != null) return { side: 'new', line: Number(tr.dataset.new) };
    if (tr.dataset.old != null) return { side: 'old', line: Number(tr.dataset.old) };
    return null;
  }

  document.addEventListener('mousemove', (e) => {
    // while the composer is open the pill stays out of the way entirely
    if (SENT || composerTr.isConnected) { hideHoverBar(); return; }
    const tr = e.target.closest('#content tr.row');
    if (!tr) {
      // the pill's own bridge/hit area keeps the current anchor alive
      if (!e.target.closest('#hoverBar')) hideHoverBar();
      return;
    }
    const pos = rowSideAt(tr, e);
    if (!pos) { hideHoverBar(); return; }
    if (hoverRow !== tr) {
      if (hoverRow) hoverRow.classList.remove('hb-hl');
      hoverRow = tr;
      tr.classList.add('hb-hl');
    }
    hoverPos = pos;
    const rect = tr.getBoundingClientRect();
    hoverBar.classList.add('show');
    const bw = hoverBar.offsetWidth;
    const bh = hoverBar.offsetHeight;
    const left = Math.min(Math.max(8, e.clientX - bw / 2), window.innerWidth - bw - 8);
    let top = rect.bottom + 4;
    if (top + bh > window.innerHeight - 8) top = rect.top - bh - 4; // flip above near the bottom
    hoverBar.style.left = Math.round(left) + 'px';
    hoverBar.style.top = Math.round(top) + 'px';
  });

  $('mainArea').addEventListener('scroll', hideHoverBar, { passive: true });

  document.addEventListener('click', (e) => {
    // quick-add pill: open the composer pre-set to the picked kind
    const quickBtn = e.target.closest('#hoverBar [data-quick]');
    if (quickBtn) {
      e.stopPropagation();
      if (hoverRow && hoverRow.isConnected && hoverPos && !SENT) {
        currentCat = quickBtn.dataset.quick;
        // keep a click/shift-click range if the hovered line belongs to it
        const inSel = sel && sel.file === curFile && sel.side === hoverPos.side &&
          hoverPos.line >= sel.start && hoverPos.line <= sel.end;
        sel = {
          file: curFile,
          side: hoverPos.side,
          start: inSel ? sel.start : hoverPos.line,
          end: inSel ? sel.end : hoverPos.line,
        };
        paintSelection(curFile);
        placeComposer(hoverRow);
      }
      hideHoverBar();
      return;
    }
    // inline edit of a remark body: ✎ swaps .thread-body for an editor
    const editStart = e.target.closest('[data-editstart]');
    if (editStart) {
      const id = editStart.dataset.editstart;
      const card = document.querySelector(`[data-thread="${id}"]`);
      const bodyEl = card && card.querySelector('.thread-body');
      const t = THREADS.find((x) => x.id === id);
      if (t && bodyEl) {
        bodyEl.outerHTML = threadEditHtml(id, t.body);
        const ta = card.querySelector('.edit-ta');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      return;
    }
    const editSave = e.target.closest('[data-editsave]');
    if (editSave) {
      saveThreadEdit(editSave.dataset.editsave);
      return;
    }
    const editCancel = e.target.closest('[data-editcancel]');
    if (editCancel) {
      renderAll(true); // re-render restores the untouched body
      return;
    }
    // inline delete confirmation: ✕ morphs into "Delete? ✓ ✗"
    const delStart = e.target.closest('[data-delstart]');
    if (delStart) {
      const zone = document.getElementById('dz-' + delStart.dataset.delstart);
      if (zone) {
        zone.innerHTML =
          `<span class="del-q">Delete?</span>` +
          `<button class="mini-btn yes" data-delyes="${delStart.dataset.delstart}">✓</button>` +
          `<button class="mini-btn" data-delno="${delStart.dataset.delstart}">✗</button>`;
      }
      return;
    }
    const delYes = e.target.closest('[data-delyes]');
    if (delYes) {
      deleteThread(delYes.dataset.delyes);
      return;
    }
    const delNo = e.target.closest('[data-delno]');
    if (delNo) {
      const zone = document.getElementById('dz-' + delNo.dataset.delno);
      if (zone) {
        zone.innerHTML = `<button class="icon-btn del-thread" data-delstart="${delNo.dataset.delno}" title="Delete">✕</button>`;
      }
      return;
    }
    // sidebar task checkbox (span) — plain toggle, human-controlled
    const taskBox = e.target.closest('span[data-task]');
    if (taskBox) {
      e.stopPropagation();
      const t = THREADS.find((x) => x.id === taskBox.dataset.task);
      if (t) toggleTask(t.id, t.status !== 'resolved');
      return;
    }
    // diff task checkbox
    const taskCb = e.target.closest('.task-cb[data-task]');
    if (taskCb) {
      const t = THREADS.find((x) => x.id === taskCb.dataset.task);
      if (t) toggleTask(t.id, t.status !== 'resolved');
      return;
    }
    const dirBtn = e.target.closest('[data-dir]');
    if (dirBtn) {
      const p = dirBtn.dataset.dir;
      if (collapsed.has(p)) collapsed.delete(p);
      else collapsed.add(p);
      $('tree').innerHTML = treeHtml(buildTree(), 0);
      return;
    }
    const fileBtn = e.target.closest('[data-file]');
    if (fileBtn) {
      curFile = Number(fileBtn.dataset.file);
      cancelComposer();
      renderAll(false);
      $('mainArea').scrollTop = 0;
      return;
    }
    const gotoBtn = e.target.closest('[data-goto]');
    if (gotoBtn) {
      jumpToThread(gotoBtn.dataset.goto);
      return;
    }
    const viewBtn = e.target.closest('#viewToggle');
    if (viewBtn) {
      viewMode = viewMode === 'split' ? 'unified' : 'split';
      store('xd-lite-view', viewMode);
      cancelComposer();
      renderMain();
      return;
    }
    const gapBtn = e.target.closest('[data-gap]');
    if (gapBtn) {
      const [fi, gi] = gapBtn.dataset.gap.split(':');
      expandGap(Number(fi), gi === 't' ? 't' : Number(gi));
      return;
    }
    const expandAllBtn = e.target.closest('[data-expandall]');
    if (expandAllBtn) {
      toggleAllGaps();
      return;
    }
    // line selection — click picks/extends the range; the composer only ever
    // opens from the hover pill's Task/Comment buttons, never from a click
    const tr = e.target.closest('#content tr.row');
    if (!tr || SENT) return;
    const pos = rowSideAt(tr, e);
    if (!pos) return;
    const { side, line } = pos;
    if (composerTr.isConnected) hideHoverBar(); // stay hidden while composing
    if (e.shiftKey && sel && sel.side === side && sel.file === curFile) {
      sel.start = Math.min(sel.start, line);
      sel.end = Math.max(sel.end, line);
    } else {
      sel = { file: curFile, side, start: line, end: line };
    }
    paintSelection(curFile);
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'sortSel') {
      sortKey = e.target.value;
      store('xd-lite-sort', sortKey);
      renderSidebar();
    }
  });

  document.addEventListener('keydown', (e) => {
    const editTa = e.target.closest && e.target.closest('.thread-edit .edit-ta');
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (editTa) {
        e.preventDefault();
        saveThreadEdit(editTa.dataset.editid);
      } else if (composerTr.isConnected) {
        e.preventDefault();
        submitComment();
      }
    } else if (e.key === 'Escape') {
      if (editTa) renderAll(true);
      else if (composerTr.isConnected) cancelComposer();
    }
  });

  $('themeToggle').addEventListener('click', toggleTheme);

  // -------------------------------------------------------- sidebar resizing

  function applySideWidth(w) {
    const clamped = Math.max(200, Math.min(560, Math.round(w) || 300));
    document.documentElement.style.setProperty('--side-w', clamped + 'px');
    return clamped;
  }

  (() => {
    const saved = Number(store('xd-lite-sideW'));
    if (saved) applySideWidth(saved);
    const handle = $('sideResize');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('resizing');
      const move = (ev) => {
        const w = applySideWidth(ev.clientX);
        handle.dataset.w = String(w);
      };
      const up = () => {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (handle.dataset.w) store('xd-lite-sideW', handle.dataset.w);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', () => {
      applySideWidth(300);
      store('xd-lite-sideW', '');
    });
  })();

  // ------------------------------------- panels: order (drag) + height (drag)

  (() => {
    const panels = $('sidePanels');
    const applySwap = (swapped) => {
      panels.classList.toggle('swapped', swapped);
      store('xd-lite-swap', swapped ? '1' : '0');
    };
    applySwap(store('xd-lite-swap') === '1');

    const applyTreeH = (pct) => {
      const clamped = Math.max(15, Math.min(85, Math.round(pct) || 50));
      document.documentElement.style.setProperty('--tree-h', clamped + '%');
      return clamped;
    };
    const savedPct = Number(store('xd-lite-treePct'));
    if (savedPct) applyTreeH(savedPct);

    // vertical divider between Comments and Files
    const handle = $('panelResize');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('resizing-v');
      const rect = panels.getBoundingClientRect();
      const move = (ev) => {
        const pct = panels.classList.contains('swapped')
          ? ((ev.clientY - rect.top) / rect.height) * 100
          : ((rect.bottom - ev.clientY) / rect.height) * 100;
        applyTreeH(pct);
      };
      const up = () => {
        document.body.classList.remove('resizing-v');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const cur = document.documentElement.style.getPropertyValue('--tree-h');
        if (cur) store('xd-lite-treePct', String(parseFloat(cur)));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // the panel follows the half of the sidebar its handle is dragged into
    document.querySelectorAll('[data-paneldrag]').forEach((h) => {
      h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const who = h.dataset.paneldrag;
        const rect = panels.getBoundingClientRect();
        const move = (ev) => {
          const upper = ev.clientY < rect.top + rect.height / 2;
          const commentsShouldBeTop = who === 'comments' ? upper : !upper;
          applySwap(!commentsShouldBeTop);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  })();

  // -------------------------------------------------------- send review / handoff

  function buildReviewMarkdown(agentMayResolve = true) {
    const open = THREADS.filter((t) => t.status !== 'resolved');
    const lines = [
      '# Code review feedback',
      '',
      `${open.length} open review thread(s).`,
      '',
      'How to act:',
      '- **request-changes (Task)** — fix the code, then resolve the thread if you actually fixed it.',
      '- **question** — answer in a reply (and fix code if the answer reveals a problem), then resolve.',
      '- **comment** — informational; reply briefly if useful and resolve.',
      '',
    ];
    if (!agentMayResolve) {
      lines.push(
        '> ❗ **The human resolves threads themselves.** Do NOT set threads to `resolved` —',
        '> no frontmatter edits, no resolve_thread calls. Fix the code, reply what you did,',
        '> and leave every thread open: the human will verify and resolve in the viewer.',
        '',
      );
    }
    for (const t of open) {
      lines.push('---', '');
      lines.push(`## [${t.category}] ${t.file}:${t.anchor.lines[0]}${t.anchor.side === 'old' ? ' (removed line)' : ''}`);
      lines.push(`thread file: .xd/threads/${t.id}.md`);
      lines.push('');
      lines.push(t.body);
      for (const r of t.replies ?? []) {
        lines.push('', `> **${r.author}:** ${r.body.replaceAll('\n', '\n> ')}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  async function sendReview() {
    if (SENT) return;
    const agentMayResolve = $('agentResolveChk').checked;
    if (WAIT_TOKEN) {
      try {
        await api('/api/handoff', 'POST', { token: WAIT_TOKEN, agentMayResolve });
        SENT = true;
        const btn = $('sendBtn');
        btn.textContent = 'Review sent ✓';
        btn.disabled = true;
        cancelComposer();
        document.querySelectorAll('[data-delstart]').forEach((b) => b.remove());
        toast(
          agentMayResolve
            ? 'Review sent — the agent will pick it up. You can close this tab.'
            : 'Review sent — the agent is told to leave threads open for you to resolve.'
        );
      } catch (err) {
        toast('Handoff failed: ' + err.message);
      }
    } else {
      try {
        await navigator.clipboard.writeText(buildReviewMarkdown(agentMayResolve));
        toast('No waiting agent (start with --wait). Review markdown copied to clipboard.');
      } catch {
        toast('Clipboard unavailable here — start the server with --wait to hand the review to the agent.');
      }
    }
  }

  $('sendBtn').addEventListener('click', sendReview);

  // ------------------------------------------------------------------- boot

  initTheme();
  viewMode = store('xd-lite-view') === 'split' ? 'split' : 'unified';
  const savedSort = store('xd-lite-sort');
  if (['file', 'status', 'time', 'type'].includes(savedSort)) sortKey = savedSort;
  $('sortSel').value = sortKey;

  // resolved remarks stay browsable unless the human hides them; and the
  // human can forbid the agent from resolving on their behalf (goes into
  // the REVIEW_FILE the agent reads after "Send review")
  showResolved = store('xd-lite-show-resolved') !== '0';
  $('showResolvedChk').checked = showResolved;
  $('showResolvedChk').addEventListener('change', (e) => {
    showResolved = e.target.checked;
    store('xd-lite-show-resolved', showResolved ? '1' : '0');
    renderSidebar();
  });
  $('agentResolveChk').checked = store('xd-lite-agent-resolve') !== '0';
  $('agentResolveChk').addEventListener('change', (e) => {
    store('xd-lite-agent-resolve', e.target.checked ? '1' : '0');
  });

  // ------------------------------------------------------- diff source switcher
  // "Iterations" of the content: working tree / staged / last commit / whole
  // branch, plus every commit on the branch — switchable in the header.
  let SRC_KEY = null;
  let SRC_ITEMS = [];
  let SRC_COMMITS = [];
  let SRC_COMMITS_LABEL = '';
  let SRC_BASE = null;

  function fillSrcSelect() {
    const opts = SRC_ITEMS.map((it) =>
      `<option value="${esc(it.key)}"${it.key === SRC_KEY ? ' selected' : ''}>${esc(it.label)}</option>`);
    if (SRC_COMMITS.length) {
      opts.push(`<optgroup label="${esc(SRC_COMMITS_LABEL)}">` + SRC_COMMITS.map((c) =>
        `<option value="commit:${esc(c.sha)}"${`commit:${c.sha}` === SRC_KEY ? ' selected' : ''}>${esc(c.short)} ${esc(c.subject)}</option>`
      ).join('') + '</optgroup>');
    }
    const selEl = $('srcSel');
    selEl.innerHTML = opts.join('');
    selEl.title = `Diff source: ${LABEL} — what changes are shown`;
  }

  async function loadDiff(srcKey) {
    const d = await api('/api/diff' + (srcKey ? '?src=' + encodeURIComponent(srcKey) : ''));
    LABEL = d.label;
    BRANCH = d.branch || '';
    EXPANDABLE = Boolean(d.expandable);
    FILES = parseDiff(d.text);
    curFile = FILES.length ? 0 : null;
    // ↑N only counts commits ahead of a known base — those are the PR contents
    const ahead = SRC_BASE ? SRC_COMMITS.length : 0;
    const bn = $('branchName');
    bn.textContent = (BRANCH || '(no branch)') + (ahead ? ` ↑${ahead}` : '');
    bn.title = ahead
      ? `${BRANCH} is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${SRC_BASE} — this is what the PR will contain`
      : 'current branch';
    $('loading').classList.add('hidden');
    renderAll(false);
    $('mainArea').scrollTop = 0;
  }

  async function setSource(srcKey) {
    if (srcKey === SRC_KEY) return;
    cancelComposer();
    $('loading').classList.remove('hidden');
    try {
      await loadDiff(srcKey);
      SRC_KEY = srcKey;
      store('xd-lite-src', srcKey);
    } catch (err) {
      toast('Could not load source: ' + err.message);
    }
    $('loading').classList.add('hidden');
    fillSrcSelect(); // restores the selection when a load failed
  }

  $('srcSel').addEventListener('change', (e) => setSource(e.target.value));

  const savedSrc = store('xd-lite-src') || '';
  Promise.all([api('/api/sources'), api('/api/threads')])
    .then(async ([s, t]) => {
      SRC_ITEMS = s.items;
      SRC_COMMITS = s.commits || [];
      SRC_COMMITS_LABEL = s.commitsLabel || 'Commits';
      SRC_BASE = s.base;
      THREADS = t.threads;
      const known = (k) => SRC_ITEMS.some((it) => it.key === k) ||
        SRC_COMMITS.some((c) => `commit:${c.sha}` === k);
      SRC_KEY = known(savedSrc) ? savedSrc : s.current;
      fillSrcSelect();
      await loadDiff(SRC_KEY);
    })
    .catch((err) => {
      $('loading').classList.add('hidden');
      showBanner('Failed to load: ' + err.message + '\n' + (err.stack || '').split('\n').slice(0, 5).join('\n'), 'error');
    });

  function showBanner(text, kind) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'banner ' + kind;
    b.classList.remove('hidden');
  }
}

const CLIENT_JS = `(${clientMain})();`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XD Lite — review</title>
<script>
(function(){try{var t=localStorage.getItem('xd-lite-theme');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}catch(e){}})();
</script>
<style>
:root {
  --bg: #ffffff; --bg-subtle: #f6f8fa; --bg-inset: #eff2f5;
  --border: #d8dee4; --border-subtle: #eaeef2;
  --fg: #1f2328; --fg-muted: #59636e; --fg-subtle: #8b949e;
  --accent: #0969da; --accent-hover: #0757af; --accent-fg: #ffffff;
  --add-bg: #e6ffec; --add-num-bg: #ccffd8; --add-fg: #1a7f37;
  --del-bg: #ffebe9; --del-num-bg: #ffc9c8; --del-fg: #cf222e;
  --sel-bg: #fff8c5; --card: #ffffff; --shadow: 0 1px 3px rgba(31,35,40,.08);
  --cat-task: #cf222e; --cat-comment: #57606a;
  --tk-cm: #6e7781; --tk-st: #0a3069; --tk-kw: #cf222e; --tk-nu: #0550ae; --tk-fn: #8250df; --tk-prop: #0550ae;
  --code-font: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --ui-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --side-w: 300px;
  --agent: #8250df; /* author chip: agents */
}
:root[data-theme='dark'] {
  --bg: #0d1117; --bg-subtle: #161b22; --bg-inset: #21262d;
  --border: #30363d; --border-subtle: #21262d;
  --fg: #e6edf3; --fg-muted: #8b949e; --fg-subtle: #6e7681;
  --accent: #58a6ff; --accent-hover: #79b8ff; --accent-fg: #0d1117;
  --add-bg: #12261e; --add-num-bg: #1b3427; --add-fg: #3fb950;
  --del-bg: #2d1517; --del-num-bg: #432024; --del-fg: #f85149;
  --sel-bg: #2d2a17; --card: #161b22; --shadow: 0 1px 3px rgba(0,0,0,.4);
  --cat-task: #f85149; --cat-comment: #8b949e;
  --agent: #d2a8ff;
  --tk-cm: #8b949e; --tk-st: #a5d6ff; --tk-kw: #ff7b72; --tk-nu: #79c0ff; --tk-fn: #d2a8ff; --tk-prop: #79c0ff;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
html, body { height: 100%; }
body {
  margin: 0; font-family: var(--ui-font); font-size: 13px; color: var(--fg);
  background: var(--bg); overflow: hidden;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
body.resizing { cursor: col-resize; user-select: none; }
::selection { background: var(--sel-bg); }
button { font-family: var(--ui-font); }
.flex { flex: 1; }
.hidden { display: none !important; }

.app { display: flex; height: 100vh; }

/* ------------------------------ sidebar ------------------------------ */
.sidebar {
  width: var(--side-w); flex: 0 0 var(--side-w);
  display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-subtle); border-right: 1px solid var(--border);
}
.side-resize {
  flex: 0 0 5px; cursor: col-resize; background: transparent;
  transition: background .15s; margin-left: -2px; margin-right: -2px; z-index: 15;
}
.side-resize:hover, body.resizing .side-resize {
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}
.side-head { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.head-line {
  display: flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 600; min-width: 0;
}
.hsep { color: var(--fg-subtle); font-weight: 400; }
.repo-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 42%;
}
.branch-name { color: var(--accent); white-space: nowrap; }
.head-stats { color: var(--fg-muted); white-space: nowrap; font-family: var(--code-font); font-size: 11.5px; }
.head-stats .sa { color: var(--add-fg); font-style: normal; }
.head-stats .sd { color: var(--del-fg); font-style: normal; }
.src-select {
  font-family: var(--ui-font); font-size: 11px; font-weight: 600; color: var(--accent);
  background: var(--card); border: 1px solid var(--border); border-radius: 99px;
  padding: 2px 6px; cursor: pointer;
  /* shrink with the sidebar instead of pushing the theme toggle out of the header */
  flex: 0 1 120px; min-width: 64px; max-width: 190px;
}
.src-select:hover { border-color: var(--accent); }
.src-select:focus { outline: none; border-color: var(--accent); }
.icon-btn {
  border: 1px solid var(--border); background: var(--card); color: var(--fg-muted);
  border-radius: 6px; width: 24px; height: 24px; cursor: pointer; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center; transition: color .15s, border-color .15s;
  flex: 0 0 auto;
}
.icon-btn:hover { color: var(--fg); border-color: var(--fg-subtle); }
.side-panels { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.side-panels.swapped { flex-direction: column-reverse; }
.panel { display: flex; flex-direction: column; min-height: 0; }
#panelComments { flex: 1 1 0; }
#panelTree { flex: 0 0 var(--tree-h, 50%); }
.panel-head {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle); flex: 0 0 auto;
}
.drag-handle { cursor: grab; color: var(--fg-subtle); font-size: 12px; padding: 0 2px; user-select: none; }
.drag-handle:active { cursor: grabbing; }
.panel-title { font-weight: 600; text-transform: uppercase; letter-spacing: .4px; font-size: 10px; }
.panel-count { font-family: var(--code-font); font-size: 10px; color: var(--fg-subtle); }
.panel-opt {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 10px; color: var(--fg-muted); white-space: nowrap; user-select: none;
}
.panel-opt input { accent-color: var(--accent); margin: 0; }
.panel-scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; }
#commentList { padding: 4px 6px; }
#tree { padding: 6px 6px 6px 0; }
.panel-resize {
  flex: 0 0 5px; cursor: row-resize; margin: -2px 0; z-index: 15;
  transition: background .15s;
  /* a visible 1px divider so the resize affordance can be discovered */
  background: linear-gradient(to bottom, transparent 2px, var(--border) 2px, var(--border) 3px, transparent 3px);
}
.panel-resize:hover, body.resizing-v .panel-resize {
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}
body.resizing-v { cursor: row-resize; user-select: none; }

.tree-row {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: none; background: none; color: var(--fg);
  font-size: 12px; text-align: left; cursor: pointer; border-radius: 6px;
  padding: 3px 8px 3px calc(10px + var(--depth, 0) * 14px);
  transition: background .12s;
}
.tree-row:hover { background: var(--bg-inset); }
.tree-row.file.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.tree-row .tw { color: var(--fg-subtle); font-size: 10px; width: 12px; flex: 0 0 12px; }
.tree-row .entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-row.dir { font-weight: 600; color: var(--fg-muted); }
.file-ico {
  flex: 0 0 15px; width: 15px; text-align: center; font-family: var(--code-font);
  font-size: 10px; font-weight: 700; border-radius: 4px;
}
.ico-A { color: var(--add-fg); } .ico-M { color: var(--accent); } .ico-D { color: var(--del-fg); }
.file-stats { margin-left: auto; display: inline-flex; gap: 4px; font-family: var(--code-font); font-size: 10px; }
.file-stats .sa { color: var(--add-fg); font-style: normal; }
.file-stats .sd { color: var(--del-fg); font-style: normal; }
.pill-count {
  background: var(--cat-comment); color: var(--bg); border-radius: 99px;
  font-size: 9px; padding: 1px 5px; font-weight: 700; flex: 0 0 auto;
}
.tree-empty { color: var(--fg-muted); font-size: 12px; padding: 12px; }

#sortSel {
  border: 1px solid var(--border); background: var(--card); color: var(--fg-muted);
  font-size: 11px; border-radius: 6px; padding: 2px 4px;
}
.c-item {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; transition: background .12s;
}
.c-item:hover { background: var(--bg-inset); }
.c-item.resolved { opacity: .55; }
.c-item.resolved .c-snip { text-decoration: line-through; }
.task-box {
  flex: 0 0 16px; width: 16px; height: 16px; margin-top: 1px;
  border: 1.5px solid var(--cat-task); border-radius: 4px; color: var(--cat-task);
  font-size: 11px; font-weight: 700; line-height: 13px; text-align: center;
  cursor: pointer; user-select: none;
}
.task-box.done { background: var(--cat-task); color: #fff; }
/* comment marker: a big filled dot — clearly not a button */
.c-ico {
  flex: 0 0 15px; width: 15px; height: 15px; margin-top: 2px;
  border-radius: 50%; background: var(--cat-comment);
}
.c-body { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.c-meta { font-size: 10px; color: var(--fg-muted); font-family: var(--code-font); }
.c-snip { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.side-foot { padding: 10px 12px 12px; border-top: 1px solid var(--border); }
.foot-opt {
  display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
  font-size: 11px; color: var(--fg-muted); margin-bottom: 8px;
}
.foot-opt input { accent-color: var(--accent); margin: 0; }
.foot-meta {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--fg-muted); margin-bottom: 7px;
}
.foot-meta .done { color: var(--add-fg); font-weight: 700; }
.foot-meta .open-t { color: var(--cat-task); font-weight: 600; }
.send-btn {
  width: 100%; border: none; background: var(--accent); color: var(--accent-fg);
  font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  box-shadow: var(--shadow); transition: background .15s;
}
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { opacity: .6; cursor: default; }

/* ------------------------------ main ------------------------------ */
.main { flex: 1 1 0; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; }
.banner { padding: 9px 14px; border-radius: 8px; margin: 12px 14px 0; font-size: 13px; white-space: pre-line; }
.banner.error { background: var(--del-bg); color: var(--del-fg); border: 1px solid var(--del-fg); }
.banner.ok { background: var(--add-bg); color: var(--add-fg); border: 1px solid var(--add-fg); }

.file-toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  background: var(--bg-subtle); border-bottom: 1px solid var(--border);
}
.toolbar-path { font-family: var(--code-font); font-size: 12px; font-weight: 600; }
.badge { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 99px; white-space: nowrap; }
.badge.add { color: var(--add-fg); background: color-mix(in srgb, var(--add-fg) 12%, transparent); }
.badge.del { color: var(--del-fg); background: color-mix(in srgb, var(--del-fg) 12%, transparent); }
.badge.type-badge { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }

#loading, .empty { text-align: center; color: var(--fg-muted); padding: 60px 0; font-size: 14px; }

.diff-scroll { overflow-x: auto; }
table.diff { width: 100%; border-collapse: collapse; font-family: var(--code-font); font-size: 12px; line-height: 1.55; tab-size: 4; }
tr.row { cursor: pointer; }
tr.row td.code { white-space: pre-wrap; word-break: break-word; }
td.num {
  width: 1%; min-width: 44px; padding: 0 8px; text-align: right; vertical-align: top;
  color: var(--fg-subtle); user-select: none; font-size: 11px;
}
td.code { padding: 0 12px; vertical-align: top; }
table.diff.split td.code-old, table.diff.split td.code-new { width: 50%; }
table.diff.split .code-old { border-right: 1px solid var(--border-subtle); }
tr.row:hover td:not(.num):not(.sel) { background: var(--bg-subtle); }
tr.row.add td.num-new { background: var(--add-num-bg); color: var(--add-fg); }
tr.row.add td.code { background: var(--add-bg); }
tr.row.del td.num-old { background: var(--del-num-bg); color: var(--del-fg); }
tr.row.del td.code { background: var(--del-bg); }
table.diff.split td.code-old.del { background: var(--del-bg); }
table.diff.split td.code-new.add { background: var(--add-bg); }
table.diff.split td.num-new.add { background: var(--add-num-bg); color: var(--add-fg); }
table.diff.split td.num-old.del { background: var(--del-num-bg); color: var(--del-fg); }
tr.row.sel td { background: var(--sel-bg) !important; }
tr.hunk-head td, tr.meta-row td { background: var(--bg-inset); }
tr.hunk-head td.code, tr.meta-row td.code { color: var(--fg-subtle); padding-top: 3px; padding-bottom: 3px; }
.gap-row td { background: var(--bg-subtle); border-top: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle); }
.gap-btn {
  border: none; background: none; color: var(--accent); cursor: pointer;
  font-size: 11px; font-family: var(--code-font); padding: 3px 12px;
}
.gap-btn:hover { text-decoration: underline; }
.tk-meta { color: var(--fg-subtle); }
.tk-cm { color: var(--tk-cm); font-style: italic; }
.tk-st { color: var(--tk-st); }
.tk-kw { color: var(--tk-kw); }
.tk-nu { color: var(--tk-nu); }
.tk-fn { color: var(--tk-fn); }
.tk-prop { color: var(--tk-prop); }

.widget-row td { padding: 0; }
.wcell { padding: 0; }
.wvoid { background: color-mix(in srgb, var(--bg-subtle) 55%, transparent); }
.thread {
  margin: 6px; padding: 10px 12px; border-radius: 8px;
  background: var(--card); border: 1px solid var(--border);
  box-shadow: var(--shadow);
  display: flex; gap: 12px; align-items: flex-start;
}
.thread.resolved { opacity: .55; }
.thread.flash { outline: 2px solid var(--accent); }
.task-cb {
  flex: 0 0 26px; width: 26px; height: 26px; border: 1px solid var(--cat-task); border-radius: 8px;
  color: transparent; font-size: 15px; font-weight: 800; line-height: 24px; text-align: center;
  cursor: pointer; user-select: none; transition: background .15s, color .15s;
  margin-top: 1px; /* stay on the first line as the comment grows */
}
.task-cb:hover { background: color-mix(in srgb, var(--cat-task) 12%, transparent); }
.task-cb.done { background: var(--cat-task); color: #fff; }
.t-main { flex: 1 1 0; min-width: 0; }
.t-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.t-author {
  display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 99px;
  font-size: 11px; font-weight: 600; letter-spacing: .1px; white-space: nowrap;
}
.chip-human { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.chip-agent { color: var(--agent); background: color-mix(in srgb, var(--agent) 12%, transparent); }
.t-time { font-size: 11px; color: var(--fg-subtle); }
.t-resolvedby { font-size: 10.5px; font-weight: 600; color: var(--add-fg); white-space: nowrap; }
.thread-body { font-size: 13px; line-height: 1.55; overflow-wrap: break-word; }
.thread-body code, .reply-body code { font-family: var(--code-font); font-size: 12px; background: var(--bg-inset); padding: 1px 4px; border-radius: 4px; }
.thread-body pre { background: var(--bg-inset); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px 10px; overflow-x: auto; margin: 6px 0; }
.thread-body pre code { background: none; padding: 0; }
/* replies read as a nested thread card: an inset, tinted block inside the
   remark — clearly the other party's answer, not part of the question */
.reply {
  margin-top: 8px; padding: 8px 10px;
  background: var(--bg-subtle); border: 1px solid var(--border-subtle); border-radius: 8px;
}
.reply-head { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.reply-body { font-size: 13px; line-height: 1.55; overflow-wrap: break-word; }
.thread-edit { margin-top: 2px; }
.thread-edit .composer-text { min-height: 54px; }
.del-zone { display: inline-flex; align-items: center; gap: 4px; }
.del-q { font-size: 11px; color: var(--del-fg); font-weight: 600; white-space: nowrap; }
.mini-btn {
  border: 1px solid var(--border); background: var(--card); color: var(--fg-muted);
  border-radius: 5px; width: 20px; height: 20px; cursor: pointer; font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.mini-btn.yes { color: var(--del-fg); border-color: var(--del-fg); }
.mini-btn.yes:hover { background: var(--del-bg); }
.mini-btn:hover { color: var(--fg); }
.thread .icon-btn { width: 20px; height: 20px; font-size: 11px; }

/* hover quick-add bar: appears under the hovered line at the cursor —
   the remark kind (Task/Comment) is picked before the click, not after */
.hover-bar {
  position: fixed; z-index: 60; display: inline-flex; gap: 2px; padding: 3px;
  background: var(--card); border: 1px solid var(--border); border-radius: 9px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .18);
  opacity: 0; transform: translateY(-3px) scale(.97); pointer-events: none;
  transition: opacity .1s ease, transform .1s ease;
}
.hover-bar.show { opacity: 1; transform: none; pointer-events: auto; }
/* invisible bridge over the 4px gap: the cursor can slide off the line into the
   pill without crossing into the next line (which would yank the pill away) */
.hover-bar::before { content: ''; position: absolute; left: 0; right: 0; top: -10px; height: 10px; }
/* keep the anchor line highlighted while its pill is up — CSS :hover drops as
   soon as the cursor leaves the row for the pill */
tr.row.hb-hl td:not(.num):not(.sel) { background: var(--bg-subtle); }
.hb-btn {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
  padding: 3px 10px; border: 0; border-radius: 6px; background: transparent;
  color: var(--fg-muted); cursor: pointer; white-space: nowrap;
}
.hb-btn:hover { background: var(--bg-inset); }
.hb-dot { width: 7px; height: 7px; border-radius: 50%; }
.hb-task { color: var(--cat-task); }
.hb-task .hb-dot { background: var(--cat-task); }
.hb-comment { color: var(--cat-comment); }
.hb-comment .hb-dot { background: var(--cat-comment); }
.composer-row td { padding: 0; }
.composer {
  margin: 6px; padding: 10px 12px; border-radius: 8px;
  background: var(--bg-subtle); border: 1px solid var(--accent);
}
.composer-text {
  width: 100%; min-height: 60px; resize: vertical;
  font-family: var(--ui-font); font-size: 13px; line-height: 1.5; color: var(--fg);
  background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
}
.composer-text:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.composer-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.hint { font-size: 11px; color: var(--fg-subtle); margin-right: 4px; }
.btn { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); transition: all .15s; }
.btn.ghost { background: var(--card); color: var(--fg-muted); }
.btn.ghost:hover { color: var(--fg); }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn.primary:hover { background: var(--accent-hover); }

.toast {
  position: fixed; right: 16px; bottom: 16px; z-index: 50; max-width: 420px;
  background: var(--fg); color: var(--bg); font-size: 12.5px; line-height: 1.45;
  padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; }
}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="side-head">
      <div class="head-line">
        <span class="repo-name" id="repoName" title="${'${REPO_PATH}'}">${'${REPO_NAME}'}</span>
        <span class="hsep">·</span>
        <span class="branch-name" id="branchName"></span>
        <span class="hsep">·</span>
        <span class="head-stats" id="stats"></span>
        <span class="flex"></span>
        <select id="srcSel" class="src-select" title="Diff source — what changes are shown"></select>
        <button id="themeToggle" class="icon-btn" title="Toggle theme">◐</button>
      </div>
    </div>
    <div class="side-panels" id="sidePanels">
      <section class="panel" id="panelComments">
        <div class="panel-head">
          <span class="drag-handle" data-paneldrag="comments" title="Drag to move panel">⠿</span>
          <span class="panel-title">Comments</span>
          <span class="panel-count" id="commentCount"></span>
          <span class="flex"></span>
          <label class="panel-opt" title="Resolved remarks stay in this list (greyed) so you can always revisit them">
            <input type="checkbox" id="showResolvedChk"> resolved
          </label>
          <select id="sortSel" data-sort title="Sort comments">
            <option value="file">by file</option>
            <option value="status">by status</option>
            <option value="time">by time</option>
            <option value="type">by type</option>
          </select>
        </div>
        <div class="panel-scroll" id="commentList"></div>
      </section>
      <div class="panel-resize" id="panelResize" title="Drag to resize panels"></div>
      <section class="panel" id="panelTree">
        <div class="panel-head">
          <span class="drag-handle" data-paneldrag="tree" title="Drag to move panel">⠿</span>
          <span class="panel-title">Files</span>
          <span class="flex"></span>
          <span class="panel-count" id="fileCount"></span>
        </div>
        <div class="panel-scroll" id="tree">
          <div class="tree-empty">Loading…</div>
        </div>
      </section>
    </div>
    <div class="side-foot">
      <label class="foot-opt" id="agentResolveOpt" title="When unchecked, the review file tells the agent to leave every thread open — you verify and resolve them yourself">
        <input type="checkbox" id="agentResolveChk"> agent may resolve remarks
      </label>
      <div class="foot-meta" id="footMeta"></div>
      <button id="sendBtn" class="send-btn">Send review to agent</button>
    </div>
  </aside>
  <div class="side-resize" id="sideResize" title="Drag to resize · double-click to reset"></div>
  <main class="main" id="mainArea">
    <div id="banner" class="banner hidden"></div>
    <div id="toolbar" class="file-toolbar"></div>
    <div id="loading">Loading diff…</div>
    <div id="content" class="diff-wrap"></div>
  </main>
</div>
<div id="toast" class="toast hidden"></div>
<div id="hoverBar" class="hover-bar">
  <button type="button" class="hb-btn hb-task" data-quick="task"><span class="hb-dot"></span>Task</button>
  <button type="button" class="hb-btn hb-comment" data-quick="comment"><span class="hb-dot"></span>Comment</button>
</div>
<script>
${'${CLIENT_SRC}'}
</script>
</body>
</html>
`;

// Client source is injected at serve time (kept out of the template above so the
// function source survives verbatim). Replacement functions avoid `$`-pattern
// substitution in the injected JS.
function renderPage(repoPath) {
  const base = repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath;
  const repoName = esc(base);
  const repoPathEsc = esc(repoPath);
  return PAGE.replace(/\$\{REPO_NAME\}/g, () => repoName)
    .replace(/\$\{REPO_PATH\}/g, () => repoPathEsc)
    .replace('${CLIENT_SRC}', () => CLIENT_JS);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ============================================================================
// HTTP server (node:http, localhost-only)
// ============================================================================

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function startLiteServer({ repoPath, port = 0, source, author }) {
  const store = createLiteStore(repoPath);
  await store.ensureExcluded();

  const handoffResolvers = new Map(); // token -> resolve
  const label = diffSourceLabel(source);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = renderPage(repoPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/sources') {
        const base = await detectBase(repoPath, source);
        let commits = await listCommits(repoPath, base);
        const n = commits.length;
        const items = [
          { key: 'working', label: 'Uncommitted · not in PR yet' },
          ...(await hasStaged(repoPath) ? [{ key: 'staged', label: 'Staged · next commit' }] : []),
          ...(base
            ? [
                { key: `vs:${base}`, label: `PR vs ${base} · ${n} commit${n === 1 ? '' : 's'}` },
                { key: `all:${base}`, label: `All changes vs ${base}` },
              ]
            : []),
          // 'head' stays a valid src key (CLI --source head) but the commits
          // list below already contains it as the newest entry
        ];
        // without a base (single-branch repo) there is no "branch vs base" —
        // recent history keeps the committed work browsable instead
        let commitsLabel;
        if (base) {
          commitsLabel = `Commits on branch (${n})`;
        } else {
          commits = await listRecentCommits(repoPath, 10);
          commitsLabel = `Recent commits (${commits.length})`;
        }
        sendJson(res, 200, {
          current: sourceKey(source),
          base,
          label,
          items,
          commits,
          commitsLabel,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/diff') {
        // ?src=<key> switches the source in-UI (working|staged|head|vs:<base>|commit:<sha>)
        const srcKey = url.searchParams.get('src');
        let effSource = source;
        let effLabel = label;
        if (srcKey != null) {
          const parsed = parseSourceKey(srcKey);
          if (!parsed) {
            sendJson(res, 400, { error: 'invalid src (working | staged | head | vs:<ref> | commit:<sha>)' });
            return;
          }
          effSource = parsed;
          effLabel = diffSourceLabel(parsed);
        }
        const branch = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
        let text;
        try {
          text = await getDiffText(repoPath, effSource);
        } catch (err) {
          if (err instanceof GitError) {
            sendJson(res, 400, { error: `unknown revision for src — ${err.message}` });
            return;
          }
          throw err;
        }
        sendJson(res, 200, {
          source: sourceKey(effSource),
          label: effLabel,
          text,
          branch,
          expandable: effSource.kind !== 'staged',
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/blob') {
        const p = url.searchParams.get('path') ?? '';
        const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
        const srcKey = url.searchParams.get('src');
        let blobSource = source;
        if (srcKey != null) {
          const parsed = parseSourceKey(srcKey);
          if (!parsed) {
            sendJson(res, 400, { error: 'invalid src' });
            return;
          }
          blobSource = parsed;
        }
        if (!p || p.includes('..') || path.isAbsolute(p)) {
          sendJson(res, 400, { error: 'invalid path' });
          return;
        }
        let blob = null;
        if (side === 'new') {
          blob = await worktreeBlob(repoPath, p);
        } else if (blobSource.kind === 'working') {
          blob = await gitBlob(repoPath, 'HEAD', p);
        } else if (blobSource.kind === 'vs') {
          // old side of the PR diff is the merge-base, matching base...HEAD
          const mb = await runGit(repoPath, ['merge-base', blobSource.base, 'HEAD']).catch(() => blobSource.base);
          blob = await gitBlob(repoPath, mb.trim().split('\n')[0], p);
        } else if (blobSource.kind === 'all') {
          // old side of "everything vs base" is the base itself
          blob = await gitBlob(repoPath, blobSource.base, p);
        } else if (blobSource.kind === 'commit') {
          const parent = await runGit(repoPath, ['rev-parse', `${blobSource.sha}^`]).catch(() => null);
          blob = parent ? await gitBlob(repoPath, parent, p) : { text: '' }; // root commit: all new
        }
        if (!blob) {
          sendJson(res, 404, { error: 'blob not found' });
          return;
        }
        sendJson(res, 200, blob);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/threads') {
        sendJson(res, 200, { threads: await store.list() });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/threads') {
        const body = await readJsonBody(req);
        const thread = await store.create({ ...body, author: body.author || author });
        sendJson(res, 201, thread);
        return;
      }
      const idMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (idMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(idMatch[1]);
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          // { body } edits the remark text; anything else toggles the task status
          const updated = typeof body?.body === 'string'
            ? await store.updateBody(id, body.body)
            : await store.setStatus(id, body.status, body.actor || author);
          sendJson(res, 200, updated);
        } else {
          try {
            await store.remove(id);
          } catch {
            sendJson(res, 404, { error: 'thread not found' });
            return;
          }
          sendJson(res, 200, { ok: true });
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/api/handoff') {
        const body = await readJsonBody(req);
        const resolve = typeof body?.token === 'string' && handoffResolvers.get(body.token);
        if (!resolve) {
          sendJson(res, 404, { error: 'unknown or already-used token' });
          return;
        }
        handoffResolvers.delete(body.token);
        // hand the human's resolution preference to the waiting CLI
        resolve({ agentMayResolve: body?.agentMayResolve !== false });
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, err.statusCode ?? 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    url,
    port: addr.port,
    label,
    store,
    waitForHandoff(token) {
      return new Promise((resolve) => handoffResolvers.set(token, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ============================================================================
// Browser opening (cross-platform, no npm deps)
// ============================================================================

function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    // rundll32 avoids cmd.exe parsing of '&' in query strings
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open manually: ${url}`));
    child.unref();
  } catch {
    console.log(`Open manually: ${url}`);
  }
}

// ============================================================================
// MCP server — stdio, newline-delimited JSON-RPC 2.0, zero dependencies.
// Lets coding agents read the diff and work with review threads as tools
// (the same role the full XD's MCP server plays for the complete app).
//   xd-lite mcp [path]     (path defaults to the process cwd)
// ============================================================================

/** Injected into every tool: target another repo without restarting the server. */
const MCP_REPO_PARAM = {
  repo: {
    type: 'string',
    description:
      'Absolute path to the target git repository. Optional: defaults to the workspace ' +
      '(ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR env) or the server cwd. Pass it explicitly ' +
      'when the workspace is not the repo you want to review.',
  },
};

const MCP_TOOLS = [
  {
    name: 'get_diff',
    description:
      'Unified diff of the repo (working tree by default, untracked files included). ' +
      'Returns plain unified-diff text — parse it yourself.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', enum: ['working', 'staged', 'head'], description: 'default working' } },
    },
  },
  {
    name: 'list_threads',
    description:
      'Review threads as markdown-file records. category request-changes = Task (human wants it fixed), ' +
      'comment = informational. Resolve a thread by setting its status via resolve_thread.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'default all' } },
    },
  },
  {
    name: 'get_thread',
    description: 'One review thread with its replies.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'add_comment',
    description:
      'Create a review thread on file lines (new-side numbering; side:"old" for removed lines). ' +
      'category request-changes shows up as a Task for you in the review window.',
    inputSchema: {
      type: 'object',
      required: ['file', 'lines', 'body'],
      properties: {
        file: { type: 'string', description: 'repo-relative path' },
        lines: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[start, end]' },
        side: { type: 'string', enum: ['old', 'new'] },
        category: { type: 'string', enum: ['request-changes', 'comment'] },
        body: { type: 'string' },
        author: { type: 'string' },
      },
    },
  },
  {
    name: 'reply_thread',
    description: 'Append a reply to a review thread (what you did / answer).',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: { id: { type: 'string' }, body: { type: 'string' }, author: { type: 'string' } },
    },
  },
  {
    name: 'resolve_thread',
    description:
      'Resolve (status resolved — ticks the Task checkbox) or reopen a thread. ' +
      'Resolve only after the requested change is actually done.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'open'], description: 'default resolved' },
        actor: { type: 'string' },
      },
    },
  },
];

async function runMcp({ repoPath = null, source, author }) {
  // The server must start even when the cwd is not a git repository (ZCode
  // launches it with its workspace dir, which may be project-less). The repo
  // is resolved per tool call: explicit `repo` arg → env → server arg → cwd.
  const envRepo = [process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.env.XD_LITE_REPO].find(
    (v) => v && v.length > 0
  );
  const storeCache = new Map();
  async function resolveRepo(a = {}) {
    const candidate = a.repo ?? repoPath ?? envRepo ?? process.cwd();
    let root = null;
    try {
      root = await runGit(candidate, ['rev-parse', '--show-toplevel']);
    } catch {}
    if (!root) {
      throw new Error(
        `Not a git repository: ${candidate}. Pass the "repo" parameter (absolute path to the repo) ` +
          `or open that repo as the workspace.`
      );
    }
    if (!storeCache.has(root)) storeCache.set(root, createLiteStore(root));
    return { root, store: storeCache.get(root) };
  }

  const handlers = {
    get_diff: async (a = {}) => {
      const { root } = await resolveRepo(a);
      const src =
        a.source === 'staged' ? { kind: 'staged' } : a.source === 'head' ? { kind: 'head' } : { kind: 'working' };
      const text = (await getDiffText(root, src)) || '(no changes)';
      return { content: [{ type: 'text', text }] };
    },
    list_threads: async (a = {}) => {
      const { root, store } = await resolveRepo(a);
      await store.ensureExcluded();
      const st = a.status ?? 'all';
      const list = (await store.list()).filter((t) => st === 'all' || t.status === st);
      return { content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 2) : '(no threads)' }] };
    },
    get_thread: async (a = {}) => {
      const { root } = await resolveRepo(a);
      const raw = await readFile(threadPath(root, String(a.id)), 'utf8');
      const thread = parseThread(raw, path.basename(String(a.id)));
      return { content: [{ type: 'text', text: JSON.stringify(thread, null, 2) }] };
    },
    add_comment: async (a = {}) => {
      const { store } = await resolveRepo(a);
      const thread = await store.create({ ...a, side: a.side, author: a.author || author });
      return {
        content: [
          {
            type: 'text',
            text:
              `Created ${thread.category} thread ${thread.id} on ${thread.file}:${thread.anchor.lines[0]}.\n` +
              `The human sees it in the XD Lite review window; resolve via resolve_thread when done.`,
          },
        ],
      };
    },
    reply_thread: async (a = {}) => {
      const { store } = await resolveRepo(a);
      const thread = await store.reply(String(a.id), { body: a.body, author: a.author || 'agent:mcp' });
      return { content: [{ type: 'text', text: `Reply added to thread ${thread.id}.` }] };
    },
    resolve_thread: async (a = {}) => {
      const { store } = await resolveRepo(a);
      const thread = await store.setStatus(String(a.id), a.status ?? 'resolved', a.actor || 'agent:mcp');
      return {
        content: [
          {
            type: 'text',
            text:
              `Thread ${thread.id} is now ${thread.status}.` +
              (thread.status === 'resolved' ? ' The Task checkbox in the review window is ticked.' : ''),
          },
        ],
      };
    },
  };

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // tolerate garbage lines
    }
    if (!msg.id) continue; // notification (notifications/initialized etc.) — no response
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'xd-lite', title: 'XD Lite', version: VERSION },
        },
      });
    } else if (msg.method === 'tools/list') {
      const tools = MCP_TOOLS.map((t) => ({
        ...t,
        inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema?.properties ?? {}), ...MCP_REPO_PARAM } },
      }));
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params ?? {};
      const handler = handlers[name];
      if (!handler) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
        continue;
      }
      try {
        send({ jsonrpc: '2.0', id: msg.id, result: await handler(args ?? {}) });
      } catch (err) {
        // tool errors are results with isError, not protocol errors
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        });
      }
    } else if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}

// ============================================================================
// Main
// ============================================================================

function genToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.has('--help') || flags.has('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const repoArg = positionals[0] ?? process.cwd();

  // MCP stdio server for coding agents (no http server, no browser).
  // Starts even outside a git repository — tools resolve the repo per call
  // (repo arg / env / cwd), so a project-less workspace still gets the tools.
  if (repoArg === 'mcp') {
    const mcpRepo = path.resolve(positionals[1] ?? process.cwd());
    let mcpRoot = null;
    try {
      mcpRoot = await runGit(mcpRepo, ['rev-parse', '--show-toplevel']);
    } catch {
      console.error(`[xd-lite] cwd is not a git repository (${mcpRepo}) — pass "repo" in tool calls.`);
    }
    await runMcp({
      repoPath: mcpRoot,
      author: (flags.get('--author') || '').trim() || undefined,
    });
    process.exit(0); // stdin closed — the client shut the server down
  }

  const repoPath = path.resolve(repoArg);

  // resolve to the repo root up front; gives a clear error outside git repos
  let root;
  try {
    root = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
  } catch {
    console.error(`xd-lite: ${repoPath} is not a git repository`);
    process.exit(1);
  }

  let source;
  try {
    source = resolveSource(flags);
  } catch (err) {
    console.error(`xd-lite: ${err.message}`);
    process.exit(1);
  }

  const author = (flags.get('--author') || '').trim() || undefined;

  // fail fast on a bad --vs ref before opening anything
  try {
    await getDiffText(root, source);
  } catch (err) {
    console.error(`xd-lite: ${err.message}`);
    process.exit(1);
  }

  const { url, waitForHandoff, store, label } = await startLiteServer({
    repoPath: root,
    port: Number(flags.get('--port') ?? 0),
    source,
    author,
  });

  console.log(`XD Lite → ${url}`);
  console.log(`Repo:      ${root}`);
  console.log(`Diff:      ${label}`);

  if (flags.has('--wait')) {
    const token = genToken();
    const urlWithToken = `${url}/?wait=${token}`;
    console.log('Waiting for review… click "Send review to agent" in the browser.');
    console.log(`Window:    ${urlWithToken}`);
    if (!flags.has('--no-open')) openBrowser(urlWithToken);

    // wait for the click, or bail out after --timeout minutes (hook safety)
    const timeoutMin = Number.parseFloat(flags.get('--timeout') ?? '');
    let timedOut = false;
    let handoff = null; // { agentMayResolve } — the human's resolution preference
    if (Number.isFinite(timeoutMin) && timeoutMin > 0) {
      const winner = await Promise.race([
        waitForHandoff(token).then((h) => ({ kind: 'sent', handoff: h })),
        new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), timeoutMin * 60_000)),
      ]);
      timedOut = winner.kind === 'timeout';
      handoff = winner.handoff ?? null;
    } else {
      handoff = await waitForHandoff(token);
    }
    if (timedOut) {
      console.log(`Timed out after ${timeoutMin} min — collecting current threads.`);
    }

    const threads = (await store.list()).filter((t) => t.status === 'open');
    const outPath = path.resolve(
      flags.get('--out') ?? path.join(root, XD_DIR, `review-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
    );
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, renderHandoff(root, threads, handoff ?? undefined), 'utf8');
    if (handoff && !handoff.agentMayResolve) {
      console.log('Note: the human wants to resolve threads themselves — do not resolve, only reply.');
    }

    console.log(timedOut ? 'Wait timed out — review collected as-is.' : 'Review received.');
    console.log(`REVIEW_FILE=${outPath}`);
    if (flags.has('--fail-on-open') && threads.length > 0) {
      // PreToolUse-hook contract: exit 2 blocks the wrapped command (e.g. git push)
      // and shows stderr to the agent, which then reads the review file.
      console.error(`xd-lite: ${threads.length} open review thread(s) — command blocked.`);
      console.error(`REVIEW_FILE=${outPath}`);
      process.exit(2);
    }
    // exit immediately — same rationale as the full xd CLI
    process.exit(0);
  }

  console.log('Press Ctrl+C to stop.');
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct-run detection. Global installs run the bin through a symlink, so the
// argv path must be resolved to the real file before comparing (node resolves
// module URLs through symlinks by default).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  main().catch((err) => {
    console.error(`xd-lite: ${err.message}`);
    process.exit(1);
  });
}

export {
  GitError,
  createLiteStore,
  diffSourceLabel,
  fileBlobSha,
  genId,
  getDiffText,
  parseThread,
  renderHandoff,
  renderPage,
  resolveSource,
  runGit,
  serializeThread,
  startLiteServer,
  validateCreateInput,
};
