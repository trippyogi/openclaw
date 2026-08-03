// Codesign Mac App tests cover codesign mac app script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/codesign-mac-app.sh";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function entitlementTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("openclaw-entitlements"));
}

function runCodesign(args: string[], tempRoot: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tempRoot,
    },
  });
}

function installFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

entitlements=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
      ;;
  esac
  target="$1"
  shift || true
done

if [ -z "$target" ]; then
  echo "missing codesign target" >&2
  exit 2
fi

if [ -n "$entitlements" ]; then
  count_file="$CODESIGN_CAPTURE_DIR/count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  copy="$CODESIGN_CAPTURE_DIR/entitlements-$count.plist"
  cp "$entitlements" "$copy"
  printf 'entitled\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\n' "$target" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

function installFakeSecurity(binDir: string, findIdentityOutput: string) {
  const fakeSecurity = path.join(binDir, "security");
  writeFileSync(
    fakeSecurity,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "find-identity" ]; then
  cat <<'IDENTITIES'
${findIdentityOutput}
IDENTITIES
  exit 0
fi

echo "unsupported fake security invocation: $*" >&2
exit 1
`,
  );
  chmodSync(fakeSecurity, 0o755);
}

function installFakeCodesignCapturingTimestamp(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

timestamp_arg="(none-present)"
for arg in "$@"; do
  case "$arg" in
    --timestamp|--timestamp=none)
      timestamp_arg="$arg"
      ;;
  esac
done

printf '%s\\n' "$timestamp_arg" >>"$CODESIGN_TIMESTAMP_LOG"
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

const FAKE_IDENTITIES = [
  '  1) 61FA3931889DF30F4EBE96CA1D2FB4B308694A5 "Developer ID Application: OpenClaw Inc (ABCDE12345)"',
  '  2) 71FA3931889DF30F4EBE96CA1D2FB4B308694A6 "Apple Development: Jane Doe (ABCDE12345)"',
  "     2 valid identities found",
].join("\n");

function runTimestampScenario(env: Record<string, string>): {
  status: number | null;
  stderr: string;
  timestampArgs: string[];
} {
  const tempRoot = makeTempDir("openclaw-codesign-timestamp-");
  const app = path.join(tempRoot, "Fake.app");
  const binDir = path.join(tempRoot, "bin");
  const timestampLog = path.join(tempRoot, "timestamp.log");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(binDir);
  installFakeCodesignCapturingTimestamp(binDir);
  installFakeSecurity(binDir, FAKE_IDENTITIES);

  const result = spawnSync("bash", [scriptPath, app], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      CODESIGN_TIMESTAMP_LOG: timestampLog,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SKIP_TEAM_ID_CHECK: "1",
      TMPDIR: tempRoot,
    },
  });

  const timestampArgs = existsSync(timestampLog)
    ? readFileSync(timestampLog, "utf8").trim().split("\n").filter(Boolean)
    : [];

  return { status: result.status, stderr: result.stderr, timestampArgs };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codesign-mac-app temp file hygiene", () => {
  it("does not generate unused entitlement plist files", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('ENT_TMP_APP="$ENT_TMP_DIR/app.plist"');
    expect(script).not.toContain("ENT_TMP_BASE");
    expect(script).not.toContain("ENT_TMP_RUNTIME");
    expect(script).not.toContain("base.plist");
    expect(script).not.toContain("runtime.plist");
  });

  it("does not allocate entitlement temp files for help output", () => {
    const tempRoot = makeTempDir("openclaw-codesign-help-");
    const result = runCodesign(["--help"], tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not allocate entitlement temp files before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-missing-");
    const missingApp = path.join(tempRoot, "Missing.app");
    const result = runCodesign([missingApp], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("App bundle not found");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects unknown options before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-unknown-");
    const result = runCodesign(["--wat"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects extra app bundle arguments before signing", () => {
    const tempRoot = makeTempDir("openclaw-codesign-extra-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const result = runCodesign([app, "extra"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("cleans entitlement temp files when signing fails", () => {
    const tempRoot = makeTempDir("openclaw-codesign-fail-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("passes generated app entitlements to signing commands and cleans them", () => {
    const tempRoot = makeTempDir("openclaw-codesign-success-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const logPath = path.join(captureDir, "codesign.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "-",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Codesign complete for ${app}`);

    const signLines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(signLines).toHaveLength(3);
    expect(signLines[0]).toContain(`${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}\t`);
    expect(signLines[1]).toContain(`${path.join(app, "Contents", "MacOS", "OpenClaw")}\t`);
    expect(signLines[2]).toContain(`${app}\t`);
    for (const line of signLines) {
      const columns = line.split("\t");
      const entitlementPath = columns[2];
      const copiedEntitlementsPath = columns[3];
      const entitlementSource = expectDefined(entitlementPath, "codesign entitlement source path");
      const copiedEntitlementSource = expectDefined(
        copiedEntitlementsPath,
        "copied codesign entitlement path",
      );
      const copiedEntitlements = readFileSync(copiedEntitlementSource, "utf8");
      expect(entitlementSource).toContain("openclaw-entitlements");
      expect(existsSync(entitlementSource)).toBe(false);
      expect(copiedEntitlements).toContain("com.apple.security.automation.apple-events");
      expect(copiedEntitlements).toContain("com.apple.security.device.camera");
    }
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });
});

