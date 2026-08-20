import { gitApi } from "../api/git";
import type { TranscriptItem } from "./agentSessionStore";
import type { ReviewFile, StatusKind } from "../types/git";

type ToolItem = Extract<TranscriptItem, { kind: "toolCall" }>;
type TurnComplete = Extract<TranscriptItem, { kind: "turnComplete" }>;
type Candidate = { item?: ToolItem; added: number; removed: number; kind?: StatusKind };
const EDIT_TOOL = /(edit|write|create|delete|remove|patch|move|rename)/i;

function candidatePaths(item: ToolItem, root: string): string[] {
  if (!EDIT_TOOL.test(item.name) || item.result?.isError) return [];
  const paths = new Set<string>();
  function add(value: string) {
    for (const match of value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
      paths.add(match[1].trim());
    if (!value.includes("\n") && !value.includes("\0") && value.length < 500) paths.add(value);
  }
  function walk(value: unknown, key = "") {
    if (typeof value === "string") {
      if (/(?:^|_)(?:file_?)?path$/i.test(key) || /patch|diff/i.test(key)) add(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, key));
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) =>
        walk(child, childKey),
      );
    }
  }
  walk(item.input);
  return [...paths]
    .map((path) => {
      const normalized = path.replace(/\\/g, "/");
      const rootNormalized = root.replace(/\\/g, "/").replace(/\/$/, "");
      return normalized.startsWith(`${rootNormalized}/`)
        ? normalized.slice(rootNormalized.length + 1)
        : normalized.replace(/^\.\//, "");
    })
    .filter((path) => path && !path.startsWith("/") && !path.startsWith("../"));
}

function inferredKind(item?: ToolItem): StatusKind {
  if (!item) return { kind: "modified" };
  if (/delete|remove/i.test(item.name)) return { kind: "deleted" };
  if (/create|write/i.test(item.name)) return { kind: "added" };
  return { kind: "modified" };
}

/** What a turn (any span of transcript items ending in a `turnComplete`)
 * changed, as a set of `ReviewFile`s — filtered to paths still reported
 * live by `git status` (`"unstaged"`/`"staged"` mode), plus whatever a
 * commit made during the turn actually touched (`"commit"` mode). Tool-
 * call-inferred paths (`candidatePaths`) are unioned with the live status
 * diff, which is what catches changes a tool didn't directly report —
 * hooks, background writes, anything outside the traced call.
 *
 * Extracted out of `FileChangeReceipt.tsx` (which used to compute this
 * inline, tied to its own `useEffect`/`useState`) so `AgentChangesPanel.tsx`
 * — which needs the same answer for every turn across every agent tab in a
 * worktree, not just the one turn a chat message belongs to — calls the
 * exact same logic rather than a second, independently-drifting copy of
 * the same heuristic. */
export async function computeTurnFileChanges(
  worktreeRoot: string,
  items: TranscriptItem[],
): Promise<ReviewFile[]> {
  const candidates = new Map<string, Candidate>();
  for (const raw of items) {
    if (raw.kind !== "toolCall" || !raw.result || raw.result.isError) continue;
    for (const path of candidatePaths(raw, worktreeRoot)) {
      const previous = candidates.get(path);
      candidates.set(path, {
        item: raw,
        added: (previous?.added ?? 0) + (raw.result.diffAdded ?? 0),
        removed: (previous?.removed ?? 0) + (raw.result.diffRemoved ?? 0),
      });
    }
  }

  let completion: TurnComplete | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "turnComplete") {
      completion = item;
      break;
    }
  }

  const [status, commits] = await Promise.all([
    gitApi.getWorkingStatus(worktreeRoot),
    gitApi.getCommitLog(worktreeRoot, 1, 0),
  ]);
  const head = commits[0]?.hash;
  const combined = new Map(candidates);
  const baselinePaths = new Set(completion?.baselinePaths ?? []);
  for (const entry of status.entries) {
    if (!baselinePaths.has(entry.path) && !combined.has(entry.path)) {
      combined.set(entry.path, {
        added: 0,
        removed: 0,
        kind: entry.unstaged ?? entry.staged ?? { kind: "modified" },
      });
    }
  }
  if (completion?.baselineHead && head && completion.baselineHead !== head) {
    const committed = await gitApi.getCommitFiles(worktreeRoot, head);
    for (const [path, kind] of committed) {
      if (!combined.has(path)) combined.set(path, { added: 0, removed: 0, kind });
    }
  }

  return [...combined]
    .map(([path, value]) => {
      const current = status.entries.find((entry) => entry.path === path);
      const mode = current?.unstaged ? "unstaged" : current?.staged ? "staged" : "commit";
      const kind = current?.unstaged ?? current?.staged ?? value.kind ?? inferredKind(value.item);
      return {
        path,
        kind,
        mode,
        commitHash: mode === "commit" ? head : undefined,
        added: value.added,
        removed: value.removed,
      } as ReviewFile;
    })
    .filter((file) => file.mode !== "commit" || !!file.commitHash);
}
