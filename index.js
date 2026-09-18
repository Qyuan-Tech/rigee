import { ipcMain, WebContentsView, app, MessageChannelMain, BaseWindow, shell, dialog } from "electron";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stat, readFile, writeFile, unlink } from "node:fs/promises";
import watcher from "@parcel/watcher";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${channel}: ${message}`);
    }
  });
}
function emit(wc, channel, payload) {
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}
const PARTITION = "persist:onestop-browser";
class BrowserTabs {
  constructor(window2, shell2) {
    this.window = window2;
    this.shell = shell2;
  }
  window;
  shell;
  views = /* @__PURE__ */ new Map();
  seq = 0;
  create(url, bounds) {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // Hidden tabs must keep loading and running timers, otherwise switching back shows a
        // frozen page that only catches up seconds later.
        backgroundThrottling: false
      }
    });
    return this.register(view, bounds, url);
  }
  register(view, bounds, url) {
    const id = `view${++this.seq}`;
    this.window.contentView.addChildView(view);
    view.setBounds(bounds);
    view.setVisible(false);
    const entry = { id, view, bounds, visible: false };
    this.views.set(id, entry);
    this.wire(entry);
    if (url !== null) void view.webContents.loadURL(url).catch(() => {
    });
    return id;
  }
  wire(entry) {
    const wc = entry.view.webContents;
    const push2 = () => {
      emit(this.shell(), "browser:state", {
        viewId: entry.id,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        faviconDataUrl: null
      });
    };
    wc.on("page-title-updated", push2);
    wc.on("did-start-loading", push2);
    wc.on("did-stop-loading", push2);
    wc.on("did-navigate", push2);
    wc.on("did-navigate-in-page", push2);
    wc.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      emit(this.shell(), "app:error", {
        scope: "browser",
        message: `${desc} (${code}) while loading ${failedUrl}`
      });
      push2();
    });
    wc.setWindowOpenHandler((details) => ({
      action: "allow",
      outlivesOpener: true,
      createWindow: (options) => {
        const guest = options.webContents;
        if (!guest) {
          const id2 = this.create(details.url, entry.bounds);
          const created = this.views.get(id2);
          emit(this.shell(), "browser:tabRequested", {
            viewId: id2,
            url: details.url,
            openerViewId: entry.id
          });
          return created.view.webContents;
        }
        const view = new WebContentsView({ webContents: guest });
        const id = this.register(view, entry.bounds, null);
        emit(this.shell(), "browser:tabRequested", {
          viewId: id,
          url: details.url,
          openerViewId: entry.id
        });
        return guest;
      }
    }));
  }
  setBounds(id, bounds) {
    const entry = this.views.get(id);
    if (!entry) return;
    entry.bounds = bounds;
    entry.view.setBounds(bounds);
  }
  setVisible(id, visible) {
    const entry = this.views.get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.view.setVisible(visible);
    if (visible) {
      this.window.contentView.addChildView(entry.view);
      entry.view.webContents.focus();
    }
  }
  /** Focus the visible browser view, if any. Returns whether one took focus. */
  focusVisible() {
    for (const entry of this.views.values()) {
      if (entry.visible && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.focus();
        return true;
      }
    }
    return false;
  }
  /** Hide every view except `keepId`. Used on tab switch and when a non-browser tab activates. */
  showOnly(keepId) {
    for (const [id, entry] of this.views) {
      const visible = id === keepId;
      if (entry.visible !== visible) this.setVisible(id, visible);
    }
  }
  navigate(id, url) {
    void this.views.get(id)?.view.webContents.loadURL(url).catch(() => {
    });
  }
  goBack(id) {
    this.views.get(id)?.view.webContents.navigationHistory.goBack();
  }
  goForward(id) {
    this.views.get(id)?.view.webContents.navigationHistory.goForward();
  }
  reload(id) {
    this.views.get(id)?.view.webContents.reload();
  }
  stop(id) {
    this.views.get(id)?.view.webContents.stop();
  }
  openDevTools(id) {
    this.views.get(id)?.view.webContents.openDevTools({ mode: "detach" });
  }
  destroy(id) {
    const entry = this.views.get(id);
    if (!entry) return;
    this.views.delete(id);
    this.window.contentView.removeChildView(entry.view);
    const wc = entry.view.webContents;
    wc.removeAllListeners();
    if (!wc.isDestroyed()) wc.close();
  }
  destroyAll() {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }
  /** Resolve a view id from a WebContents, for routing app-level events like 'login'. */
  idFor(wc) {
    for (const [id, entry] of this.views) {
      if (entry.view.webContents === wc) return id;
    }
    return null;
  }
}
const DELIMITER = "__onestop_path_delimiter__";
const TIMEOUT_MS = 5e3;
const FALLBACK_DIRS = [
  "/opt/homebrew/bin",
  // Homebrew on Apple Silicon
  "/usr/local/bin",
  // Homebrew on Intel, and most `make install` targets
  "/opt/local/bin",
  // MacPorts
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];
let resolved = null;
function ensureShellPath() {
  resolved ??= resolve();
  return resolved;
}
async function resolve() {
  if (process.platform === "win32") return;
  const before = process.env.PATH ?? "";
  let fromShell = null;
  try {
    fromShell = await probeLoginShell();
  } catch {
    fromShell = null;
  }
  const merged = mergePaths(fromShell ?? "", before, FALLBACK_DIRS);
  process.env.PATH = merged;
  if (merged !== before) {
    console.log(
      `[env] PATH recovered from ${fromShell ? "login shell" : "fallback list"}: ${before.split(":").length} entries -> ${merged.split(":").length}`
    );
  }
}
function probeLoginShell() {
  const shell2 = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return new Promise((resolvePath, reject) => {
    execFile(
      shell2,
      ["-ilc", `printf %s '${DELIMITER}'; printenv PATH; printf %s '${DELIMITER}'`],
      { timeout: TIMEOUT_MS, encoding: "utf8", env: { ...process.env, TERM: "dumb" } },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        const first = stdout.indexOf(DELIMITER);
        const second = stdout.indexOf(DELIMITER, first + DELIMITER.length);
        if (first < 0 || second < 0) return reject(new Error("delimiters not found in shell output"));
        const value = stdout.slice(first + DELIMITER.length, second).trim();
        if (!value) return reject(new Error("shell reported an empty PATH"));
        resolvePath(value);
      }
    );
  });
}
function mergePaths(...sources) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const source of sources) {
    const entries = Array.isArray(source) ? source : source.split(":");
    for (const entry of entries) {
      const dir = entry.trim();
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}
let gitBin = null;
function resolveGitBinary() {
  gitBin ??= locate();
  return gitBin;
}
async function locate() {
  const candidates = [];
  if (process.platform === "darwin") {
    const found = await tryExec("/usr/bin/xcrun", ["--find", "git"]);
    if (found) candidates.push(found.trim());
    candidates.push("/opt/homebrew/bin/git", "/usr/local/bin/git");
  } else if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    candidates.push(`${pf}\\Git\\cmd\\git.exe`);
  }
  for (const candidate of candidates) {
    if (await tryExec(candidate, ["--version"])) return candidate;
  }
  return "git";
}
function tryExec(file, args) {
  return new Promise((resolve2) => {
    execFile(
      file,
      args,
      { timeout: 5e3, encoding: "utf8" },
      (err, stdout) => resolve2(err ? null : stdout)
    );
  });
}
function gitEnv(extra) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // never block on a terminal that does not exist
    GIT_PAGER: "cat",
    // core.pager=less would hang forever
    PAGER: "cat",
    GIT_EDITOR: "true",
    // an accidental interactive command aborts instead of hanging
    ...extra
  };
}
function git(cwd, args, opts = {}) {
  return resolveGitBinary().then(
    (bin) => new Promise((resolve2, reject) => {
      const child = execFile(
        bin,
        args,
        {
          cwd,
          env: gitEnv(opts.env),
          encoding: "buffer",
          maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          if (err && err.code === "ENOENT") return reject(err);
          resolve2({ stdout, stderr: stderr.toString("utf8"), code });
        }
      );
      if (opts.stdin !== void 0) {
        child.stdin?.end(opts.stdin);
      }
    })
  );
}
async function gitText(cwd, args, stdin) {
  const res = await git(cwd, args, { stdin });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.toString("utf8").trim() || `git ${args[0]} failed`);
  }
  return res.stdout.toString("utf8");
}
function gitSpawn(cwd, args, bin) {
  return spawn(bin, args, { cwd, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}
class BlobReader {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
  }
  repoRoot;
  proc = null;
  buf = Buffer.alloc(0);
  queue = [];
  /** null while awaiting a header; otherwise how many payload bytes are still to come. */
  awaiting = null;
  disposed = false;
  async ensure() {
    if (this.proc && !this.proc.killed) return this.proc;
    const bin = await resolveGitBinary();
    const proc = gitSpawn(this.repoRoot, ["cat-file", "--batch"], bin);
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.awaiting = null;
    proc.stdout.on("data", (chunk) => this.consume(chunk));
    proc.on("exit", () => {
      this.proc = null;
      for (const p of this.queue.splice(0)) p.reject(new Error("git cat-file exited"));
    });
    proc.on("error", (err) => {
      this.proc = null;
      for (const p of this.queue.splice(0)) p.reject(err);
    });
    return proc;
  }
  /**
   * Read a blob BY OBJECT ID.
   *
   * Only object ids are accepted, and that restriction is the whole point. A long-lived
   * `cat-file --batch` caches the index it read at startup, so a revision-relative spec goes
   * stale the moment anything stages a change — including the user typing `git add` in one of
   * this app's own terminals. Reproduced: after `git add`, the same process kept returning the
   * pre-add blob and oid for `:0:a.txt`, while a fresh process returned the new content.
   *
   * Object ids are immutable, so they are always safe to serve from a warm process. Callers
   * resolve specs to ids first (see GitService.diff).
   */
  async read(spec) {
    if (this.disposed) throw new Error("BlobReader disposed");
    if (!/^[0-9a-f]{40}$/.test(spec) && !/^[0-9a-f]{64}$/.test(spec)) {
      throw new Error(`BlobReader.read expects an object id, got ${JSON.stringify(spec.slice(0, 40))}`);
    }
    const proc = await this.ensure();
    return new Promise((resolve2, reject) => {
      this.queue.push({ resolve: resolve2, reject });
      proc.stdin.write(`${spec}
