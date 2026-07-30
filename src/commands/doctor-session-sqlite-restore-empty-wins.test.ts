/**
 * Regression for #116163: multi-manifest restore can install an empty sessions.json
 * before a nonempty archive and then report restore_conflict on the valid candidate.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

const previousEnv = {
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  restoreEnvValue("OPENCLAW_CONFIG_PATH", previousEnv.OPENCLAW_CONFIG_PATH);
  restoreEnvValue("OPENCLAW_STATE_DIR", previousEnv.OPENCLAW_STATE_DIR);
});

describe("doctor session sqlite restore empty-wins (#116163)", () => {
  it("prefers a nonempty sessions.json archive over a newer empty candidate", async () => {
    const store = createLegacyStore();
    const sqlitePath = resolveTargetSqlitePath({
      agentId: "main",
      storePath: store.storePath,
    });
    const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.rmSync(store.storePath, { force: true });

    const nonemptyEntries = {
      "agent:main:alpha": {
        channel: "cli",
        chatType: "direct",
        sessionFile: "session-1.jsonl",
        sessionId: "session-1",
        sessionStartedAt: 1000,
        updatedAt: 2000,
      },
      "agent:main:beta": {
        channel: "cli",
        chatType: "direct",
        sessionFile: "session-1.jsonl",
        sessionId: "session-2",
        sessionStartedAt: 1000,
        updatedAt: 2000,
      },
      "agent:main:gamma": {
        channel: "cli",
        chatType: "direct",
        sessionFile: "session-1.jsonl",
        sessionId: "session-3",
        sessionStartedAt: 1000,
        updatedAt: 2000,
      },
    };
    const nonemptyCount = Object.keys(nonemptyEntries).length;
    const olderArchivePath = path.join(archiveDir, "legacy-store.sessions.json.imported-1000");
    const newerEmptyArchivePath = path.join(archiveDir, "legacy-store.sessions.json.imported-2000");
    fs.writeFileSync(olderArchivePath, `${JSON.stringify(nonemptyEntries, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(newerEmptyArchivePath, "{}\n", { mode: 0o600 });

    // listSessionSqliteMigrationManifestPaths sorts filenames descending, so newer runs first.
    writeSessionsJsonRestoreManifest(store, {
      archivePath: olderArchivePath,
      fileName: "session-sqlite-1000-older.json",
      startedAt: "2000-01-01T00:00:00.000Z",
      sqlitePath,
    });
    writeSessionsJsonRestoreManifest(store, {
      archivePath: newerEmptyArchivePath,
      fileName: "session-sqlite-2000-newer.json",
      startedAt: "2030-01-01T00:00:00.000Z",
      sqlitePath,
    });

    const restore = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });

    expect(fs.existsSync(store.storePath)).toBe(true);
    const restored = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(restored)).toHaveLength(nonemptyCount);
    expect(fs.readFileSync(store.storePath, "utf-8")).not.toBe("{}\n");
    expect(fs.existsSync(newerEmptyArchivePath)).toBe(true);
    expect(fs.existsSync(olderArchivePath)).toBe(false);
    expect(restore.targets[0]?.restore?.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
  });

  it("writes nothing when multiple nonempty sessions.json archives disagree", async () => {
    const store = createLegacyStore();
    const sqlitePath = resolveTargetSqlitePath({
      agentId: "main",
      storePath: store.storePath,
    });
    const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.rmSync(store.storePath, { force: true });

    const firstArchivePath = path.join(archiveDir, "legacy-store.sessions.json.imported-1000");
    const secondArchivePath = path.join(archiveDir, "legacy-store.sessions.json.imported-2000");
    fs.writeFileSync(
      firstArchivePath,
      `${JSON.stringify(
        {
          "agent:main:alpha": {
            channel: "cli",
            chatType: "direct",
            sessionFile: "session-1.jsonl",
            sessionId: "session-1",
            sessionStartedAt: 1000,
            updatedAt: 2000,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      secondArchivePath,
      `${JSON.stringify(
        {
          "agent:main:beta": {
            channel: "cli",
            chatType: "direct",
            sessionFile: "session-2.jsonl",
            sessionId: "session-2",
            sessionStartedAt: 1000,
            updatedAt: 2000,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    writeSessionsJsonRestoreManifest(store, {
      archivePath: firstArchivePath,
      fileName: "session-sqlite-1000-a.json",
      startedAt: "2000-01-01T00:00:00.000Z",
      sqlitePath,
    });
    writeSessionsJsonRestoreManifest(store, {
      archivePath: secondArchivePath,
      fileName: "session-sqlite-2000-b.json",
      startedAt: "2030-01-01T00:00:00.000Z",
      sqlitePath,
    });

    const restore = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(firstArchivePath)).toBe(true);
    expect(fs.existsSync(secondArchivePath)).toBe(true);
    expect(restore.targets[0]?.restore?.restoredFiles).toEqual([]);
    expect(restore.targets[0]?.restore?.conflicts.length).toBeGreaterThan(0);
    expect(
      restore.targets[0]?.restore?.conflicts.every((conflict) =>
        conflict.reason.includes("ambiguous sessions.json archives"),
      ),
    ).toBe(true);
    expect(restore.totals.issues).toBeGreaterThan(0);
  });
});

type TestStore = {
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
};

function createLegacyStore(): TestStore {
  const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-empty-wins-");
  const stateDir = path.join(tempDir, "state");
  const configPath = path.join(tempDir, "openclaw.json");
  const sessionDir = path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionDir, "sessions.json");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          channel: "cli",
          chatType: "direct",
          sessionFile: "session-1.jsonl",
          sessionId: "session-1",
          sessionStartedAt: 1000,
          updatedAt: 2000,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { env, sessionDir, stateDir, storePath, tempDir };
}

function writeSessionsJsonRestoreManifest(
  store: TestStore,
  params: {
    archivePath: string;
    fileName: string;
    sqlitePath: string;
    startedAt: string;
  },
): void {
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const move = {
    archivePath: params.archivePath,
    kind: "legacy-store" as const,
    sourcePath: store.storePath,
  };
  fs.writeFileSync(
    path.join(runsDir, params.fileName),
    `${JSON.stringify(
      {
        completedAt: params.startedAt,
        manifestVersion: 2,
        openClawVersion: "test",
        runId: path.basename(params.fileName, ".json"),
        startedAt: params.startedAt,
        targets: [
          {
            agentId: "main",
            completedMoves: [move],
            issues: [],
            plannedMoves: [move],
            sqlitePath: params.sqlitePath,
            storePath: store.storePath,
            validationBeforeArchive: "passed",
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function restoreEnvValue(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
