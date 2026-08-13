import { readFile } from "node:fs/promises";
import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AgentStatus } from "../contracts.ts";
import type { ChildRecord, CollaborationRegistry } from "../registry.ts";
import type { BoundedMonitorBuffer, NormalizedMonitorEvent } from "./model.ts";

export const COLLABORATION_WIDGET_KEY = "collaboration-agents";
const REDRAW_THROTTLE_MS = 100;

function matchesKey(data: string, key: "escape" | "ctrl+c" | "up" | "down"): boolean {
  switch (key) {
    case "escape": return data === "\u001b";
    case "ctrl+c": return data === "\u0003";
    case "up": return data === "\u001b[A";
    case "down": return data === "\u001b[B";
  }
}

function terminalCellWidth(character: string): number {
  if (/^[\p{Mark}\p{Cf}]$/u.test(character)) return 0;
  const point = character.codePointAt(0) ?? 0;
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

/** ANSI-safe, display-cell-aware truncation without importing Pi's runtime in tests. */
export function truncateTerminalLine(value: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  let cells = 0;
  let index = 0;
  let sawAnsi = false;
  while (index < value.length) {
    if (value.charCodeAt(index) === 0x1b) {
      const match = /^\u001b\[[0-?]*[ -/]*[@-~]/u.exec(value.slice(index));
      if (match) {
        result += match[0];
        index += match[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const character = String.fromCodePoint(value.codePointAt(index)!);
    const characterWidth = terminalCellWidth(character);
    if (cells + characterWidth > width) break;
    result += character;
    cells += characterWidth;
    index += character.length;
  }
  return index < value.length && sawAnsi ? `${result}\u001b[0m` : result;
}

function statusLabel(status: AgentStatus): string {
  if (typeof status === "object" && "completed" in status) return "completed";
  if (typeof status === "object" && "errored" in status) return "errored";
  return status;
}

function elapsedLabel(record: Readonly<ChildRecord<BoundedMonitorBuffer>>, now: number): string {
  if (record.status !== "running" && record.status !== "pending_init") return "";
  const started = record.turnStartedAt ?? record.createdAt;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function renderWidgetLines(
  registry: CollaborationRegistry<BoundedMonitorBuffer>,
  now = Date.now(),
): string[] | undefined {
  const children = registry.children();
  if (children.length === 0) return undefined;
  return [
    "Collaboration",
    ...children.map((record) => {
      const elapsed = elapsedLabel(record, now);
      return `  ${record.canonicalPath}  ${statusLabel(record.status)}${elapsed ? ` ${elapsed}` : ""}${record.lastActivity ? ` · ${record.lastActivity}` : ""}`;
    }),
  ];
}

export interface CollaborationUiController {
  dispose(): void;
  refresh(): void;
}

export function installCollaborationUi(
  ctx: ExtensionContext,
  registry: CollaborationRegistry<BoundedMonitorBuffer>,
): CollaborationUiController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const draw = () => {
    if (disposed) return;
    ctx.ui.setWidget(COLLABORATION_WIDGET_KEY, renderWidgetLines(registry), { placement: "aboveEditor" });
    const hasActive = registry.children().some((record) => record.status === "running" || record.status === "pending_init");
    if (hasActive && elapsedTimer === undefined) {
      elapsedTimer = setInterval(draw, 1_000);
    } else if (!hasActive && elapsedTimer !== undefined) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  };

  const refresh = () => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      draw();
    }, REDRAW_THROTTLE_MS);
  };
  const unsubscribe = registry.subscribe(refresh);
  draw();

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (elapsedTimer) clearInterval(elapsedTimer);
      ctx.ui.setWidget(COLLABORATION_WIDGET_KEY, undefined);
    },
  };
}

function eventText(event: NormalizedMonitorEvent): string[] {
  switch (event.kind) {
    case "assistant_text":
      return event.text.split("\n");
    case "assistant_message":
      return event.phase === "end"
        ? event.message.content.flatMap((block) =>
            block.type === "text" ? block.text.split("\n") : [`→ ${block.name} ${JSON.stringify(block.arguments)}`],
          )
        : [];
    case "tool":
      return [
        `${event.phase === "start" ? "→" : event.phase === "end" ? (event.isError ? "✗" : "✓") : "  "} ${event.toolName}${event.arguments === undefined ? "" : ` ${JSON.stringify(event.arguments)}`}${event.output === undefined ? "" : `: ${JSON.stringify(event.output)}`}`,
      ];
    case "error":
      return [`Error: ${event.message}`];
    case "usage":
      return [`Usage: ${JSON.stringify(event.usage)}`];
    case "activity":
      return [`Activity: ${event.activity}`];
    case "final":
      return [
        `Final: ${JSON.stringify(event.status)}${event.summary ? ` — ${event.summary}` : ""}${event.fullAnswerFile ? ` · full answer: ${event.fullAnswerFile}` : ""}`,
      ];
    case "notice":
      return [event.message];
    default:
      return [JSON.stringify(event)];
  }
}

