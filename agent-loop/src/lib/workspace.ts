// The code the agent works on, behind one interface with two backends:
// - local: the git repo in workspace/; a commit is a git commit.
// - sandbox: no disk, no git. The files are a map held in step state; a
//   "commit" is a content hash and the best result carries the files.
// Every method marked "in a step" must run inside step.run; the others rebuild
// state from those steps' memoized results, so a replay ends up identical.
import { backend, filesRef, templateFiles, type Backend, type Files } from "./backend.js";
import { localFsStore, memoryStore, type FileStore } from "./file-store.js";
import { commitAll, headMessage, headSha, isDirty, resetHard } from "./git.js";

/** A point the workspace can be at: a commit (or content hash) and, in the sandbox, its files. */
export type At = { commit: string; files?: Files };
export type Committed = { commit: string; changed: boolean; files?: Files };
/** The memoized result of an attempt's prepare step. */
export type Prepared = { reset: string; code?: Files } | { seed: Files };

/** One attempt's view of the workspace, starting from `start`. */
export interface AttemptWorkspace {
  /** In a step: put the workspace at the start point (reset or seed). */
  prepare(): Promise<Prepared>;
  /** From the prepare step's result: the code the attempt starts from. */
  begin(prepared: Prepared): Files | undefined;
  /** In a tool step: what the tools read and write. */
  store(): FileStore;
  /** From a tool step's result: the files it wrote. */
  apply(changed: Files | undefined): void;
  /** In a step: record the attempt's result; idempotent across retries. */
  commit(i: number, summary: string): Promise<Committed>;
}

export interface Workspace {
  /** In a step (goal-loop baseline): where the workspace is before any attempt. */
  initial(): Promise<At>;
  /** In a step: put the workspace back at `commit`; null when attempts can't leave it elsewhere. */
  revert: ((commit: string) => Promise<void>) | null;
  attempt(start: At): AttemptWorkspace;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

// Every .ts file under src/, keyed by its path relative to src/.
async function snapshot(store: FileStore): Promise<Files> {
  const out: Files = {};
  for (const p of (await store.list()).filter((f) => f.endsWith(".ts")).sort()) {
    const g = await store.resolve(p, false);
    if ("key" in g) out[p] = await store.read(g.key);
  }
  return out;
}

const local: Workspace = {
  initial: async () => ({ commit: await headSha() }),
  revert: (commit) => resetHard(commit),
  attempt: (start) => ({
    async prepare() {
      await resetHard(start.commit);
      // Read after the reset, inside the step, so a replay sees the same text.
      return { reset: start.commit, code: await snapshot(localFsStore) };
    },
    begin: (prepared) => ("code" in prepared ? prepared.code : undefined),
    store: () => localFsStore,
    apply: () => {}, // the tools wrote to disk already
    async commit(i, summary) {
      const prefix = `attempt ${i}: `;
      const head = await headSha();
      // Idempotent retry: a previous try already committed this attempt.
      if (head !== start.commit && (await headMessage()).startsWith(prefix) && !(await isDirty())) {
        return { commit: head, changed: true };
      }
      if (await isDirty()) {
        const commit = await commitAll(prefix + oneLine(summary, 120));
        return { commit, changed: true };
      }
      return { commit: start.commit, changed: false };
    },
  }),
};

const sandbox: Workspace = {
  // The stub source from the template; there is no workspace repo.
  initial: async () => {
    const files = templateFiles();
    return { commit: filesRef(files), files };
  },
  // Every attempt is seeded from the best's files, so there's nothing to revert.
  revert: null,
  attempt: (start) => {
    // Seeded from the prepare step and updated only from tool-step results,
    // never mutated inside a step, so replay rebuilds it exactly.
    const files = new Map<string, string>();
    return {
      prepare: async () => ({ seed: start.files ?? {} }),
      begin(prepared) {
        for (const [p, c] of Object.entries("seed" in prepared ? prepared.seed : {})) files.set(p, c);
        return Object.fromEntries(files);
      },
      store: () => memoryStore(Object.fromEntries(files)),
      apply(changed) {
        for (const [p, c] of Object.entries(changed ?? {})) files.set(p, c);
      },
      async commit() {
        const out = Object.fromEntries(files);
        const commit = filesRef(out);
        return { commit, changed: commit !== start.commit, files: out };
      },
    };
  },
};

/** The workspace for this worker's WORKSPACE_BACKEND. */
export const workspace = (kind: Backend = backend()): Workspace => (kind === "sandbox" ? sandbox : local);
