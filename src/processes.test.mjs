import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { BackgroundProcesses, backgroundProcesses } from "./processes.mjs";
import { checkToolCall, runTool } from "./tools.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inTempDir(fn) {
  const originalCwd = cwd();
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    chdir(dir);
    return await fn(dir);
  } finally {
    await backgroundProcesses.stopAll();
    chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// A node script that prints `lines` (each after its delay in ms), then keeps running.
function script(name, lines, { exitCode = null } = {}) {
  const steps = lines.map(([delay, text]) => `setTimeout(() => console.log(${JSON.stringify(text)}), ${delay});`);
  const end = exitCode == null ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${exitCode}), ${Math.max(0, ...lines.map(([d]) => d)) + 50});`;
  writeFileSync(name, [...steps, end].join("\n"));
  return `node ${name}`;
}

async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) await sleep(50);
}

afterEach(async () => {
  await backgroundProcesses.stopAll();
});

describe("background processes", () => {
  it("start with shell's background option and return their first output", async () => {
    await inTempDir(async () => {
      const cmd = script("server.js", [[0, "starting"], [200, "listening on port 3000"]]);

      const result = await runTool("shell", { cmd, background: true });
      expect(result).toMatch(/^Started process (\d+) in the background\.\nstarting\nlistening on port 3000\n\[process \1 is running\]$/);
      expect(backgroundProcesses.running).toHaveLength(1);
    });
  });

  it("give the output that's new since the last read, waiting for it if asked", async () => {
    await inTempDir(async () => {
      const cmd = script("watch.js", [[0, "first build done"], [1500, "rebuilt after a change"]]);
      const started = await runTool("shell", { cmd, background: true });
      const id = Number(started.match(/process (\d+)/)[1]);

      expect(await runTool("process_output", { id })).toBe(`(no new output)\n[process ${id} is running]`);
      expect(await runTool("process_output", { id, wait: 10 })).toBe(`rebuilt after a change\n[process ${id} is running]`);
    });
  });

  it("say how a process ended", async () => {
    await inTempDir(async () => {
      const cmd = script("fail.js", [[0, "port 3000 is in use"]], { exitCode: 3 });
      const result = await runTool("shell", { cmd, background: true });
      expect(result).toMatch(/port 3000 is in use\n\[process (\d+) exited with code 3\]$/);

      const id = Number(result.match(/process (\d+)/)[1]);
      expect(await runTool("process_output", { id })).toBe(`(no new output)\n[process ${id} exited with code 3]`);
    });
  });

  it("stop with the processes they started", async () => {
    await inTempDir(async () => {
      writeFileSync("child.js", "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000);");
      writeFileSync("parent.js", "require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'inherit' }); console.log('up'); setInterval(() => {}, 1000);");
      const started = await runTool("shell", { cmd: "node parent.js", background: true });
      const id = Number(started.match(/process (\d+)/)[1]);
      await waitFor(() => existsSync("pid.txt"));
      const pid = Number(readFileSync("pid.txt", "utf8"));

      expect(await runTool("stop_process", { id })).toBe(`(no new output)\n[process ${id} was stopped]`);
      expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is gone too
      expect(backgroundProcesses.running).toHaveLength(0);
    });
  });

  it("stop again when the task is cancelled while one starts", async () => {
    await inTempDir(async () => {
      const cmd = script("slow.js", [[5000, "never seen"]]);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);

      const result = await runTool("shell", { cmd, background: true }, { signal: controller.signal });
      expect(result).toMatch(/\[process \d+ was stopped\]$/);
      expect(backgroundProcesses.running).toHaveLength(0);
    });
  });

  it("name the processes there are when asked for one that isn't", async () => {
    await inTempDir(async () => {
      await expect(runTool("process_output", { id: 99 })).rejects.toThrow("There is no background process 99. None have been started.");
      const started = await runTool("shell", { cmd: script("a.js", [[0, "a"]]), background: true });
      const id = started.match(/process (\d+)/)[1];
      await expect(runTool("stop_process", { id: 99 })).rejects.toThrow(`There is no background process 99. There are: ${id}.`);
    });
  });
});

describe("BackgroundProcesses", () => {
  it("limits how many run at once, and checks before a command is confirmed", async () => {
    await inTempDir(async () => {
      const processes = new BackgroundProcesses({ maxRunning: 2 });
      try {
        const cmd = script("idle.js", []);
        processes.start(cmd);
        processes.start(cmd);
        expect(() => processes.start(cmd)).toThrow("Can't run more than 2 background processes at once");
        expect(() => processes.checkRoom()).toThrow("stop one with stop_process first");

        await processes.list[0].stop();
        expect(() => processes.checkRoom()).not.toThrow();
        // Ids keep counting up; stopped processes stay listed until stopAll.
        expect(processes.start(cmd).id).toBe(3);
        expect(processes.list.map((proc) => proc.id)).toEqual([1, 2, 3]);
        expect(await processes.stopAll()).toBe(2);
        expect(processes.list).toEqual([]);
      } finally {
        await processes.stopAll();
      }
    });
  });

  it("are checked for room before the user is asked to confirm another", async () => {
    await inTempDir(async () => {
      const cmd = script("idle.js", []);
      checkToolCall("shell", { cmd, background: true });
      for (let i = 0; i < 5; i++) backgroundProcesses.start(cmd);

      expect(() => checkToolCall("shell", { cmd, background: true })).toThrow("Can't run more than 5 background processes at once");
      checkToolCall("shell", { cmd: "npm test" }); // a command that ends is fine
    });
  });

  it("keeps only the latest output, and says how much was dropped", async () => {
    await inTempDir(async () => {
      const processes = new BackgroundProcesses({ maxKeptOutput: 100 });
      try {
        const proc = processes.start(script("loud.js", [[0, "x".repeat(300) + "END"]], { exitCode: 0 }));
        await processes.waitForOutput(proc, 10);
        await waitFor(() => !proc.running);

        // 300 x's, END and a line break were printed; the first 204 characters are gone.
        const { text, lost } = proc.read();
        expect(text).toBe(`${"x".repeat(96)}END\n`);
        expect(lost).toBe(204);
        expect(proc.read()).toEqual({ text: "", lost: 0 });
        expect(proc.lastLine).toBe(text.trim());
      } finally {
        await processes.stopAll();
      }
    });
  });
});