class TranscriptComponent implements Component {
  private events: NormalizedMonitorEvent[] = [];
  private eventBytes: number[] = [];
  private totalEventBytes = 0;
  private pinnedTerminalSequence: number | undefined;
  private cursor = 0;
  private scroll = 0;
  private unsubscribe: (() => void) | undefined;
  private artifactState:
    | { kind: "idle" }
    | { kind: "loading"; path: string }
    | { kind: "loaded"; path: string; text: string }
    | { kind: "error"; path: string; message: string } = { kind: "idle" };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly record: Readonly<ChildRecord<BoundedMonitorBuffer>>,
    private readonly done: () => void,
    private readonly interrupt: () => Promise<void>,
    private readonly readTextFile: (path: string) => Promise<string>,
  ) {
    this.refreshEvents();
    this.unsubscribe = this.record.monitor.subscribe(() => {
      this.refreshEvents();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.scroll += 1;
      this.tui.requestRender();
      return;
    }
    if (data === "i" || data === "I") {
      void this.interrupt();
      return;
    }
    if (data === "f" || data === "F") {
      void this.loadFullAnswer();
    }
  }

  render(width: number): string[] {
    const artifactHint = this.record.finalAnswerFile ? " · f full answer" : "";
    const artifactLines = this.renderArtifact();
    const lines = [
      this.theme.fg("accent", `Agents · ${this.record.canonicalPath}`),
      this.theme.fg("muted", `Status: ${statusLabel(this.record.status)} · Esc close · ↑/↓ scroll · i interrupt${artifactHint}`),
      "",
      ...this.events.flatMap(eventText),
      ...artifactLines,
    ];
    const available = Math.max(4, (process.stdout.rows ?? 30) - 6);
    const maxScroll = Math.max(0, lines.length - available);
    this.scroll = Math.min(this.scroll, maxScroll);
    return lines.slice(this.scroll, this.scroll + available).map((line) => truncateTerminalLine(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private refreshEvents(): void {
    const page = this.record.monitor.getSince(this.cursor);
    for (const event of page.events) {
      if (event.kind === "activity" && event.activity === "agent started") {
        this.pinnedTerminalSequence = undefined;
      }
      if (event.kind === "final" || (event.kind === "notice" && event.terminal)) {
        this.pinnedTerminalSequence = event.sequence;
      }
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      this.events.push(event);
      this.eventBytes.push(bytes);
      this.totalEventBytes += bytes;
    }
    this.cursor = page.nextCursor;
    this.trimEvents();
  }

  private trimEvents(): void {
    while (
      this.events.length > this.record.monitor.maxEvents ||
      this.totalEventBytes > this.record.monitor.maxBytes
    ) {
      let index = this.events.findIndex(
        (event) => event.sequence !== this.pinnedTerminalSequence,
      );
      if (index === -1) index = 0;
      const [removedBytes] = this.eventBytes.splice(index, 1);
      const [removedEvent] = this.events.splice(index, 1);
      this.totalEventBytes -= removedBytes ?? 0;
      if (removedEvent?.sequence === this.pinnedTerminalSequence) {
        this.pinnedTerminalSequence = undefined;
      }
    }
  }

  private async loadFullAnswer(): Promise<void> {
    const path = this.record.finalAnswerFile;
    if (!path || (this.artifactState.kind === "loading" && this.artifactState.path === path)) return;
    if (this.artifactState.kind === "loaded" && this.artifactState.path === path) return;
    this.artifactState = { kind: "loading", path };
    this.tui.requestRender();
    try {
      const text = await this.readTextFile(path);
      if (this.artifactState.kind !== "loading" || this.artifactState.path !== path) return;
      this.artifactState = { kind: "loaded", path, text };
    } catch (error) {
      if (this.artifactState.kind !== "loading" || this.artifactState.path !== path) return;
      this.artifactState = {
        kind: "error",
        path,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.tui.requestRender();
  }

  private renderArtifact(): string[] {
    switch (this.artifactState.kind) {
      case "idle":
        return [];
      case "loading":
        return ["", this.theme.fg("muted", `Loading full answer from ${this.artifactState.path}…`)];
      case "error":
        return ["", this.theme.fg("error", `Unable to read ${this.artifactState.path}: ${this.artifactState.message}`)];
      case "loaded":
        return [
          "",
          this.theme.fg("accent", `Full answer · ${this.artifactState.path}`),
          ...this.artifactState.text.split("\n"),
        ];
    }
  }
}

export interface ShowAgentsCommandOptions {
  /** Injectable solely for deterministic TUI tests; never enters model context. */
  readTextFile?: (absolutePath: string) => Promise<string>;
}

export async function showAgentsCommand(
  ctx: ExtensionCommandContext,
  registry: CollaborationRegistry<BoundedMonitorBuffer>,
  options: ShowAgentsCommandOptions = {},
): Promise<void> {
  if (ctx.mode !== "tui") return;
  const children = registry.children();
  if (children.length === 0) {
    ctx.ui.notify("No collaboration children are registered.", "info");
    return;
  }
  const choices = children.map(
    (record) => `${record.canonicalPath}  [${statusLabel(record.status)}]`,
  );
  const choice = await ctx.ui.select("Inspect collaboration agent", choices);
  if (!choice) return;
  const index = choices.indexOf(choice);
  const record = children[index];
  if (!record) return;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const interrupt = async () => {
      try {
        const active = record.status === "running" || record.status === "pending_init";
        if (!active) {
          ctx.ui.notify(`${record.canonicalPath} is not running.`, "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Interrupt child?",
          `Interrupt ${record.canonicalPath}? Shared-file changes will not be reverted.`,
        );
        if (confirmed) await registry.interruptAgent(record.canonicalPath);
      } catch (error) {
        ctx.ui.notify(
          `Unable to interrupt ${record.canonicalPath}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        tui.requestRender();
      }
    };
    const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
    return new TranscriptComponent(tui, theme, record, () => done(), interrupt, readTextFile);
  });
}
