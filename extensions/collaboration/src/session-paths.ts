import { randomUUID } from "node:crypto";
import * as nodeFileSystem from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const SESSION_DIRECTORY_MODE = 0o700;
export const SESSION_FILE_MODE = 0o600;
export const FINAL_ANSWER_FILE_MODE = 0o600;

export interface SessionPathFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: string, options: { encoding: "utf8" }): Promise<void>;
}

export interface SessionPathFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: "wx", mode: number): Promise<SessionPathFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFileSystem: SessionPathFileSystem = {
  async mkdir(path, options) {
    await nodeFileSystem.mkdir(path, options);
  },
  async open(path, flags, mode) {
    return nodeFileSystem.open(path, flags, mode);
  },
  async rename(oldPath, newPath) {
    await nodeFileSystem.rename(oldPath, newPath);
  },
  async unlink(path) {
    await nodeFileSystem.unlink(path);
  },
};

export interface ChildSessionPathRequest {
  /** Undefined when the root is running with --no-session. */
  rootSessionFile: string | undefined;
  rootSessionId: string;
  taskName: string;
  childId: string;
}

export interface SessionPathDependencies {
  fileSystem?: SessionPathFileSystem;
  getAgentDirectory?: () => string;
  createTemporaryId?: () => string;
}

export interface ChildSessionAllocation {
  sessionDirectory: string;
  sessionFile: string;
  finalAnswerFile: string;
}

export class SessionFileCollisionError extends Error {
  override readonly name = "SessionFileCollisionError";

  constructor(
    readonly sessionFile: string,
    options?: ErrorOptions,
  ) {
    super(`Child session file already exists: ${sessionFile}`, options);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function requireSafeSegment(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not a safe path segment: ${JSON.stringify(value)}`);
  }
}

function validateRequest(request: ChildSessionPathRequest): void {
  requireSafeSegment("taskName", request.taskName, /^[a-z0-9_]+$/);
  requireSafeSegment("rootSessionId", request.rootSessionId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  requireSafeSegment("childId", request.childId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);

  if (request.rootSessionFile !== undefined && request.rootSessionFile.length === 0) {
    throw new Error("rootSessionFile must be undefined or a nonempty path");
  }
}

export function finalAnswerPathForSession(sessionFile: string): string {
  if (!sessionFile.endsWith(".jsonl")) {
    throw new Error(`Child session path must end in .jsonl: ${sessionFile}`);
  }
  return `${sessionFile.slice(0, -".jsonl".length)}.final.txt`;
}

/** Resolve a child path without touching the filesystem. */
export function resolveChildSessionPath(
  request: ChildSessionPathRequest,
  dependencies: Pick<SessionPathDependencies, "getAgentDirectory"> = {},
): ChildSessionAllocation {
  validateRequest(request);

  const sessionBase =
    request.rootSessionFile === undefined
      ? join(resolve(requireAgentDirectory(dependencies.getAgentDirectory)), "collaboration", "sessions")
      : join(dirname(resolve(request.rootSessionFile)), "collaboration");
  const sessionDirectory = join(sessionBase, request.rootSessionId, request.taskName);
  const sessionFile = join(sessionDirectory, `${request.childId}.jsonl`);

  return {
    sessionDirectory,
    sessionFile,
    finalAnswerFile: finalAnswerPathForSession(sessionFile),
  };
}

function requireAgentDirectory(getAgentDirectory: (() => string) | undefined): string {
  if (getAgentDirectory === undefined) {
    throw new Error("getAgentDirectory is required when the root has no session file");
  }
  return getAgentDirectory();
}

/**
 * Reserve the exact child JSONL path with an exclusive, owner-only empty file.
 * Pi's SessionManager.open() will initialize this file with its session header.
 */
export async function allocateChildSession(
  request: ChildSessionPathRequest,
  dependencies: SessionPathDependencies = {},
): Promise<ChildSessionAllocation> {
  const allocation = resolveChildSessionPath(request, dependencies);
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;

  await fileSystem.mkdir(allocation.sessionDirectory, {
    recursive: true,
    mode: SESSION_DIRECTORY_MODE,
  });

  let handle: SessionPathFileHandle;
  try {
    handle = await fileSystem.open(allocation.sessionFile, "wx", SESSION_FILE_MODE);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new SessionFileCollisionError(allocation.sessionFile, { cause: error });
    }
    throw error;
  }

  try {
    await handle.close();
  } catch (error) {
    await unlinkIfPresent(fileSystem, allocation.sessionFile);
    throw error;
  }

  return allocation;
}

/** Remove only the exact JSONL reserved by a failed pre-start attempt. */
export async function removeFailedChildSession(
  allocation: ChildSessionAllocation,
  dependencies: Pick<SessionPathDependencies, "fileSystem"> = {},
): Promise<void> {
  await unlinkIfPresent(dependencies.fileSystem ?? defaultFileSystem, allocation.sessionFile);
}

/**
 * Atomically replace a child's full-answer artifact with owner-only contents.
 * The temporary file is created beside the destination so rename is atomic on
 * the supported macOS/Linux filesystems.
 */
export async function writeFinalAnswerArtifact(
  sessionFile: string,
  answer: string,
  dependencies: SessionPathDependencies = {},
): Promise<string> {
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const finalAnswerFile = finalAnswerPathForSession(resolve(sessionFile));
  const artifactDirectory = dirname(finalAnswerFile);
  await fileSystem.mkdir(artifactDirectory, {
    recursive: true,
    mode: SESSION_DIRECTORY_MODE,
  });

  const createTemporaryId = dependencies.createTemporaryId ?? randomUUID;
  let temporaryFile: string | undefined;
  let handle: SessionPathFileHandle | undefined;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryId = createTemporaryId();
    requireSafeSegment("temporary artifact id", temporaryId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    temporaryFile = `${finalAnswerFile}.${temporaryId}.tmp`;

    try {
      handle = await fileSystem.open(temporaryFile, "wx", FINAL_ANSWER_FILE_MODE);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      temporaryFile = undefined;
    }
  }

  if (temporaryFile === undefined || handle === undefined) {
    throw new Error(`Unable to reserve a temporary answer artifact beside ${finalAnswerFile}`);
  }

  try {
    await handle.writeFile(answer, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporaryFile, finalAnswerFile);
    return finalAnswerFile;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary write/sync/rename failure.
      }
    }
    await unlinkIfPresent(fileSystem, temporaryFile);
    throw error;
  }
}

async function unlinkIfPresent(fileSystem: SessionPathFileSystem, path: string): Promise<void> {
  try {
    await fileSystem.unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}
