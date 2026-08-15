import { describe, expect, it } from "vitest";
import {
  filterProcesses,
  formatCpu,
  formatUptime,
  groupProcesses,
  worktreeLabel,
} from "./processRows";
import type { ManagedProcess, ManagedProcessKind, ManagedProcessStatus } from "../../types/process";

function process(
  overrides: Partial<ManagedProcess> & { id: string; kind: ManagedProcessKind },
): ManagedProcess {
  return {
    label: overrides.id,
    detail: null,
    worktreeId: null,
    worktreeRoot: null,
    tabId: null,
    pid: 100,
    startedAtMs: 0,
    status: "running" as ManagedProcessStatus,
    cpuPercent: 0,
    memoryBytes: 0,
    childProcessCount: 0,
    killable: true,
    ...overrides,
  };
}

describe("formatUptime", () => {
  it("shows plain seconds under a minute", () => {
    expect(formatUptime(0, 12_000)).toBe("12s");
  });

  it("zero-pads the seconds component of a minutes reading", () => {
    expect(formatUptime(0, 4 * 60_000 + 5_000)).toBe("4m 05s");
  });

  it("switches to hours and minutes past an hour", () => {
    expect(formatUptime(0, 3 * 3_600_000 + 7 * 60_000)).toBe("3h 07m");
  });

  it("switches to days and hours past a day", () => {
    expect(formatUptime(0, 2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
  });

  it("never reports negative uptime for a clock that jumped backwards", () => {
    expect(formatUptime(10_000, 0)).toBe("0s");
  });
});

describe("formatCpu", () => {
  it("keeps one decimal below ten percent and drops it above", () => {
    expect(formatCpu(4.25)).toBe("4.3%");
    expect(formatCpu(43.4)).toBe("43%");
  });

  it("distinguishes genuinely idle from merely tiny", () => {
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(0.04)).toBe("<0.1%");
  });
});

describe("worktreeLabel", () => {
  it("uses the last path segment", () => {
    expect(worktreeLabel("/home/dev/project/.worktrees/feature-x")).toBe("feature-x");
  });

  it("tolerates a trailing slash and a missing path", () => {
    expect(worktreeLabel("/home/dev/project/")).toBe("project");
    expect(worktreeLabel(null)).toBe("—");
  });
});

describe("groupProcesses", () => {
  it("orders groups agent-first and drops empty ones", () => {
    const groups = groupProcesses([
      process({ id: "lsp", kind: "languageServer" }),
      process({ id: "term", kind: "terminal" }),
      process({ id: "agent", kind: "agent" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["agent", "terminal", "languageServer"]);
  });

  it("sorts running above idle, then newest first", () => {
    const groups = groupProcesses([
      process({ id: "idle-new", kind: "agent", status: "idle", startedAtMs: 50 }),
      process({ id: "run-old", kind: "agent", startedAtMs: 10 }),
      process({ id: "run-new", kind: "agent", startedAtMs: 30 }),
    ]);
    expect(groups[0].processes.map((p) => p.id)).toEqual(["run-new", "run-old", "idle-new"]);
  });

  it("counts only live children in runningCount", () => {
    const groups = groupProcesses([
      process({ id: "a", kind: "agent" }),
      process({ id: "b", kind: "agent", status: "idle" }),
      process({ id: "c", kind: "agent", status: "exited" }),
    ]);
    expect(groups[0].runningCount).toBe(1);
    expect(groups[0].processes).toHaveLength(3);
  });
});

describe("filterProcesses", () => {
  const rows = [
    process({ id: "a", kind: "agent", label: "Claude Code", detail: "session abc123" }),
    process({ id: "b", kind: "terminal", label: "fish", pid: 4242 }),
    process({
      id: "c",
      kind: "languageServer",
      label: "Rust",
      worktreeRoot: "/repo/.worktrees/feature-x",
    }),
  ];

  it("returns everything for a blank query", () => {
    expect(filterProcesses(rows, "   ")).toHaveLength(3);
  });

  it("matches label, detail, pid and worktree path case-insensitively", () => {
    expect(filterProcesses(rows, "claude").map((p) => p.id)).toEqual(["a"]);
    expect(filterProcesses(rows, "abc123").map((p) => p.id)).toEqual(["a"]);
    expect(filterProcesses(rows, "4242").map((p) => p.id)).toEqual(["b"]);
    expect(filterProcesses(rows, "FEATURE-X").map((p) => p.id)).toEqual(["c"]);
  });
});
