import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Cross-compat check: the full XD store must read what lite writes (and vice versa).
// Cross-format check against the full XD store. In the XD monorepo @xd/core is
// a workspace package (built by the test script); in this standalone repo it is
// absent and the cross-format tests skip automatically.
let ThreadStore = null;
try { ({ ThreadStore } = await import('@xd/core')); } catch {}
const hasCore = Boolean(ThreadStore);
import {
  createLiteStore,
  getDiffText,
  parseThread,
  renderHandoff,
  resolveSource,
  serializeThread,
  startLiteServer,
  validateCreateInput,
} from '../xd-lite.js';

/** Isolated temp git repo with one commit, one modification and one untracked file. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'xd-lite-test-'));
  const gitconfig = path.join(dir, 'gitconfig');
  writeFileSync(
    gitconfig,
    '[user]\n\tname = tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n'
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: path.join(dir, 'gitconfig-system'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: dir,
    USERPROFILE: dir,
  };
  const git = (args) => execSync(`git ${args}`, { cwd: dir, env, stdio: 'pipe' });
  git('init');
  writeFileSync(path.join(dir, 'a.txt'), 'line one\nline two\nline three\n');
  git('add .');
  git('commit -m init');
  writeFileSync(path.join(dir, 'a.txt'), 'line one\nchanged two\nline three\nline four\n');
  writeFileSync(path.join(dir, 'new.py'), 'def greet():\n    print("hi")\n');
  return dir;
}

test('resolveSource parses CLI source flags', () => {
  assert.deepEqual(resolveSource(new Map()), { kind: 'working' });
  assert.deepEqual(resolveSource(new Map([['--vs', 'origin/main']])), { kind: 'vs', base: 'origin/main' });
  assert.deepEqual(resolveSource(new Map([['--source', 'staged']])), { kind: 'staged' });
  assert.deepEqual(resolveSource(new Map([['--source', 'head']])), { kind: 'head' });
  assert.throws(() => resolveSource(new Map([['--source', 'bogus']])));
});

test('getDiffText includes modified and untracked files', async () => {
  const dir = makeRepo();
  const text = await getDiffText(dir, { kind: 'working' });
  assert.match(text, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(text, /\+changed two/);
  assert.match(text, /new file mode 100644/);
  assert.match(text, /\+\+\+ b\/new\.py/);
  assert.match(text, /\+def greet\(\):/);
});

test('validateCreateInput rules', () => {
  assert.equal(validateCreateInput({ file: 'a.txt', lines: [1, 2], category: 'comment', body: 'x' }), null);
  assert.match(validateCreateInput({ file: '../x', lines: [1, 1], category: 'comment', body: 'x' }), /invalid file/);
  assert.match(validateCreateInput({ file: '/etc/passwd', lines: [1, 1], category: 'comment', body: 'x' }), /invalid file/);
  assert.match(validateCreateInput({ file: 'a.txt', lines: [0, 1], category: 'comment', body: 'x' }), /invalid lines/);
  assert.match(validateCreateInput({ file: 'a.txt', lines: [1, 1], category: 'nope', body: 'x' }), /invalid category/);
  assert.match(validateCreateInput({ file: 'a.txt', lines: [1, 1], category: 'comment', body: '  ' }), /empty body/);
});

test('ensureExcluded adds .xd/ to git info/exclude exactly once', async () => {
  const dir = makeRepo();
  const store = createLiteStore(dir);
  await store.ensureExcluded();
  await store.ensureExcluded();
  const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l.trim() === '.xd/').length, 1);
});

test('serialize/parse roundtrip keeps fields, hr-in-body and reply blocks', () => {
  const t = {
    id: '01ABCD',
    file: 'src/x.ts',
    status: 'open',
    category: 'question',
    author: 'human:me',
    createdAt: '2026-11-18T10:00:00.000Z',
    anchor: { ref: 'working', blobSha: 'a'.repeat(40), lines: [4, 6] },
    body: 'What about **this**?\n\n---\n\nhr stays',
    replies: [{ author: 'agent:y', at: '2026-11-18T11:00:00.000Z', body: 'Fine' }],
  };
  const raw = serializeThread(t);
  assert.ok(raw.includes("author: 'human:me'"), 'author with colon must be quoted');
  assert.ok(raw.includes('    - 4\n    - 6'));
  const back = parseThread(raw, '01ABCD.md');
  assert.equal(back.id, '01ABCD');
  assert.equal(back.file, 'src/x.ts');
  assert.equal(back.category, 'question');
  assert.equal(back.author, 'human:me');
  assert.equal(back.createdAt, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(back.anchor, { ref: 'working', blobSha: 'a'.repeat(40), lines: [4, 6], side: 'new' });
  assert.equal(back.body, t.body, 'a bare --- hr must not be mistaken for a reply separator');
  assert.equal(back.replies.length, 1);
  assert.equal(back.replies[0].author, 'agent:y');
  assert.equal(back.replies[0].body, 'Fine');
});

test('lite-created thread files are read by the full @xd/core store', { skip: hasCore ? false : '@xd/core not available (standalone checkout)' }, async () => {
  const dir = makeRepo();
  const store = createLiteStore(dir);
  await store.ensureExcluded();
  const thread = await store.create({
    file: 'a.txt',
    lines: [2, 3],
    category: 'request-changes',
    body: 'Fix this please',
  });
  assert.match(thread.id, /^[0-9A-Z]{26}$/);
  const filePath = path.join(dir, '.xd', 'threads', `${thread.id}.md`);
  assert.ok(existsSync(filePath));
  const raw = readFileSync(filePath, 'utf8');
  assert.ok(raw.includes('status: open'));
  assert.ok(raw.includes('category: request-changes'));
  assert.ok(raw.includes('blob_sha: '));

  const coreStore = new ThreadStore(dir);
  const found = (await coreStore.list()).find((t) => t.id === thread.id);
  assert.ok(found, 'core ThreadStore must see the lite-created thread');
  assert.equal(found.file, 'a.txt');
  assert.equal(found.category, 'request-changes');
  assert.equal(found.author, 'human:me');
  assert.equal(found.status, 'open');
  assert.equal(found.body, 'Fix this please');
  assert.deepEqual(found.anchor.lines, [2, 3]);
  assert.equal(found.outdated, false);

  // agent-side reply via the core store must be visible to lite's parser
  await coreStore.reply(thread.id, { author: 'agent:test', body: 'Fixed in a follow-up' });
  const withReply = (await store.list()).find((t) => t.id === thread.id);
  assert.equal(withReply.replies.length, 1);
  assert.equal(withReply.replies[0].author, 'agent:test');
  assert.equal(withReply.replies[0].body, 'Fixed in a follow-up');
});

test('lite server: health, diff, threads CRUD and handoff end-to-end', { skip: hasCore ? false : '@xd/core not available (standalone checkout)' }, async () => {
  const dir = makeRepo();
  const { url, port, waitForHandoff, close } = await startLiteServer({
    repoPath: dir,
    port: 0,
    source: { kind: 'working' },
  });
  try {
    assert.ok(port > 0);
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true });

    const diff = await (await fetch(`${url}/api/diff`)).json();
    assert.equal(diff.label, 'Working tree');
    assert.match(diff.text, /a\.txt/);
    assert.match(diff.text, /new\.py/);
    assert.equal(diff.branch, 'main', 'current branch exposed for the header');
    assert.equal(diff.expandable, true, 'working mode supports context expansion');

    // blob endpoint for context expansion: new = worktree, old = HEAD
    const blobNew = await (await fetch(`${url}/api/blob?path=a.txt&side=new`)).json();
    assert.match(blobNew.text, /changed two/);
    const blobOld = await (await fetch(`${url}/api/blob?path=a.txt&side=old`)).json();
    assert.match(blobOld.text, /line two/);
    assert.doesNotMatch(blobOld.text, /changed two/);
    assert.equal((await fetch(`${url}/api/blob?path=missing.txt&side=new`)).status, 404);
    assert.equal((await fetch(`${url}/api/blob?path=../etc%2Fpasswd&side=new`)).status, 400);

    assert.equal((await (await fetch(`${url}/api/threads`)).json()).threads.length, 0);

    const created = await fetch(`${url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'new.py', lines: [1, 1], category: 'question', body: 'Why **print** here?' }),
    });
    assert.equal(created.status, 201);
    const thread = await created.json();
    assert.equal(thread.author, 'human:me');
    assert.equal((await (await fetch(`${url}/api/threads`)).json()).threads.length, 1);

    const badPath = await fetch(`${url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '../etc/passwd', lines: [1, 1], category: 'comment', body: 'x' }),
    });
    assert.equal(badPath.status, 400);
    const badCat = await fetch(`${url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'a.txt', lines: [1, 1], category: 'nitpick', body: 'x' }),
    });
    assert.equal(badCat.status, 400);

    // task checkbox: PATCH status open → resolved → open
    const patched = await fetch(`${url}/api/threads/${thread.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).status, 'resolved');
    const listed = (await (await fetch(`${url}/api/threads`)).json()).threads;
    assert.equal(listed[0].status, 'resolved');
    assert.ok(listed[0].resolvedAt, 'resolved_at recorded');
    const badPatch = await fetch(`${url}/api/threads/${thread.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    });
    assert.equal(badPatch.status, 400);

    // the full @xd/core store sees the PATCHed status too
    const coreFound = (await new ThreadStore(dir).list()).find((t) => t.id === thread.id);
    assert.equal(coreFound.status, 'resolved');

    assert.equal((await fetch(`${url}/api/threads/${thread.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(`${url}/api/threads`)).json()).threads.length, 0);
    assert.equal((await fetch(`${url}/api/threads/${thread.id}`, { method: 'DELETE' })).status, 404);

    const pending = waitForHandoff('tok123');
    const handoff = await fetch(`${url}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok123' }),
    });
    assert.deepEqual(await handoff.json(), { ok: true });
    await pending;
    assert.equal(
      (
        await fetch(`${url}/api/handoff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'tok123' }),
        })
      ).status,
      404,
      'token must be one-shot'
    );

    const page = await (await fetch(`${url}/`)).text();
    assert.match(page, /<title>XD Lite/);
    assert.match(page, /Send review/);
    assert.match(page, /tk-kw/, 'client css for syntax tokens is inlined');
    assert.match(page, /composer/, 'client js for the composer is inlined');
    assert.match(page, /data-file=/, 'file tree renderer inlined');
    assert.match(page, /data-view="split"/, 'split-view toggle inlined');
    assert.match(page, /data-task=/, 'task checkbox rendering inlined');
    assert.match(page, /data-sort/, 'comment sorting selector inlined');
    assert.match(page, /sideResize/, 'sidebar resize handle inlined');
    assert.match(page, /gap-btn/, 'context expansion renderer inlined');
    assert.match(page, /anchor\.side/, 'old-side anchoring logic inlined');
  } finally {
    await close();
  }
});

test('old-side anchors: side round-trips in the format and the full store ignores it', { skip: hasCore ? false : '@xd/core not available (standalone checkout)' }, async () => {
  const dir = makeRepo();
  const store = createLiteStore(dir);
  await store.ensureExcluded();
  const t = await store.create({
    file: 'a.txt',
    lines: [2, 2],
    side: 'old',
    category: 'comment',
    body: 'This line was removed — comment stays on the left half',
  });
  assert.equal(t.anchor.side, 'old');
  const raw = readFileSync(path.join(dir, '.xd', 'threads', `${t.id}.md`), 'utf8');
  assert.match(raw, /  side: old/, 'old side persisted in the frontmatter');
  // the full @xd/core store parses the file fine (zod strips the unknown `side` key)
  const viaCore = (await new ThreadStore(dir).list()).find((x) => x.id === t.id);
  assert.ok(viaCore, 'core store must parse a lite old-side thread');
  assert.equal(viaCore.category, 'comment');
  assert.deepEqual(viaCore.anchor.lines, [2, 2]);
  // new-side threads keep the classic shape (no side key written)
  const t2 = await store.create({ file: 'a.txt', lines: [1, 1], category: 'comment', body: 'x' });
  const raw2 = readFileSync(path.join(dir, '.xd', 'threads', `${t2.id}.md`), 'utf8');
  assert.doesNotMatch(raw2, /side:/);
});

test('task checkbox state round-trips through the shared thread format', { skip: hasCore ? false : '@xd/core not available (standalone checkout)' }, async () => {
  const dir = makeRepo();
  const store = createLiteStore(dir);
  await store.ensureExcluded();
  const task = await store.create({
    file: 'a.txt',
    lines: [2, 2],
    category: 'request-changes',
    body: 'Fix the thing',
  });
  const resolved = await store.setStatus(task.id, 'resolved');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedAt);
  const raw = readFileSync(path.join(dir, '.xd', 'threads', `${task.id}.md`), 'utf8');
  assert.match(raw, /status: resolved/);
  assert.match(raw, /resolved_by: /);
  const reopened = await store.setStatus(task.id, 'open');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolvedBy, undefined);
  const raw2 = readFileSync(path.join(dir, '.xd', 'threads', `${task.id}.md`), 'utf8');
  assert.match(raw2, /status: open/);
  assert.doesNotMatch(raw2, /resolved_by:/);
  // core-compatible at every step
  const viaCore = (await new ThreadStore(dir).list()).find((t) => t.id === task.id);
  assert.equal(viaCore.status, 'open');
  assert.equal(viaCore.category, 'request-changes');
});

test('renderHandoff emits the REVIEW_FILE markdown contract', () => {
  const md = renderHandoff('/repo', [
    {
      id: '01TEST',
      file: 'a.txt',
      category: 'request-changes',
      anchor: { lines: [2, 3] },
      body: 'Fix this',
      replies: [{ author: 'agent:x', body: 'done' }],
    },
  ]);
  assert.match(md, /# Code review feedback/);
  assert.match(md, /## \[request-changes\] a\.txt:2/);
  assert.match(md, /thread file: .*\.xd[\\/]threads[\\/]01TEST\.md/);
  assert.match(md, /> \*\*agent:x:\*\* done/);
  assert.match(md, /request-changes \(Task\)\*\* — fix the code/);
  assert.match(md, /plain toggle/);
});

// ---- CLI spawn tests: the contract other harnesses rely on -----------------

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'xd-lite.js');

function spawnCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('CLI --wait --timeout collects threads without any click', async () => {
  const dir = makeRepo();
  const store = createLiteStore(dir);
  await store.ensureExcluded();
  await store.create({ file: 'a.txt', lines: [1, 1], category: 'comment', body: 'please look at this' });
  const outPath = path.join(dir, 'review-out.md');
  const { code, out } = await spawnCli(
    ['.', '--wait', '--timeout', '0.05', '--no-open', '--out', outPath],
    dir
  );
  assert.equal(code, 0, `expected exit 0, stdout: ${out}`);
  assert.match(out, /Timed out after 0\.05 min/);
  assert.match(out, /REVIEW_FILE=/);
  assert.ok(existsSync(outPath));
  assert.match(readFileSync(outPath, 'utf8'), /please look at this/);
}, 30000);

test('CLI --wait --fail-on-open exits 2 with open tasks and 0 when handled', async () => {
  const dir = makeRepo();
  const outPath = path.join(dir, 'review-out.md');
  const child = spawn(
    process.execPath,
    [CLI, '.', '--wait', '--fail-on-open', '--no-open', '--out', outPath],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  // stdout arrives in chunks: the URL line and the Window/token line may land in
  // different chunks — wait until BOTH are seen before talking to the server.
  const { baseUrl, token } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no url/token in stdout: ${out}`)), 15000);
    child.stdout.on('data', (c) => {
      out += c.toString();
      const u = out.match(/XD Lite → (http:\/\/127\.0\.0\.1:\d+)/);
      const t = out.match(/Window:\s+\S+wait=([A-Za-z0-9]+)/);
      if (u && t) { clearTimeout(timer); resolve({ baseUrl: u[1], token: t[1] }); }
    });
  });
  assert.ok(token, 'wait token printed for the window');
  const post = (body) =>
    fetch(`${baseUrl}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  // 1) leave a task open → Send review → exit 2 (hook blocks the command)
  await post({ file: 'a.txt', lines: [1, 1], category: 'request-changes', body: 'fix me' });
  const sent = await fetch(`${baseUrl}/api/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.deepEqual(await sent.json(), { ok: true });
  const code2 = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code2, 2, 'open tasks must block (exit 2)');
  assert.match(readFileSync(outPath, 'utf8'), /fix me/);

  // 2) same flag, no open threads → resolve the handoff via API → exit 0
  const cleanup = createLiteStore(dir);
  for (const t of await cleanup.list()) await cleanup.remove(t.id);
  const child2 = spawn(
    process.execPath,
    [CLI, '.', '--wait', '--fail-on-open', '--no-open', '--out', path.join(dir, 'review-out2.md')],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out2 = '';
  child2.stdout.on('data', (c) => { out2 += c.toString(); });
  const token2 = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no token in stdout: ${out2}`)), 15000);
    child2.stdout.on('data', (c) => {
      out2 += c.toString();
      const m = out2.match(/Window:\s+\S+wait=([A-Za-z0-9]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  const url2 = out2.match(/XD Lite → (http:\/\/127\.0\.0\.1:\d+)/)[1];
  await fetch(`${url2}/api/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token2 }),
  });
  const code0 = await new Promise((resolve) => child2.on('close', resolve));
  assert.equal(code0, 0, 'no open threads must not block');
}, 45000);
