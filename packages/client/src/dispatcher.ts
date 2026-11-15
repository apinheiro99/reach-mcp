// Executes Server requests on this host. The active project policy is whatever the Server last sent and every root
// passed the local anchors; this module adds no policy of its own. Reads run at once; mutations of one project run
// one at a time in arrival order, and a mutation that outlives its response deadline is reported indeterminate but
// keeps its place in the queue until it really settles. Nothing is ever replayed.
import { existsSync } from "node:fs";
import path from "node:path";
import { createGitCompat, type GitInspector } from "../../legacy/git-compat/src/index.ts";
import { FilesystemReader, FilesystemWriter, FsError, HOST_PLATFORM, readPdf, type PathPlatform, type PdfReadResult } from "../../shared/src/filesystem/index.ts";
import {
  EffectiveProjectPolicy,
  failureResponse,
  isMutation,
  MUTATION_INDETERMINATE_ERROR,
  parseWire,
  ResponseEnvelope,
  toWireError,
  type Operation,
  type OperationResult,
  type PolicySync,
  type RequestEnvelope,
  WireFault,
} from "../../shared/src/wire/index.ts";
import { acceptEffectivePolicy } from "./root-anchors.ts";
import { realSchedule, type Schedule } from "../../shared/src/timers.ts";

type Async<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : T[K] };

/** What the dispatcher needs from one project. Tests substitute slow or recording implementations. */
export type ProjectRuntime = {
  reader: Async<Pick<FilesystemReader, "list" | "find" | "read" | "search" | "readImage">>;
  writer: Async<Pick<FilesystemWriter, "write" | "edit" | "remove">> | null;
  git: Async<Pick<GitInspector, "status" | "diff" | "log" | "show">> | null;
  pdf: (path: string, options: { startPage?: number; maxPages?: number }) => Promise<PdfReadResult>;
};

export type DispatcherOptions = {
  /** Canonical local root anchors from the bootstrap. */
  anchors: readonly string[];
  /** How long a caller waits for a mutation before it is told the outcome is unknown. */
  mutationTimeoutMs?: number;
  schedule?: Schedule;
  platform?: PathPlatform;
  createRuntime?: (policy: EffectiveProjectPolicy) => ProjectRuntime;
};

const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;

/** The real primitives for one accepted policy. A read_only project never gets a writer. */
export function buildRuntime(policy: EffectiveProjectPolicy): ProjectRuntime {
  const common = { root: policy.physical_root, limits: policy.limits, extraDenyGlobs: policy.deny_globs };
  const reader = new FilesystemReader(common);
  const writer = policy.mode === "read_write" ? new FilesystemWriter({ ...common, allowGlobs: policy.writable_globs }) : null;
  const git = existsSync(path.join(policy.physical_root, ".git")) ? createGitCompat({ enabled: true, root: policy.physical_root, extraDenyGlobs: policy.deny_globs }) : null;
  return { reader, writer, git, pdf: (input, options) => readPdf(reader, input, options) };
}

export class ClientDispatcher {
  #projects = new Map<string, { policy: EffectiveProjectPolicy; runtime: ProjectRuntime }>();
  /** Per project, the promise of its most recent mutation; a new mutation starts when it settles. */
  #tails = new Map<string, Promise<void>>();
  readonly #anchors: readonly string[];
  readonly #timeoutMs: number;
  readonly #schedule: Schedule;
  readonly #platform: PathPlatform;
  readonly #createRuntime: (policy: EffectiveProjectPolicy) => ProjectRuntime;

  constructor(options: DispatcherOptions) {
    this.#anchors = options.anchors;
    this.#timeoutMs = options.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) throw new RangeError("invalid mutation timeout");
    this.#schedule = options.schedule ?? realSchedule;
    this.#platform = options.platform ?? HOST_PLATFORM;
    this.#createRuntime = options.createRuntime ?? buildRuntime;
  }