describe("codesign-mac-app CODESIGN_TIMESTAMP resolution", () => {
  it("enables --timestamp for a name-form Developer ID identity under auto", () => {
    const { status, timestampArgs } = runTimestampScenario({
      SIGN_IDENTITY: "Developer ID Application: OpenClaw Inc (ABCDE12345)",
    });

    expect(status).toBe(0);
    expect(timestampArgs).toEqual(["--timestamp"]);
  });

  it("enables --timestamp when a SHA-1 hash resolves to a Developer ID Application identity", () => {
    const { status, stderr, timestampArgs } = runTimestampScenario({
      SIGN_IDENTITY: "61FA3931",
    });

    expect(status).toBe(0);
    expect(stderr).not.toContain("WARN: CODESIGN_TIMESTAMP=auto could not");
    expect(timestampArgs).toEqual(["--timestamp"]);
  });

  it("keeps --timestamp=none when a SHA-1 hash resolves to an Apple Development identity", () => {
    const { status, stderr, timestampArgs } = runTimestampScenario({
      SIGN_IDENTITY: "71FA3931",
    });

    expect(status).toBe(0);
    expect(stderr).not.toContain("WARN: CODESIGN_TIMESTAMP=auto could not");
    expect(timestampArgs).toEqual(["--timestamp=none"]);
  });

  it("warns and keeps --timestamp=none for a hash that does not resolve under auto", () => {
    const { status, stderr, timestampArgs } = runTimestampScenario({
      SIGN_IDENTITY: "DEADBEEF00",
    });

    expect(status).toBe(0);
    expect(stderr).toContain(
      'WARN: CODESIGN_TIMESTAMP=auto could not uniquely resolve SIGN_IDENTITY hash "DEADBEEF00"',
    );
    expect(stderr).toContain("CODESIGN_TIMESTAMP=on");
    expect(timestampArgs).toEqual(["--timestamp=none"]);
  });

  it("enables --timestamp for an Apple Development identity when explicitly forced on", () => {
    const { status, timestampArgs } = runTimestampScenario({
      CODESIGN_TIMESTAMP: "on",
      SIGN_IDENTITY: "Apple Development: Jane Doe (ABCDE12345)",
    });

    expect(status).toBe(0);
    expect(timestampArgs).toEqual(["--timestamp"]);
  });

  it("keeps --timestamp=none for ad-hoc signing regardless of CODESIGN_TIMESTAMP", () => {
    const { status, timestampArgs } = runTimestampScenario({
      CODESIGN_TIMESTAMP: "on",
      SIGN_IDENTITY: "-",
    });

    expect(status).toBe(0);
    expect(timestampArgs).toEqual(["--timestamp=none"]);
  });
});