`);
    });
  }
  consume(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (; ; ) {
      if (this.awaiting === null) {
        const nl2 = this.buf.indexOf(10);
        if (nl2 < 0) return;
        const header = this.buf.toString("latin1", 0, nl2);
        this.buf = this.buf.subarray(nl2 + 1);
        if (header.endsWith(" missing")) {
          this.queue.shift()?.resolve(null);
          continue;
        }
        const size = Number(header.slice(header.lastIndexOf(" ") + 1));
        if (!Number.isFinite(size)) {
          this.queue.shift()?.reject(new Error(`unparsable cat-file header: ${header.slice(0, 80)}`));
          continue;
        }
        this.awaiting = size + 1;
      }
      if (this.buf.length < this.awaiting) return;
      const payload = this.buf.subarray(0, this.awaiting - 1);
      this.buf = this.buf.subarray(this.awaiting);
      this.awaiting = null;
      this.queue.shift()?.resolve(Buffer.from(payload));
    }
  }
  dispose() {
    this.disposed = true;
    for (const p of this.queue.splice(0)) p.reject(new Error("BlobReader disposed"));
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}
function looksBinary(buf) {
  return buf.subarray(0, 8e3).includes(0);
}
const STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "-z",
  // -unormal collapses an untracked directory to a single `? dir/` record. -uall on a large repo
  // was measured in seconds rather than milliseconds.
  "-unormal",
  "--branch",
  "--show-stash",
  "--ignore-submodules=none"
];
function parsePorcelainV2(buf) {
  const out = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detachedAt: null,
    stashCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: []
  };
  const fields = buf.toString("utf8").split("\0");
  if (fields.length && fields[fields.length - 1] === "") fields.pop();
  let oid = null;
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec === "") continue;
    switch (rec[0]) {
      case "#": {
        const body = rec.slice(2);
        const sp = body.indexOf(" ");
        const key = sp < 0 ? body : body.slice(0, sp);
        const value = sp < 0 ? "" : body.slice(sp + 1);
        if (key === "branch.oid") oid = value;
        else if (key === "branch.head") out.branch = value === "(detached)" ? null : value;
        else if (key === "branch.upstream") out.upstream = value;
        else if (key === "branch.ab") {
          const m = /^\+(\d+) -(\d+)$/.exec(value);
          if (m) {
            out.ahead = Number(m[1]);
            out.behind = Number(m[2]);
          }
        } else if (key === "stash") out.stashCount = Number(value) || 0;
        break;
      }
      case "1": {
        const f = splitFields(rec, 8);
        if (!f) break;
        const [, xy, sub] = f;
        push(out, change(f[8], null, xy, sub, null));
        break;
      }
      case "2": {
        const f = splitFields(rec, 9);
        if (!f) break;
        const origPath = fields[++i] ?? null;
        const score = Number(f[8].slice(1)) || null;
        push(out, change(f[9], origPath, f[1], f[2], score));
        break;
      }
      case "u": {
        const f = splitFields(rec, 10);
        if (!f) break;
        const c = change(f[10], null, f[1], f[2], null);
        out.conflicts.push({ ...c, index: "U", worktree: "U" });
        break;
      }
      case "?":
        out.untracked.push(plain(rec.slice(2), "?"));
        break;
    }
  }
  if (out.branch === null && oid && oid !== "(initial)") out.detachedAt = oid.slice(0, 8);
  return out;
}
function splitFields(rec, count) {
  const parts = [];
  let pos = 0;
  for (let n = 0; n < count; n++) {
    const sp = rec.indexOf(" ", pos);
    if (sp < 0) return null;
    parts.push(rec.slice(pos, sp));
    pos = sp + 1;
  }
  parts.push(rec.slice(pos));
  return parts;
}
function change(path, origPath, xy, sub, score) {
  return {
    path,
    origPath,
    index: letter(xy[0]),
    worktree: letter(xy[1]),
    score,
    // "N..." means not a submodule; anything else is "S<c><m><u>".
    isSubmodule: sub[0] === "S"
  };
}
function plain(path, l) {
  return { path, origPath: null, index: ".", worktree: l, score: null, isSubmodule: false };
}
function letter(c) {
  return c === "." ? "." : c;
}
function push(out, c) {
  if (c.index !== ".") out.staged.push(c);
  if (c.worktree !== ".") out.unstaged.push(c);
}
async function detectOperation(gitDir) {
  const [merge, rebaseMerge, rebaseApply, cherry, revert, bisect] = await Promise.all([
    exists(join(gitDir, "MERGE_HEAD")),
    exists(join(gitDir, "rebase-merge")),
    exists(join(gitDir, "rebase-apply")),
    exists(join(gitDir, "CHERRY_PICK_HEAD")),
    exists(join(gitDir, "REVERT_HEAD")),
    exists(join(gitDir, "BISECT_LOG"))
  ]);
  if (rebaseMerge || rebaseApply) return "rebase";
  if (cherry) return "cherry-pick";
  if (revert) return "revert";
  if (merge) return "merge";
  if (bisect) return "bisect";
  return "none";
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function resolveRepoPaths(cwd) {
  const out = await gitText(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel"
  ]);
  const [gitDir, commonDir, root] = out.trim().split("\n");
  if (!gitDir || !commonDir || !root) throw new Error(`not a git repository: ${cwd}`);
  return { gitDir, commonDir, root };
}
async function readStatus(paths) {
  const [res, operation] = await Promise.all([
    git(paths.root, STATUS_ARGS),
    detectOperation(paths.gitDir)
  ]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git status failed");
  const p = parsePorcelainV2(res.stdout);
  return {
    repoId: paths.root,
    root: paths.root,
    name: basename(paths.root),
    branch: p.branch,
    upstream: p.upstream,
    ahead: p.ahead,
    behind: p.behind,
    detachedAt: p.detachedAt,
    operation,
    staged: p.staged,
    unstaged: p.unstaged,
    untracked: p.untracked,
    conflicts: p.conflicts,
    stashCount: p.stashCount,
    at: Date.now()
  };
}
const WORKTREE_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.gradle/**",
  "**/vendor/**"
];
const GITDIR_IGNORE = [
  "**/objects/**",
  "**/lfs/**",
  "**/modules/**",
  "**/fsmonitor--daemon/**",
  "**/fsmonitor--daemon.ipc",
  "**/worktrees/*/objects/**"
];
const WORKTREE_DEBOUNCE_MS = 150;
const WORKTREE_MAX_WAIT_MS = 600;
const GITDIR_DEBOUNCE_MS = 50;
const FALLBACK_POLL_MS = 3e3;
class ScmWatchers {
  constructor(refresh) {
    this.refresh = refresh;
  }
  refresh;
  entries = /* @__PURE__ */ new Map();
  async watch(paths) {
    if (this.entries.has(paths.root)) return;
    const entry = {
      paths,
      subs: [],
      timer: null,
      maxTimer: null,
      poll: null,
      running: false,
      dirty: false,
      pendingReason: "worktree"
    };
    this.entries.set(paths.root, entry);
    const worktreeOk = await this.subscribe(entry, paths.root, WORKTREE_IGNORE, "worktree");
    const gitDirs = /* @__PURE__ */ new Set([paths.gitDir, paths.commonDir]);
    for (const dir of gitDirs) {
      await this.subscribe(entry, dir, GITDIR_IGNORE, "gitdir");
    }
    if (!worktreeOk) {
      console.warn(
        `[scm] falling back to polling for ${paths.root}. On Linux raise the limit with:
      sudo sysctl fs.inotify.max_user_watches=524288`
      );
      entry.poll = setInterval(() => this.run(entry, "poll"), FALLBACK_POLL_MS);
    }
  }
  async subscribe(entry, dir, ignore, reason) {
    try {
      const sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            console.warn(`[scm] watcher error on ${dir}: ${err.message}`);
            return;
          }
          if (!interesting(events)) return;
          this.schedule(entry, reason);
        },
        { ignore }
      );
      entry.subs.push(sub);
      return true;
    } catch (err) {
      console.warn(`[scm] cannot watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  /** Trailing debounce, with a ceiling so a long build still refreshes periodically. */
  schedule(entry, reason) {
    entry.pendingReason = reason;
    const wait = reason === "gitdir" ? GITDIR_DEBOUNCE_MS : WORKTREE_DEBOUNCE_MS;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.fire(entry), wait);
    if (!entry.maxTimer && reason !== "gitdir") {
      entry.maxTimer = setTimeout(() => this.fire(entry), WORKTREE_MAX_WAIT_MS);
    }
  }
  fire(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.maxTimer) {
      clearTimeout(entry.maxTimer);
      entry.maxTimer = null;
    }
    this.run(entry, entry.pendingReason);
  }
  /**
   * One refresh in flight per repo. Events arriving during a refresh set a dirty flag and cause
   * exactly one more run, rather than queueing — a build touching 2000 files must not enqueue
   * 2000 `git status` calls.
   */
  run(entry, reason) {
    if (entry.running) {
      entry.dirty = true;
      return;
    }
    entry.running = true;
    void this.refresh(entry.paths, reason).catch((err) => {
      console.warn(`[scm] refresh failed for ${entry.paths.root}: ${String(err)}`);
    }).finally(() => {
      entry.running = false;
      if (entry.dirty) {
        entry.dirty = false;
        this.run(entry, reason);
      }
    });
  }
  unwatch(repoRoot) {
    const entry = this.entries.get(repoRoot);
    if (!entry) return;
    this.entries.delete(repoRoot);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    if (entry.poll) clearInterval(entry.poll);
    for (const sub of entry.subs) void sub.unsubscribe().catch(() => {
    });
  }
  /** Stop watching everything not in `keep`, so switching workspace releases the old repos. */
  retain(keep) {
    for (const root of [...this.entries.keys()]) {
      if (!keep.has(root)) this.unwatch(root);
    }
  }
  dispose() {
    for (const root of [...this.entries.keys()]) this.unwatch(root);
  }
}
function interesting(events) {
  return events.some((e) => !e.path.endsWith(".lock"));
}
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
class GitService {
  repos = /* @__PURE__ */ new Map();
  watchers = null;
  /** Last status emitted per repo, so unchanged refreshes stay silent. */
  lastStatusKey = /* @__PURE__ */ new Map();
  async repo(repoRoot) {
    let entry = this.repos.get(repoRoot);
    if (!entry) {
      const paths = await resolveRepoPaths(repoRoot);
      entry = this.repos.get(paths.root) ?? { paths, blobs: new BlobReader(paths.root) };
      this.repos.set(repoRoot, entry);
      this.repos.set(paths.root, entry);
    }
    return entry;
  }
  async status(repoRoot) {
    const { paths } = await this.repo(repoRoot);
    return readStatus(paths);
  }
  /** Repos are independent, so they refresh concurrently; one bad repo must not sink the rest. */
  async statusAll(repoRoots) {
    const results = await Promise.allSettled(repoRoots.map((r) => this.status(r)));
    const out = [];
    for (const [i, r] of results.entries()) {
      if (r.status === "fulfilled") out.push(r.value);
      else console.warn(`[git] status failed for ${repoRoots[i]}: ${String(r.reason)}`);
    }
    return out;
  }
  /**
   * The two sides of a diff.
   *
   * Which pair depends on which group the row came from, and it matters: showing
   * worktree-vs-HEAD for a row under "Staged Changes" would display unstaged edits the user did
   * not stage.
   *
   *   worktree-vs-index  unstaged edits      index blob   vs  file on disk
   *   index-vs-head      staged edits        HEAD blob    vs  index blob
   *   worktree-vs-head   everything          HEAD blob    vs  file on disk
   */
  async diff(repoRoot, path, against) {
    const { paths, blobs } = await this.repo(repoRoot);
    const resolve2 = async (spec) => {
      const res = await git(paths.root, ["rev-parse", "--quiet", "--verify", spec]);
      if (res.code !== 0) return null;
      return blobs.read(res.stdout.toString("utf8").trim());
    };
    const original = await resolve2(
      against.kind === "worktree-vs-index" ? `:0:${path}` : `HEAD:${path}`
    );
    let modified;
    if (against.kind === "index-vs-head") {
      modified = await resolve2(`:0:${path}`);
    } else {
      modified = await readFile(join(paths.root, path)).catch(() => null);
    }
    const empty = { original: "", modified: "", binary: false, tooLarge: false };
    if (!original && !modified) return empty;
    const size = (original?.length ?? 0) + (modified?.length ?? 0);
    if (size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true };
    if (original && looksBinary(original) || modified && looksBinary(modified)) {
      return { ...empty, binary: true };
    }
    return {
      original: original?.toString("utf8") ?? "",
      modified: modified?.toString("utf8") ?? "",
      binary: false,
      tooLarge: false
    };
  }
  /**
   * `-A` rather than a bare `add`: it is the only form that stages a deletion as well as a
   * modification, so one code path covers every row in the panel.
   */
  async stage(repoRoot, paths) {
    if (paths.length === 0) return;
    const { paths: p } = await this.repo(repoRoot);
    await gitText(p.root, ["add", "-A", "--", ...paths]);
  }
  async unstage(repoRoot, paths) {
    if (paths.length === 0) return;
    const { paths: p } = await this.repo(repoRoot);
    const hasHead = (await git(p.root, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (hasHead) await gitText(p.root, ["restore", "--staged", "--", ...paths]);
    else await gitText(p.root, ["rm", "--cached", "-r", "--", ...paths]);
  }
  /** Throw away working-tree changes. Untracked files are removed, tracked ones restored. */
  async discard(repoRoot, paths) {
    if (paths.length === 0) return;
    const { paths: p } = await this.repo(repoRoot);
    const status = await readStatus(p);
    const untracked = new Set(status.untracked.map((f) => f.path));
    const toRestore = paths.filter((x) => !untracked.has(x));
    const toClean = paths.filter((x) => untracked.has(x));
    if (toRestore.length) await gitText(p.root, ["restore", "--worktree", "--", ...toRestore]);
    if (toClean.length) await gitText(p.root, ["clean", "-fdq", "--", ...toClean]);
  }
  /**
   * Commit with the message on stdin.
   *
   * Never `-m`: it hits argument-length limits and joins paragraphs differently from a message
   * file. And never echo back the message the user typed — a `commit-msg` hook may have rewritten
   * it, so the recorded subject is re-read afterwards.
   */
  async commit(repoRoot, message, amend) {
    const { paths } = await this.repo(repoRoot);
    const args = ["commit", "-q", ...amend ? ["--amend"] : [], "-F", "-"];
    const res = await git(paths.root, args, { stdin: message });
    if (res.code !== 0) {
      const detail = [res.stderr.trim(), res.stdout.toString("utf8").trim()].filter(Boolean).join("\n");
      throw new Error(detail || "git commit failed");
    }
    const sha = (await gitText(paths.root, ["rev-parse", "HEAD"])).trim();
    return { sha };
  }
  /**
   * Watch these repositories and push a fresh status whenever anything changes, replacing the
   * renderer's polling. Called again on every workspace switch; repos no longer in the list are
   * released.
   */
  async watch(repoRoots, onStatus) {
    this.watchers ??= new ScmWatchers(async (paths) => {
      const status = await readStatus(paths);
      const key = statusKey(status);
      if (this.lastStatusKey.get(paths.root) === key) return;
      this.lastStatusKey.set(paths.root, key);
      onStatus(status);
    });
    const resolved2 = [];
    for (const root of repoRoots) {
      try {
        const { paths } = await this.repo(root);
        resolved2.push(paths.root);
        await this.watchers.watch(paths);
      } catch (err) {
        console.warn(`[git] cannot watch ${root}: ${String(err)}`);
      }
    }
    this.watchers.retain(new Set(resolved2));
  }
  dispose() {
    this.lastStatusKey.clear();
    this.watchers?.dispose();
    this.watchers = null;
    for (const repo of new Set(this.repos.values())) repo.blobs.dispose();
    this.repos.clear();
  }
}
function statusKey(s) {
  const files = (fs) => fs.map((f) => `${f.path}:${f.origPath ?? ""}:${f.index}${f.worktree}`).join("|");
  return [
    s.branch,
    s.upstream,
    s.ahead,
    s.behind,
    s.detachedAt,
    s.operation,
    s.stashCount,
    files(s.staged),
    files(s.unstaged),
    files(s.untracked),
    files(s.conflicts)
  ].join("");
}
const MAX_LINE = 1 << 20;
const DECODE_CAP = 64 * 1024;
const B_PCT = 37;
const B_LF = 10;
const B_SP = 32;
const B_BS = 92;
const B_COLON = 58;
const P_OUTPUT = Buffer.from("%output ", "latin1");
const P_EXTOUT = Buffer.from("%extended-output ", "latin1");
const P_BEGIN = Buffer.from("%begin ", "latin1");
const TERM_END = Buffer.from("%end ", "latin1");
const TERM_ERR = Buffer.from("%error ", "latin1");
const N_PAUSE = Buffer.from("%pause ", "latin1");
const N_CONT = Buffer.from("%continue ", "latin1");
function unescapeInto(buf, s, e, out) {
  let o = 0;
  const cap = out.length;
  for (let i = s; i < e; i++) {
    if (o >= cap) return -1;
    const c = buf[i];
    if (c === B_BS && i + 3 < e) {
      const a = buf[i + 1];
      const b = buf[i + 2];
      const d = buf[i + 3];
      if (isOctal(a) && isOctal(b) && isOctal(d)) {
        out[o++] = a - 48 << 6 | b - 48 << 3 | d - 48;
        i += 3;
        continue;
      }
    }
    out[o++] = c;
  }
  return o;
}
function isOctal(c) {
  return c >= 48 && c <= 55;
}
class TmuxStreamParser {
  constructor(sink) {
    this.sink = sink;
  }
  sink;
  tail = null;
  openBlock = null;
  /** True while discarding the remainder of an over-long line. */
  overlong = false;
  scratch = Buffer.allocUnsafe(DECODE_CAP);
  stats = { lines: 0, output: 0, anomalies: 0, truncated: 0 };
  push(chunk) {
    let buf = chunk;
    let start = 0;
    if (this.tail !== null) {
      buf = Buffer.concat([this.tail, chunk]);
      this.tail = null;
    }
    for (; ; ) {
      const nl2 = buf.indexOf(B_LF, start);
      if (nl2 < 0) {
        const rem = buf.length - start;
        if (rem > MAX_LINE) {
          this.overlong = true;
          this.stats.truncated++;
          this.sink.onAnomaly("line-too-long", buf.toString("latin1", start, start + 80));
          return;
        }
        if (rem > 0) this.tail = Buffer.from(buf.subarray(start));
        return;
      }
      if (this.overlong) {
        this.overlong = false;
        start = nl2 + 1;
        continue;
      }
      this.line(buf, start, nl2);
      start = nl2 + 1;
    }
  }
  /** `s` inclusive, `e` exclusive and pointing AT the LF. */
  line(buf, s, e) {
    this.stats.lines++;
    if (this.openBlock !== null) {
      const block = this.openBlock;
      if (this.isTerminator(buf, s, e, TERM_END, block.rest)) return this.closeBlock(true);
      if (this.isTerminator(buf, s, e, TERM_ERR, block.rest)) return this.closeBlock(false);
      if (buf[s] === B_PCT && (this.hasPrefix(buf, s, e, N_PAUSE) || this.hasPrefix(buf, s, e, N_CONT))) {
        return this.notification(buf, s, e);
      }
      this.sink.onBlockLine(buf.toString("utf8", s, e));
      return;
    }
    if (buf[s] !== B_PCT) {
      this.stats.anomalies++;
      this.sink.onAnomaly("unframed-line", buf.toString("latin1", s, Math.min(e, s + 120)));
      return;
    }
    if (this.hasPrefix(buf, s, e, P_OUTPUT)) return this.output(buf, s + P_OUTPUT.length, e, false);
    if (this.hasPrefix(buf, s, e, P_EXTOUT)) return this.output(buf, s + P_EXTOUT.length, e, true);
    if (this.hasPrefix(buf, s, e, P_BEGIN)) {
      const rest = buf.toString("latin1", s + P_BEGIN.length, e);
      const f = rest.split(" ");
      this.openBlock = { rest, time: Number(f[0]), number: Number(f[1]), flags: Number(f[2]) };
      this.sink.onBlockBegin(this.openBlock.time, this.openBlock.number, this.openBlock.flags);
      return;
    }
    this.notification(buf, s, e);
  }
  isTerminator(buf, s, e, keyword, rest) {
    if (e - s !== keyword.length + rest.length) return false;
    if (buf.compare(keyword, 0, keyword.length, s, s + keyword.length) !== 0) return false;
    return buf.toString("latin1", s + keyword.length, e) === rest;
  }
  /** Length-guarded prefix test, bounded by the line end. */
  hasPrefix(buf, s, e, prefix) {
    if (e - s < prefix.length) return false;
    return buf.compare(prefix, 0, prefix.length, s, s + prefix.length) === 0;
  }
  closeBlock(ok) {
    const b = this.openBlock;
    this.openBlock = null;
    this.sink.onBlockEnd(ok, b.time, b.number, b.flags);
  }
  notification(buf, s, e) {
    let i = s + 1;
    while (i < e && buf[i] !== B_SP) i++;
    const name = buf.toString("latin1", s + 1, i);
    const args = i < e ? buf.toString("utf8", i + 1, e) : "";
    this.sink.onNotification(name, args);
  }
  output(buf, i, e, extended) {
    let sp = -1;
    for (let k = i; k < e; k++) {
      if (buf[k] === B_SP) {
        sp = k;
        break;
      }
    }
    if (sp < 0) {
      this.stats.anomalies++;
      this.sink.onAnomaly("output-no-pane", "");
      return;
    }
    const pane = buf.toString("latin1", i, sp);
    let p = sp + 1;
    let age = null;
    if (extended) {
      let tokStart = p;
      let first = true;
      for (; ; ) {
        let k = tokStart;
        while (k < e && buf[k] !== B_SP) k++;
        if (k >= e) {
          this.stats.anomalies++;
          this.sink.onAnomaly("extout-no-colon", "");
          return;
        }
        if (k - tokStart === 1 && buf[tokStart] === B_COLON) {
          p = k + 1;
          break;
        }
        if (first) {
          age = Number(buf.toString("latin1", tokStart, k));
          first = false;
        }
        tokStart = k + 1;
      }
    }
    const n = unescapeInto(buf, p, e, this.scratch);
    if (n < 0) {
      this.stats.anomalies++;
      this.sink.onAnomaly("decode-overflow", pane);
      return;
    }
    this.stats.output++;
    this.sink.onOutput(pane, this.scratch.subarray(0, n), age);
  }
}
class LayoutParseError extends Error {
}
function parseLayout(layout) {
  if (layout.length < 6 || layout[4] !== ",") {
    throw new LayoutParseError(`missing 4-hex-digit checksum prefix: ${layout.slice(0, 16)}`);
  }
  const p = new Cursor(layout, 5);
  const node = parseCell(p);
  if (!p.atEnd()) throw new LayoutParseError(`trailing junk at ${p.pos}: ${layout.slice(p.pos, p.pos + 16)}`);
  return node;
}
class Cursor {
  constructor(s, pos) {
    this.s = s;
    this.pos = pos;
  }
  s;
  pos;
  peek() {
    return this.s[this.pos] ?? "";
  }
  take() {
    return this.s[this.pos++] ?? "";
  }
  atEnd() {
    return this.pos >= this.s.length;
  }
  expect(ch) {
    if (this.take() !== ch) throw new LayoutParseError(`expected '${ch}' at ${this.pos - 1}`);
  }
  number() {
    const start = this.pos;
    while (this.pos < this.s.length && this.s[this.pos] >= "0" && this.s[this.pos] <= "9") this.pos++;
    if (this.pos === start) throw new LayoutParseError(`expected digits at ${start}`);
    return Number(this.s.slice(start, this.pos));
  }
}
function parseCell(p) {
  const width = p.number();
  p.expect("x");
  const height = p.number();
  p.expect(",");
  const x = p.number();
  p.expect(",");
  const y = p.number();
  const next = p.peek();
  if (next === "{" || next === "[") {
    const direction = next === "{" ? "horizontal" : "vertical";
    const close = next === "{" ? "}" : "]";
    p.take();
    const children = [parseCell(p)];
    while (p.peek() === ",") {
      p.take();
      children.push(parseCell(p));
    }
    p.expect(close);
    return { kind: "split", direction, x, y, width, height, children };
  }
  if (next === ",") {
    p.take();
    const paneNumber = p.number();
    return { kind: "pane", paneId: `%${paneNumber}`, x, y, width, height };
  }
  throw new LayoutParseError(`expected ',', '{' or '[' after geometry at ${p.pos}`);
}
function panesInLayout(node, out = []) {
  if (node.kind === "pane") out.push(node.paneId);
  else for (const c of node.children) panesInLayout(c, out);
  return out;
}
function diffPanes(previous, next) {
  const before = new Set(previous ? panesInLayout(previous) : []);
  const after = new Set(panesInLayout(next));
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id))
  };
}
const PAUSE_AFTER_SECONDS = 2;
const SEND_KEYS_MAX_BYTES = 64;
const SEND_KEYS_CHUNK = 1024;
const FS = "";
const nl = (v) => `#{s/\\n/ /:${v}}`;
const LIST_WINDOWS_FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{window_index}",
  nl("window_name"),
  "#{window_active}",
  "#{window_width}",
  "#{window_height}",
  "#{window_zoomed_flag}",
  "#{window_layout}",
  "#{window_visible_layout}"
].join(FS);
const LIST_PANES_FORMAT = [
  "#{window_id}",
  "#{pane_id}",
  "#{pane_active}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_left}",
  "#{pane_top}",
  nl("pane_current_path"),
  nl("pane_current_command"),
  nl("pane_title"),
  "#{pane_in_mode}",
  "#{pane_dead}"
].join(FS);
class TmuxClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.parser = new TmuxStreamParser(this.sink());
  }
  opts;
  proc = null;
  parser;
  pending = [];
  /** Body lines of the guard block currently open, when it is one of ours. */
  blockLines = [];
  blockIsOurs = false;
  exited = false;
  windows = /* @__PURE__ */ new Map();
  panes = /* @__PURE__ */ new Map();
  layouts = /* @__PURE__ */ new Map();
  /** Panes we have proactively paused because the renderer fell behind. */
  desynced = /* @__PURE__ */ new Set();
  resizeTimers = /* @__PURE__ */ new Map();
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async start() {
    const tmuxArgs = [
      "-S",
      this.opts.socketPath,
      "-C",
      ...this.opts.configFile ? ["-f", this.opts.configFile] : [],
      "new-session",
      "-A",
      // attach if the session exists
      "-D",
      // detach any other client, so we are the only size negotiator
      "-s",
      this.opts.sessionName,
      "-x",
      String(this.opts.cols),
      "-y",
      String(this.opts.rows),
      "-c",
      this.opts.cwd,
      // The subcommand's own -f is client-flags, distinct from the global config-file -f above.
      "-f",
      `pause-after=${PAUSE_AFTER_SECONDS}`
    ];
    const [file, args] = this.opts.useWsl ? ["wsl.exe", ["--", "tmux", ...tmuxArgs]] : ["tmux", tmuxArgs];
    const proc = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout.on("data", (chunk) => this.parser.push(chunk));
    proc.stderr.on("data", (chunk) => {
      this.emit("anomaly", "stderr", chunk.toString("utf8").slice(0, 400));
    });
    proc.on("error", (err) => this.fail(`spawn failed: ${err.message}`, null));
    proc.on("exit", (code) => {
      if (!this.exited) this.fail("tmux client exited", code);
    });
    await this.refreshState();
  }
  dispose() {
    if (this.exited) return;
    this.exited = true;
    for (const t of this.resizeTimers.values()) clearTimeout(t);
    this.resizeTimers.clear();
    for (const p of this.pending.splice(0)) p.reject(new Error("client disposed"));
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      try {
        proc.stdin.write("\n");
      } catch {
      }
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGTERM");
      }, 250).unref();
    }
  }
  fail(reason, code) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.splice(0)) p.reject(new Error(reason));
    this.emit("exit", reason, code);
  }
  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  /**
   * Send one command and resolve with its guard-block body lines.
   * Rejects if tmux answers with %error.
   */
  command(cmd) {
    if (this.exited || !this.proc) return Promise.reject(new Error("tmux client not running"));
    if (cmd.includes("\n")) return Promise.reject(new Error("command may not contain a newline"));
    return new Promise((resolve2, reject) => {
      this.pending.push({ resolve: resolve2, reject, command: cmd });
      this.proc.stdin.write(`${cmd}
`);
    });
  }
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  async refreshState() {
    const [winLines, paneLines] = await Promise.all([
      this.command(`list-windows -a -F "${LIST_WINDOWS_FORMAT}"`),
      this.command(`list-panes -a -F "${LIST_PANES_FORMAT}"`)
    ]);
    this.windows.clear();
    this.panes.clear();
    for (const line of winLines) {
      const f = line.split(FS);
      if (f.length < 10) continue;
      const id = f[1];
      this.windows.set(id, {
        id,
        sessionId: f[0],
        index: Number(f[2]),
        name: f[3],
        active: f[4] === "1",
        layout: f[8],
        panes: []
      });
      const visible = f[9];
      try {
        this.layouts.set(id, parseLayout(visible));
      } catch (err) {
        this.emit("anomaly", "layout-parse", err.message);
      }
    }
    for (const line of paneLines) {
      const f = line.split(FS);
      if (f.length < 12) continue;
      const id = f[1];
      const windowId = f[0];
      this.panes.set(id, {
        id,
        windowId,
        active: f[2] === "1",
        width: Number(f[3]),
        height: Number(f[4]),
        left: Number(f[5]),
        top: Number(f[6]),
        currentPath: f[7],
        currentCommand: f[8],
        title: f[9],
        inMode: f[10] === "1",
        dead: f[11] === "1"
      });
      this.windows.get(windowId)?.panes.push(id);
    }
    this.emitState();
  }
  emitState() {
    this.emit("state", [...this.windows.values()], [...this.panes.values()]);
  }
  getLayout(windowId) {
    return this.layouts.get(windowId) ?? null;
  }
  // -------------------------------------------------------------------------
  // Writing into panes
  // -------------------------------------------------------------------------
  /**
   * Write bytes to a pane.
   *
   * send-keys -H is byte-exact but costs ~0.019 ms/byte because tmux routes every hex argument
   * through the full key-input path — about 50 KB/s, and chunking does not help. load-buffer +
   * paste-buffer measures 3.83 MB/s, so anything beyond keystroke scale goes that way.
   */
  async write(paneId, data) {
    if (data.length === 0) return;
    if (data.length <= SEND_KEYS_MAX_BYTES) {
      await this.sendKeys(paneId, data);
    } else {
      await this.pasteBytes(paneId, data);
    }
  }
  async sendKeys(paneId, data) {
    for (let i = 0; i < data.length; i += SEND_KEYS_CHUNK) {
      const chunk = data.subarray(i, i + SEND_KEYS_CHUNK);
      const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
      await this.command(`send-keys -t ${paneId} -H ${hex}`);
    }
  }
  async pasteBytes(paneId, data) {
    const bufferName = `onestop-paste-${process.pid}`;
    const file = join(tmpdir(), `onestop-paste-${process.pid}-${Date.now()}.bin`);
    await writeFile(file, data);
    try {
      await this.command(`load-buffer -b ${bufferName} ${quote(file)}`);
      await this.command(`paste-buffer -d -p -r -b ${bufferName} -t ${paneId}`);
    } finally {
      await unlink(file).catch(() => {
      });
    }
  }
  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------
  /**
   * Tell tmux this window's cell geometry. Debounced: each call is a full
   * recalculate_sizes_now(), and a splitter drag would otherwise issue hundreds.
   */
  resizeWindow(windowId, cols, rows) {
    const existing = this.resizeTimers.get(windowId);
    if (existing) clearTimeout(existing);
    this.resizeTimers.set(
      windowId,
      setTimeout(() => {
        this.resizeTimers.delete(windowId);
        void this.command(`refresh-client -C ${windowId}:${cols}x${rows}`).catch(() => {
        });
      }, 50)
    );
  }
  // -------------------------------------------------------------------------
  // Window / pane operations
  // -------------------------------------------------------------------------
  async newWindow(cwd) {
    const out = await this.command(`new-window -P -F "#{window_id}" -c ${quote(cwd)}`);
    await this.refreshState();
    return out[0]?.trim() ?? "";
  }
  async splitPane(paneId, direction) {
    const flag = direction === "horizontal" ? "-h" : "-v";
    const out = await this.command(`split-window ${flag} -P -F "#{pane_id}" -t ${paneId}`);
    await this.refreshState();
    return out[0]?.trim() ?? "";
  }
  async killPane(paneId) {
    await this.command(`kill-pane -t ${paneId}`);
  }
  async selectPane(paneId) {
    await this.command(`select-pane -t ${paneId}`);
  }
  /** Colour-preserving scrollback snapshot, used to repaint after a paused pane resumes. */
  async capturePane(paneId, historyLines = 2e3) {
    const out = await this.command(`capture-pane -p -e -J -S -${historyLines} -t ${paneId}`);
    return out.join("\n");
  }
  // -------------------------------------------------------------------------
  // Parser sink
  // -------------------------------------------------------------------------
  sink() {
    return {
      onOutput: (paneId, bytes, ageMs) => {
        if (ageMs !== null && ageMs > 1e3 && !this.desynced.has(paneId)) {
          this.desynced.add(paneId);
          void this.command(`refresh-client -A "${paneId}:pause"`).catch(() => {
          });
        }
        this.emit("output", paneId, Uint8Array.prototype.slice.call(bytes));
      },
      onNotification: (name, args) => this.onNotification(name, args),
      onBlockBegin: (_t, _n, flags) => {
        this.blockIsOurs = flags === 1 && this.pending.length > 0;
        this.blockLines = [];
      },
      onBlockLine: (line) => {
        if (this.blockIsOurs) this.blockLines.push(line);
      },
      onBlockEnd: (ok) => {
        if (!this.blockIsOurs) return;
        this.blockIsOurs = false;
        const p = this.pending.shift();
        if (!p) return;
        const lines = this.blockLines;
        this.blockLines = [];
        if (ok) p.resolve(lines);
        else p.reject(new Error(`${p.command}: ${lines.join("; ") || "tmux error"}`));
      },
      onAnomaly: (reason, sample) => this.emit("anomaly", reason, sample)
    };
  }
  onNotification(name, args) {
    switch (name) {
      case "output":
      case "extended-output":
        return;
      // handled on the fast path
      case "layout-change": {
        const [windowId, , visibleLayout] = args.split(" ");
        if (!windowId || !visibleLayout) return;
        try {
          const next = parseLayout(visibleLayout);
          const { removed } = diffPanes(this.layouts.get(windowId) ?? null, next);
          this.layouts.set(windowId, next);
          for (const paneId of removed) {
            this.panes.delete(paneId);
            this.emit("paneExit", paneId);
          }
        } catch (err) {
          this.emit("anomaly", "layout-parse", String(err));
        }
        void this.refreshState().catch(() => {
        });
        return;
      }
      case "window-add":
      case "window-close":
      // control_notify_window_unlinked looks the winlink up after removal, so windows in our own
      // session arrive as unlinked-window-close too. Treat both identically.
      case "unlinked-window-close":
      case "window-renamed":
      case "window-pane-changed":
      case "session-window-changed":
        void this.refreshState().catch(() => {
        });
        return;
      case "pause": {
        const paneId = args.trim();
        this.desynced.add(paneId);
        void this.command(`refresh-client -A "${paneId}:continue"`).catch(() => {
        });
        return;
      }
      case "continue": {
        const paneId = args.trim();
        this.desynced.delete(paneId);
        void this.capturePane(paneId).then((text) => this.emit("output", paneId, new TextEncoder().encode(`\x1Bc${text}`))).catch(() => {
        });
        return;
      }
      case "exit":
        this.fail(args.trim() || "detached", 0);
        return;
      case "config-error":
        this.emit("anomaly", "config-error", args);
        return;
      default:
        return;
    }
  }
}
function quote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
const FLUSH_MS = 6;
const FLUSH_BYTES = 64 * 1024;
class TmuxManager {
  constructor(shell2) {
    this.shell = shell2;
  }
  shell;
  entries = /* @__PURE__ */ new Map();
  /** Private socket directory: we must never be able to reach the user's default tmux server. */
  socketPath(workspaceId) {
    const dir = join(app.getPath("userData"), "tmux");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${workspaceId}.sock`);
  }
  connectionState(workspaceId) {
    return this.entries.get(workspaceId)?.state ?? { status: "disconnected" };
  }
  async connect(workspaceId, sessionName, cwd, cols, rows) {
    const existing = this.entries.get(workspaceId);
    if (existing && existing.state.status === "connected") return existing.state;
    const client = new TmuxClient({
      sessionName,
      cwd,
      socketPath: this.socketPath(workspaceId),
      cols,
      rows,
      useWsl: process.platform === "win32"
    });
    const entry = {
      client,
      port: null,
      queue: /* @__PURE__ */ new Map(),
      queuedBytes: 0,
      timer: null,
      state: { status: "connecting" }
    };
    this.entries.set(workspaceId, entry);
    client.on("output", (paneId, data) => this.enqueue(entry, paneId, data));
    client.on("state", (windows, panes) => this.pushState(workspaceId, entry, windows, panes));
    client.on("paneExit", (paneId) => {
      this.send("tmux:paneExit", { workspaceId, paneId });
    });
    client.on("exit", (reason) => {
      entry.state = { status: "failed", error: reason };
      this.pushState(workspaceId, entry, [], []);
    });
    client.on("anomaly", (reason, sample) => {
      console.warn(`[tmux:${workspaceId}] anomaly ${reason}: ${sample.slice(0, 200)}`);
    });
    try {
      await client.start();
      entry.state = { status: "connected", sessionId: sessionName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.state = /ENOENT/.test(message) ? {
        status: "unavailable",
        reason: process.platform === "win32" ? "WSL or tmux not found. Install WSL2, then install tmux inside your distribution." : `tmux not found. Searched: ${process.env.PATH ?? "(empty PATH)"}`
      } : { status: "failed", error: message };
    }
    return entry.state;
  }
  disconnect(workspaceId) {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.port?.close();
    entry.client.dispose();
  }
  disposeAll() {
    for (const id of [...this.entries.keys()]) this.disconnect(id);
  }
  client(workspaceId) {
    return this.entries.get(workspaceId)?.client ?? null;
  }
  listState(workspaceId) {
    const entry = this.entries.get(workspaceId);
    if (!entry) return { windows: [], panes: [] };
    return entry.lastState ?? { windows: [], panes: [] };
  }
  // -------------------------------------------------------------------------
  // Byte transport
  // -------------------------------------------------------------------------
  /** Hand the renderer one end of a dedicated channel for this workspace's terminal bytes. */
  establishPort(workspaceId) {
    const entry = this.entries.get(workspaceId);
    const wc = this.shell();
    if (!entry || !wc) return;
    entry.port?.close();
    const { port1, port2 } = new MessageChannelMain();
    entry.port = port1;
    port1.on("message", (event) => {
      const msg = event.data;
      if (!msg || typeof msg.paneId !== "string") return;
      void entry.client.write(msg.paneId, new TextEncoder().encode(msg.data)).catch(() => {
      });
    });
    port1.start();
    wc.postMessage("terminal:port", { workspaceId }, [port2]);
  }
  enqueue(entry, paneId, data) {
    let chunks = entry.queue.get(paneId);
    if (!chunks) {
      chunks = [];
      entry.queue.set(paneId, chunks);
    }
    chunks.push(data);
    entry.queuedBytes += data.length;
    if (entry.queuedBytes >= FLUSH_BYTES) {
      this.flush(entry);
      return;
    }
    entry.timer ??= setTimeout(() => this.flush(entry), FLUSH_MS);
  }
  flush(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.queuedBytes = 0;
    const port = entry.port;
    if (!port) {
      entry.queue.clear();
      return;
    }
    for (const [paneId, chunks] of entry.queue) {
      if (chunks.length === 0) continue;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      chunks.length = 0;
      port.postMessage({ paneId, data: merged });
    }
    entry.queue.clear();
  }
  pushState(workspaceId, entry, windows, panes) {
    entry.lastState = { windows, panes };
    this.send("tmux:state", { workspaceId, connection: entry.state, windows, panes });
  }
  send(channel, payload) {
    const wc = this.shell();
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }
}
const PERSISTED_STATE_VERSION = 1;
const EMPTY = {
  version: PERSISTED_STATE_VERSION,
  workspaces: [],
  activeWorkspaceId: null,
  ui: {}
};
function statePath() {
  return join(app.getPath("userData"), "workspaces.json");
}
function writeAtomic(file, contents) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, contents, { encoding: "utf8" });
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
function migrate(raw) {
  if (raw === null || typeof raw !== "object") return { ...EMPTY };
  const doc = raw;
  if (typeof doc.version !== "number") return { ...EMPTY };
  if (doc.version !== PERSISTED_STATE_VERSION) return { ...EMPTY };
  return {
    version: PERSISTED_STATE_VERSION,
    workspaces: Array.isArray(doc.workspaces) ? doc.workspaces : [],
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    ui: doc.ui && typeof doc.ui === "object" ? doc.ui : {}
  };
}
let cache = null;
function loadState() {
  if (cache) return cache;
  const file = statePath();
  if (!existsSync(file)) {
    cache = { ...EMPTY };
    return cache;
  }
  try {
    cache = migrate(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
    }
    cache = { ...EMPTY };
  }
  return cache;
}
function flush() {
  if (cache) writeAtomic(statePath(), JSON.stringify(cache, null, 2));
}
function saveWorkspaces(workspaces, activeWorkspaceId) {
  const state = loadState();
  state.workspaces = workspaces;
  state.activeWorkspaceId = activeWorkspaceId;
  const live = new Set(workspaces.map((w) => w.id));
  for (const id of Object.keys(state.ui)) if (!live.has(id)) delete state.ui[id];
  flush();
}
function saveUi(workspaceId, ui) {
  const state = loadState();
  state.ui[workspaceId] = ui;
  flush();
}
const execFileAsync = promisify(execFile);
const __dirnameESM = dirname(fileURLToPath(import.meta.url));
const T0 = Date.now();
const mark = (label) => {
  console.log(`[perf] ${label} +${Date.now() - T0}ms (uptime ${Math.round(process.uptime() * 1e3)}ms)`);
};
mark("main module evaluated");
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
let window = null;
let shellView = null;
let browserTabs = null;
let tmux = null;
const gitService = new GitService();
const shellWc = () => shellView && !shellView.webContents.isDestroyed() ? shellView.webContents : null;
function createWindow() {
  window = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#1e1e1e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"
  });
  shellView = new WebContentsView({
    webPreferences: {
      preload: join(__dirnameESM, "../preload/index.cjs"),
      // .cjs, never .mjs — see vite config
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });
  window.contentView.addChildView(shellView);
  layoutShell();
  window.on("resize", layoutShell);
  window.on("focus", focusActiveView);
  browserTabs = new BrowserTabs(window, shellWc);
  tmux = new TmuxManager(shellWc);
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  shellView.webContents.once("did-finish-load", () => {
    mark("shell did-finish-load");
    window?.show();
    focusActiveView();
    if (process.env.ONESTOP_SMOKE === "terminal") void runTerminalSmoke();
    else if (process.env.ONESTOP_SMOKE) void runSmokeTest();
  });
  shellView.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[shell] did-fail-load ${code} ${desc} ${url}`);
    window?.show();
  });
  shellView.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error(`[shell] preload-error ${preloadPath}:`, error);
  });
  shellView.webContents.on("render-process-gone", (_e, details) => {
    console.error("[shell] render-process-gone", details);
  });
  shellView.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      console.error(`[shell:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  shellView.webContents.on("did-start-loading", () => mark("shell did-start-loading"));
  shellView.webContents.on("dom-ready", () => mark("shell dom-ready"));
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const indexHtml = join(__dirnameESM, "../renderer/index.html");
  const loading = devUrl ? shellView.webContents.loadURL(devUrl) : shellView.webContents.loadFile(indexHtml);
  loading.catch((err) => {
    console.error(`[shell] failed to load ${devUrl ?? indexHtml}:`, err);
    window?.show();
  });
}
async function runSmokeTest() {
  const wc = shellWc();
  if (!wc) {
    app.exit(1);
    return;
  }
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const report = await wc.executeJavaScript(
      `(async () => {
        const root = document.getElementById('root')
        const bridge = typeof window.onestop === 'object' && window.onestop !== null
        // Goes through the real preload bridge and the real IPC handler, so this also proves
        // PATH recovery worked: a packaged app launched from Finder starts with a PATH that
        // cannot see Homebrew.
        let platform = null
        try { platform = await window.onestop.invoke('app:getPlatformInfo') } catch (e) {
          platform = { error: String(e) }
        }
        return JSON.stringify({
          bridge,
          bridgeKeys: bridge ? Object.keys(window.onestop) : [],
          rootChildren: root ? root.children.length : -1,
          elements: document.querySelectorAll('*').length,
          tmux: platform,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
        })
      })()`,
      true
    );
    console.log("[smoke]", report, `shellFocused=${wc.isFocused()}`);
    const parsed = JSON.parse(report);
    const ok = parsed.bridge && parsed.rootChildren > 0 && parsed.tmux?.tmuxAvailable === true;
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[smoke] failed:", err);
    app.exit(1);
  }
}
async function runTerminalSmoke() {
  const wc = shellWc();
  if (!wc) {
    app.exit(1);
    return;
  }
  const log = (...a) => console.log("[smoke:terminal]", ...a);
  try {
    const result = await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, getTerminal, nextTabId } = window.__onestop
        const trail = []

        // The shell boots asynchronously (state load + platform probe) after did-finish-load.
        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch-workspace', trail })
        store.getState().setActiveWorkspace(scratch.id)

        const tabId = nextTabId()
        store.getState().openTab(scratch.id, {
          id: tabId, kind: 'terminal', title: 'e2e', pinned: false, windowId: null, paneId: null
        })
        trail.push('tab opened')

        // Wait for the pane to be created and bound to the xterm instance.
        let handle = null
        for (let i = 0; i < 120; i++) {
          await sleep(250)
          handle = getTerminal(tabId)
          if (handle && handle.paneId) break
        }
        if (!handle) return JSON.stringify({ ok: false, stage: 'no-xterm-instance', trail })
        if (!handle.paneId) return JSON.stringify({ ok: false, stage: 'pane-never-bound', trail })
        trail.push('pane ' + handle.paneId)

        const read = () => {
          const b = handle.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + String.fromCharCode(10)
          return out
        }

        // Did anything arrive from tmux at all? A shell prompt should have rendered by now.
        await sleep(800)
        const beforeLen = read().trim().length
        trail.push('output before typing: ' + beforeLen + ' chars')

        // Where the keyboard actually lands. xterm renders into its own textarea, and if that
        // is not focused — or if the onData subscription was lost — keystrokes go nowhere even
        // though the transport underneath is perfectly healthy.
        const active = document.activeElement
        const focused = !!(active && handle.element.contains(active))
        trail.push('focus inside terminal: ' + focused + ' (' + (active ? active.tagName.toLowerCase() : 'none') + ')')

        let onDataFired = 0
        const probe = handle.term.onData(() => { onDataFired++ })

        // term.input() drives the same path a real keypress does: it fires onData, which is what
        // the component subscribes to. Writing straight to the port would skip exactly the wiring
        // that was reported broken.
        handle.term.input('echo ONESTOP-E2E-$((6*7))' + String.fromCharCode(13), true)
        probe.dispose()
        trail.push('onData fired ' + onDataFired + 'x')
        if (onDataFired !== 1) {
          return JSON.stringify({ ok: false, stage: 'onData-not-1', trail })
        }

        for (let i = 0; i < 40; i++) {
          await sleep(250)
          if (read().includes('ONESTOP-E2E-42')) {
            return JSON.stringify({ ok: true, stage: 'echoed', trail })
          }
        }
        return JSON.stringify({
          ok: false, stage: 'no-echo', trail, tail: read().trim().slice(-300)
        })
      })()`,
      true
    );
    log(result);
    app.exit(JSON.parse(result).ok ? 0 : 1);
  } catch (err) {
    log("threw:", err);
    app.exit(1);
  }
}
function focusActiveView() {
  const browser = browserTabs?.focusVisible();
  if (!browser) shellWc()?.focus();
}
function layoutShell() {
  if (!window || !shellView) return;
  const { width, height } = window.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
}
app.whenReady().then(() => {
  mark("app ready");
  void ensureShellPath().then(() => mark("shell PATH resolved"));
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (!window) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  browserTabs?.destroyAll();
  tmux?.disposeAll();
  gitService.dispose();
});
app.on("login", (event, webContents, _details, authInfo, callback) => {
  const viewId = webContents ? browserTabs?.idFor(webContents) ?? null : null;
  if (!viewId) return;
  event.preventDefault();
  emit(shellWc(), "browser:authRequested", {
    viewId,
    requestId: `${Date.now()}`,
    host: authInfo.host,
    realm: authInfo.realm
  });
  callback();
});
function registerHandlers() {
  handle("app:getVersions", () => ({ ...process.versions }));
  handle("app:getPlatformInfo", async () => {
    await ensureShellPath();
    let tmuxVersion = null;
    try {
      const { stdout } = process.platform === "win32" ? await execFileAsync("wsl.exe", ["--", "tmux", "-V"]) : await execFileAsync("tmux", ["-V"]);
      tmuxVersion = stdout.trim();
    } catch {
      tmuxVersion = null;
    }
    return {
      platform: process.platform,
      tmuxAvailable: tmuxVersion !== null,
      tmuxVersion,
      homeDir: homedir()
    };
  });
  handle("state:load", () => loadState());
  handle("state:saveWorkspaces", ({ workspaces, activeWorkspaceId }) => {
    saveWorkspaces(workspaces, activeWorkspaceId);
  });
  handle("state:saveUi", ({ workspaceId, ui }) => {
    saveUi(workspaceId, ui);
  });
  handle("workspace:pickFolder", async () => {
    if (!window) return null;
    const res = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      message: "Add a folder to this workspace"
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  handle("workspace:probeFolder", async (path) => {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: path });
      return { isGitRepo: true, repoRoot: stdout.trim() };
    } catch {
      return { isGitRepo: false, repoRoot: null };
    }
  });
  handle("fs:list", (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const path = join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(path).isDirectory();
        } catch {
          continue;
        }
      }
      out.push({ path, name: e.name, isDir, ignored: false });
    }
    out.sort(
      (a, b) => a.isDir !== b.isDir ? a.isDir ? -1 : 1 : a.name.localeCompare(b.name, void 0, { sensitivity: "base" })
    );
    return out;
  });
  handle("fs:readFile", (path) => {
    const size = statSync(path).size;
    if (size > MAX_EDITABLE_BYTES) {
      return { content: "", truncated: true, tooLarge: true };
    }
    return { content: readFileSync(path, "utf8"), truncated: false, tooLarge: false };
  });
  handle("fs:writeFile", ({ path, content }) => {
    writeFileSync(path, content, "utf8");
  });
  handle("browser:create", ({ url, bounds }) => {
    if (!browserTabs) throw new Error("window not ready");
    return { viewId: browserTabs.create(url, bounds) };
  });
  handle("browser:destroy", ({ viewId }) => {
    browserTabs?.destroy(viewId);
  });
  handle("browser:setVisible", ({ viewId, visible }) => {
    if (visible) {
      browserTabs?.showOnly(viewId);
    } else {
      browserTabs?.setVisible(viewId, false);
      shellWc()?.focus();
    }
  });
  handle("browser:setBounds", ({ viewId, bounds }) => {
    browserTabs?.setBounds(viewId, bounds);
  });
  handle("browser:navigate", ({ viewId, url }) => {
    browserTabs?.navigate(viewId, url);
  });
  handle("browser:goBack", ({ viewId }) => {
    browserTabs?.goBack(viewId);
  });
  handle("browser:goForward", ({ viewId }) => {
    browserTabs?.goForward(viewId);
  });
  handle("browser:reload", ({ viewId }) => {
    browserTabs?.reload(viewId);
  });
  handle("browser:stop", ({ viewId }) => {
    browserTabs?.stop(viewId);
  });
  handle("browser:openDevTools", ({ viewId }) => {
    browserTabs?.openDevTools(viewId);
  });
  registerTmuxHandlers();
  registerScmHandlers();
}
function registerTmuxHandlers() {
  const mgr = () => {
    if (!tmux) throw new Error("window not ready");
    return tmux;
  };
  const requireClient = (workspaceId) => {
    const c = mgr().client(workspaceId);
    if (!c) throw new Error(`no tmux session for workspace ${workspaceId}`);
    return c;
  };
  handle("tmux:connect", async ({ workspaceId, sessionName, cwd }) => {
    await ensureShellPath();
    return mgr().connect(workspaceId, sessionName, cwd, 120, 30);
  });
  handle("tmux:disconnect", ({ workspaceId }) => {
    mgr().disconnect(workspaceId);
  });
  handle("tmux:listState", ({ workspaceId }) => mgr().listState(workspaceId));
  handle("tmux:newWindow", async ({ workspaceId, cwd }) => ({
    windowId: await requireClient(workspaceId).newWindow(cwd)
  }));
  handle("tmux:splitPane", async ({ workspaceId, paneId, direction }) => ({
    paneId: await requireClient(workspaceId).splitPane(paneId, direction)
  }));
  handle("tmux:killPane", async ({ workspaceId, paneId }) => {
    await requireClient(workspaceId).killPane(paneId);
  });
  handle("tmux:selectPane", async ({ workspaceId, paneId }) => {
    await requireClient(workspaceId).selectPane(paneId);
  });
  handle("tmux:resizeClient", ({ workspaceId, cols, rows }) => {
    const client = mgr().client(workspaceId);
    const windowId = mgr().listState(workspaceId).windows.find((w) => w.active)?.id;
    if (client && windowId) client.resizeWindow(windowId, cols, rows);
  });
  handle("terminal:requestPort", ({ workspaceId }) => {
    mgr().establishPort(workspaceId);
  });
}
function registerScmHandlers() {
  handle("scm:status", ({ repoRoot }) => gitService.status(repoRoot));
  handle("scm:statusAll", ({ repoRoots }) => gitService.statusAll(repoRoots));
  handle("scm:diff", ({ repoRoot, path, against }) => gitService.diff(repoRoot, path, against));
  handle("scm:stage", ({ repoRoot, paths }) => gitService.stage(repoRoot, paths));
  handle("scm:unstage", ({ repoRoot, paths }) => gitService.unstage(repoRoot, paths));
  handle("scm:discard", ({ repoRoot, paths }) => gitService.discard(repoRoot, paths));
  handle("scm:commit", ({ repoRoot, message, amend }) => gitService.commit(repoRoot, message, amend));
  handle(
    "scm:watch",
    ({ repoRoots }) => gitService.watch(repoRoots, (status) => emit(shellWc(), "scm:status", { status }))
  );
}
//# sourceMappingURL=index.js.map