  /** Project ids of the active snapshot. */
  projects(): string[] {
    return [...this.#projects.keys()];
  }

  /**
   * Replaces the whole active snapshot, or changes nothing: every policy must pass the local anchors, ids must be unique
   * and every runtime must build before the map is swapped in one step.
   */
  applyPolicy(frame: PolicySync): void {
    const next = new Map<string, { policy: EffectiveProjectPolicy; runtime: ProjectRuntime }>();
    for (const raw of frame.policies) {
      const policy = acceptEffectivePolicy(this.#anchors, raw, this.#platform);
      if (next.has(policy.project_id)) throw new WireFault("BAD_REQUEST", "duplicate project in policy snapshot");
      next.set(policy.project_id, { policy, runtime: this.#createRuntime(policy) });
    }
    this.#projects = next;
  }

  /** Always resolves with exactly one response carrying the request's own id. */
  async handle(request: RequestEnvelope): Promise<ResponseEnvelope> {
    const id = request.request_id;
    const project = this.#projects.get(request.project_id);
    if (!project) return failureResponse(id, { code: "NOT_FOUND", message: "unknown project" });
    const op = request.operation;
    try {
      if (!isMutation(op.op)) return this.#respond(id, await this.#execute(project.runtime, op));
      return await this.#mutate(id, request.project_id, op);
    } catch (err) {
      return failureResponse(id, toWireError(err));
    }
  }

  #respond(id: string, result: OperationResult): ResponseEnvelope {
    const parsed = parseWire(ResponseEnvelope, { kind: "response", request_id: id, ok: true, result });
    return parsed.ok ? parsed.data : failureResponse(id, { code: "INTERNAL", message: "internal error" });
  }

  /** Queues the real operation; the caller-facing deadline never touches the queue. */
  #mutate(id: string, project: string, op: Operation): Promise<ResponseEnvelope> {
    const previous = this.#tails.get(project) ?? Promise.resolve();
    const run = previous.then(() => this.#executeMutation(project, op));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(project, tail);
    void tail.then(() => {
      if (this.#tails.get(project) === tail) this.#tails.delete(project);
    });
    return new Promise<ResponseEnvelope>((resolve) => {
      const cancel = this.#schedule(() => resolve(failureResponse(id, MUTATION_INDETERMINATE_ERROR)), this.#timeoutMs);
      run.then(
        (result) => {
          cancel();
          resolve(this.#respond(id, result));
        },
        (err: unknown) => {
          cancel();
          resolve(failureResponse(id, toWireError(err)));
        },
      );
    });
  }

  /** Runs when the mutation's turn starts, under the policy active right now, never the one seen when it was queued. */
  async #executeMutation(projectId: string, op: Operation): Promise<OperationResult> {
    const project = this.#projects.get(projectId);
    if (!project) throw new FsError("NOT_FOUND", "unknown project");
    if (project.policy.mode !== "read_write") throw new FsError("DENIED", "project is read-only");
    return this.#execute(project.runtime, op);
  }

  async #execute(runtime: ProjectRuntime, op: Operation): Promise<OperationResult> {
    const { reader, writer, git } = runtime;
    switch (op.op) {
      case "fs_list":
        return { op: op.op, ...(await reader.list(op.path ?? "", op.depth ?? 1)) };
      case "fs_find":
        return { op: op.op, ...(await reader.find(op.pattern, op.path ?? "", op.limit)) };
      case "fs_read": {
        const r = await reader.read(op.path, op.start_line ?? 1, op.end_line);
        return { op: op.op, path: r.path, start_line: r.startLine, end_line: r.endLine, total_lines: r.totalLines, truncated: r.truncated, next_start_line: r.nextStartLine, redactions: r.redactions, content: r.content };
      }
      case "fs_search": {
        const r = await reader.search({ patterns: op.patterns, mode: op.mode, caseSensitive: op.case_sensitive, path: op.path, include: op.include, exclude: op.exclude, contextLines: op.context_lines, limit: op.limit });
        const { tooLarge, binary, secretContent: hidden } = r.filesSkipped;
        return {
          op: op.op,
          path: r.path,
          mode: r.mode,
          summary: r.summary,
          matches: r.matches,
          truncated: r.truncated,
          files_scanned: r.filesScanned,
          files_skipped: { too_large: tooLarge, binary, secret_content: hidden },
          stopped_by: r.stoppedBy,
        };
      }
      case "fs_read_image": {
        const r = await reader.readImage(op.path);
        return { op: op.op, path: r.path, mime_type: r.mimeType, bytes: r.bytes, width: r.width, height: r.height, data_base64: r.data.toString("base64") };
      }
      case "fs_read_pdf": {
        const r = await runtime.pdf(op.path, { startPage: op.start_page, maxPages: op.max_pages });
        return { op: op.op, path: r.path, total_pages: r.totalPages, start_page: r.startPage, end_page: r.endPage, pages: r.pages, has_text: r.hasText, redactions: r.redactions, truncated: r.truncated, next_page: r.nextPage };
      }
      case "fs_write": {
        const r = await writeable(writer).write(op.path, op.content, op.encoding ?? "utf8");
        return { op: op.op, path: r.path, bytes: r.bytes };
      }
      case "fs_edit": {
        const r = await writeable(writer).edit(op.path, op.old_text, op.new_text, op.replace_all ?? false);
        return { op: op.op, path: r.path, bytes: r.bytes, replacements: r.replacements };
      }
      case "fs_remove": {
        const r = await writeable(writer).remove(op.path);
        return { op: op.op, path: r.path, moved_to: r.movedTo };
      }
      case "git_status": {
        const r = await inspector(git).status();
        return { op: op.op, branch: r.branch, clean: r.clean, entries: r.entries, hidden_by_policy: r.hiddenByPolicy };
      }
      case "git_diff":
        return { op: op.op, ...(await inspector(git).diff({ base: op.base, head: op.head, staged: op.staged, paths: op.paths, stat: op.stat })) };
      case "git_log":
        return { op: op.op, ...(await inspector(git).log({ rev: op.rev, count: op.count, paths: op.paths })) };
      case "git_show":
        return { op: op.op, ...(await inspector(git).show({ rev: op.rev, paths: op.paths, stat: op.stat })) };
    }
  }
}

function writeable(writer: ProjectRuntime["writer"]): NonNullable<ProjectRuntime["writer"]> {
  if (!writer) throw new FsError("DENIED", "project is read-only");
  return writer;
}

function inspector(git: ProjectRuntime["git"]): NonNullable<ProjectRuntime["git"]> {
  if (!git) throw new FsError("NOT_FOUND", "project is not a Git repository");
  return git;
}
