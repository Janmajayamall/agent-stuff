import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FreshHistorySeeder } from "../src/history-seeder.ts";
import {
  allocateChildSession,
  FINAL_ANSWER_FILE_MODE,
  finalAnswerPathForSession,
  removeFailedChildSession,
  resolveChildSessionPath,
  SESSION_FILE_MODE,
  SessionFileCollisionError,
  writeFinalAnswerArtifact,
} from "../src/session-paths.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true }));
  }
});

describe("child session storage", () => {
  it("resolves the persisted-root layout beside the root session", async () => {
    const sandbox = await createSandbox();
    const allocation = resolveChildSessionPath({
      rootSessionFile: join(sandbox, "project", "root.jsonl"),
      rootSessionId: "root-session-1",
      taskName: "tests",
      childId: "child-uuid",
    });

    expect(allocation).toEqual({
      sessionDirectory: join(sandbox, "project", "collaboration", "root-session-1", "tests"),
      sessionFile: join(
        sandbox,
        "project",
        "collaboration",
        "root-session-1",
        "tests",
        "child-uuid.jsonl",
      ),
      finalAnswerFile: join(
        sandbox,
        "project",
        "collaboration",
        "root-session-1",
        "tests",
        "child-uuid.final.txt",
      ),
    });
  });

  it("uses injected Pi agent-dir support for a no-session root", async () => {
    const sandbox = await createSandbox();
    const allocation = resolveChildSessionPath(
      {
        rootSessionFile: undefined,
        rootSessionId: "root-session-2",
        taskName: "review",
        childId: "child-2",
      },
      { getAgentDirectory: () => join(sandbox, "agent") },
    );

    expect(allocation.sessionFile).toBe(
      join(
        sandbox,
        "agent",
        "collaboration",
        "sessions",
        "root-session-2",
        "review",
        "child-2.jsonl",
      ),
    );
    expect(() =>
      resolveChildSessionPath({
        rootSessionFile: undefined,
        rootSessionId: "root-session-2",
        taskName: "review",
        childId: "child-2",
      }),
    ).toThrow(/getAgentDirectory is required/);
  });

  it("rejects unsafe path segments", async () => {
    const sandbox = await createSandbox();
    const base = {
      rootSessionFile: join(sandbox, "root.jsonl"),
      rootSessionId: "root-id",
      taskName: "tests",
      childId: "child-id",
    };

    expect(() => resolveChildSessionPath({ ...base, taskName: "../escape" })).toThrow(/taskName/);
    expect(() => resolveChildSessionPath({ ...base, rootSessionId: "../escape" })).toThrow(
      /rootSessionId/,
    );
    expect(() => resolveChildSessionPath({ ...base, childId: "child/path" })).toThrow(/childId/);
    expect(() => resolveChildSessionPath({ ...base, rootSessionFile: "" })).toThrow(/rootSessionFile/);
  });

  it("exclusively creates an empty owner-only JSONL and never overwrites it", async () => {
    const sandbox = await createSandbox();
    const request = {
      rootSessionFile: join(sandbox, "sessions", "root.jsonl"),
      rootSessionId: "root-id",
      taskName: "tests",
      childId: "child-id",
    };

    const allocation = await allocateChildSession(request);
    expect(await readFile(allocation.sessionFile, "utf8")).toBe("");
    expect((await stat(allocation.sessionFile)).mode & 0o777).toBe(SESSION_FILE_MODE);

    await writeFile(allocation.sessionFile, "durable child history", "utf8");
    await expect(allocateChildSession(request)).rejects.toBeInstanceOf(SessionFileCollisionError);
    expect(await readFile(allocation.sessionFile, "utf8")).toBe("durable child history");
  });

  it("removes only a failed pre-start allocation and is idempotent", async () => {
    const sandbox = await createSandbox();
    const sibling = join(sandbox, "sessions", "keep.txt");
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(sibling, "keep", "utf8");
    const allocation = await allocateChildSession({
      rootSessionFile: join(sandbox, "sessions", "root.jsonl"),
      rootSessionId: "root-id",
      taskName: "tests",
      childId: "failed-child",
    });

    await removeFailedChildSession(allocation);
    await removeFailedChildSession(allocation);
    await expect(readFile(allocation.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe("keep");
  });

  it("reuses the exact same path for follow-up turns without reallocating", async () => {
    const sandbox = await createSandbox();
    const allocation = await allocateChildSession({
      rootSessionFile: join(sandbox, "root.jsonl"),
      rootSessionId: "root-id",
      taskName: "tests",
      childId: "persistent-child",
    });
    await writeFile(allocation.sessionFile, "turn one\n", "utf8");

    const reopenedPath = resolveChildSessionPath({
      rootSessionFile: join(sandbox, "root.jsonl"),
      rootSessionId: "root-id",
      taskName: "tests",
      childId: "persistent-child",
    }).sessionFile;

    expect(reopenedPath).toBe(allocation.sessionFile);
    expect(await readFile(reopenedPath, "utf8")).toBe("turn one\n");
  });
});

describe("full-answer artifact", () => {
  it("writes complete Unicode text atomically with owner-only permissions", async () => {
    const sandbox = await createSandbox();
    const sessionFile = join(sandbox, "child.jsonl");
    const answer = "Complete answer: 👩🏽‍💻 — नमस्ते — こんにちは\n".repeat(100);

    const answerFile = await writeFinalAnswerArtifact(sessionFile, answer, {
      createTemporaryId: () => "deterministic-temp",
    });

    expect(answerFile).toBe(join(sandbox, "child.final.txt"));
    expect(answerFile).toBe(finalAnswerPathForSession(sessionFile));
    expect(await readFile(answerFile, "utf8")).toBe(answer);
    expect((await stat(answerFile)).mode & 0o777).toBe(FINAL_ANSWER_FILE_MODE);
    await expect(readFile(`${answerFile}.deterministic-temp.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces an existing artifact and corrects its final mode", async () => {
    const sandbox = await createSandbox();
    const sessionFile = join(sandbox, "child.jsonl");
    const answerFile = finalAnswerPathForSession(sessionFile);
    await writeFile(answerFile, "old answer", { encoding: "utf8", mode: 0o644 });
    await chmod(answerFile, 0o644);

    await writeFinalAnswerArtifact(sessionFile, "new answer", {
      createTemporaryId: () => "replacement",
    });

    expect(await readFile(answerFile, "utf8")).toBe("new answer");
    expect((await stat(answerFile)).mode & 0o777).toBe(FINAL_ANSWER_FILE_MODE);
  });

  it("requires a JSONL session path", () => {
    expect(() => finalAnswerPathForSession("child.txt")).toThrow(/must end in .jsonl/);
  });
});

describe("Sprint 1 fresh-history seeder", () => {
  it("seeds no parent messages and does not touch the reserved file", async () => {
    const sandbox = await createSandbox();
    const sessionFile = join(sandbox, "child.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const seeder = new FreshHistorySeeder();

    await expect(seeder.seed({ childSessionFile: sessionFile })).resolves.toEqual({
      kind: "fresh",
      seededParentMessages: 0,
    });
    expect(await readFile(sessionFile, "utf8")).toBe("");
  });

  it("does not inspect or require that the child path already exists", async () => {
    const sandbox = await createSandbox();
    const missing = resolve(join(sandbox, "missing", "child.jsonl"));
    const seeder = new FreshHistorySeeder();

    await expect(seeder.seed({ childSessionFile: missing })).resolves.toEqual({
      kind: "fresh",
      seededParentMessages: 0,
    });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createSandbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-collaboration-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}
