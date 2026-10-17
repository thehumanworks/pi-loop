import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ensureWorker, rpc, requestWorker } from "../src/client.ts";
import type { Schedule } from "../src/scheduler.ts";

test("detached worker survives clients, excludes competing writers, and recovers after SIGKILL", { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pl-"));
  const oldHome = process.env.PI_LOOP_HOME;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_LOOP_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  let pid: number | undefined;
  try {
    await Promise.all([ensureWorker(), ensureWorker()]);
    pid = (await rpc({ action: "ping" }) as { pid: number }).pid;
    const child = spawn(process.execPath, ["dist/worker.js"], { env: process.env, stdio: "pipe" });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    assert.equal(code, 0);
    assert.equal((await rpc({ action: "ping" }) as { pid: number }).pid, pid);
    const created = await requestWorker({ action: "create", requestId: "worker-test", frequency: "1d",
      prompt: "Never runs in this test.", cwd: home, model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "off" }) as Schedule;
    process.kill(pid, "SIGKILL");
    pid = undefined;
    // A dead process releases the OS lock immediately, without stale-heartbeat delays.
    await delay(100);
    await ensureWorker();
    pid = (await rpc({ action: "ping" }) as { pid: number }).pid;
    const restored = await rpc({ action: "show", id: created.id }) as Schedule;
    assert.equal(restored.prompt, created.prompt);
    assert.equal(restored.taskId, created.taskId);
    assert.equal(restored.runs.length, 0);
    await rpc({ action: "delete", id: created.id });
    assert.deepEqual(await rpc({ action: "list" }), []);
    await rpc({ action: "stop" });
    await delay(100);
  } finally {
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    if (oldHome === undefined) delete process.env.PI_LOOP_HOME; else process.env.PI_LOOP_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await delay(200);
    await rm(home, { recursive: true, force: true });
  }
});
