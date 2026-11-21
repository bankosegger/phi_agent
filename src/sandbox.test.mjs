import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerRunArgs, extraDockerArgs, imageFiles, imageSourceHash, nodeModulesVolume } from "./sandbox.mjs";

describe("dockerRunArgs", () => {
  it("mounts the project, its .git read-only and a node_modules volume", () => {
    const args = dockerRunArgs({
      projectDir: "C:\\Code\\my-app",
      agentArgs: ["fix", "the tests"],
      env: { OPENROUTER_API_KEY: "sk-secret", MODEL: "openai/gpt-4o-mini", MAX_TOOL_ROUNDS: "" },
      tty: true,
      hasGitDir: true,
      hasPackageJson: true,
      platform: "win32",
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "--interactive",
      "--init",
      "--security-opt",
      "no-new-privileges",
      "--tty",
      "--mount",
      "type=bind,source=C:\\Code\\my-app,target=/workspace",
      "--mount",
      `type=bind,source=${join("C:\\Code\\my-app", ".git")},target=/workspace/.git,readonly`,
      "--mount",
      `type=volume,source=${nodeModulesVolume("C:\\Code\\my-app", "win32")},target=/workspace/node_modules`,
      "--env",
      "OPENROUTER_API_KEY",
      "--env",
      "MODEL",
      "--env",
      "PHI_AGENT_HOST_PROJECT=C:\\Code\\my-app",
      "phi-agent-sandbox",
      "fix",
      "the tests",
    ]);
    // The key's value stays off the command line, where other programs could see it.
    expect(args.join(" ")).not.toContain("sk-secret");
  });

  it("runs as the given user, quotes awkward paths, and adds extra options before the image", () => {
    const args = dockerRunArgs({
      projectDir: "/home/me/a,b",
      user: "1000:1000",
      extraArgs: ["--memory", "2g"],
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "--interactive",
      "--init",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--mount",
      'type=bind,"source=/home/me/a,b",target=/workspace',
      "--env",
      "PHI_AGENT_HOST_PROJECT=/home/me/a,b",
      "--memory",
      "2g",
      "phi-agent-sandbox",
    ]);
  });
});

describe("nodeModulesVolume", () => {
  it("names one volume per project folder", () => {
    const volume = nodeModulesVolume("C:\\Code\\app", "win32");
    expect(volume).toMatch(/^phi-agent-node-modules-[0-9a-f]{12}$/);
    expect(nodeModulesVolume("c:\\code\\APP", "win32")).toBe(volume); // the same folder on Windows
    expect(nodeModulesVolume("C:\\Code\\other", "win32")).not.toBe(volume);
    expect(nodeModulesVolume("/home/me/App", "linux")).not.toBe(nodeModulesVolume("/home/me/app", "linux"));
  });
});

describe("extraDockerArgs", () => {
  it("splits SANDBOX_DOCKER_ARGS at spaces", () => {
    expect(extraDockerArgs("  --memory 2g   --cpus=2 ")).toEqual(["--memory", "2g", "--cpus=2"]);
    expect(extraDockerArgs("")).toEqual([]);
    expect(extraDockerArgs(undefined)).toEqual([]);
  });
});

describe("imageSourceHash", () => {
  it("changes with the agent's code, but not with its tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    try {
      const files = {
        Dockerfile: "FROM node:24-slim\n",
        "package.json": "{}\n",
        "package-lock.json": "{}\n",
        "agent.mjs": "// agent\n",
        "src/a.mjs": "export const a = 1;\n",
        "src/a.test.mjs": "// test\n",
        "src/lib/b.mjs": "export const b = 2;\n",
      };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }

      expect(imageFiles(dir)).toEqual(["Dockerfile", "package.json", "package-lock.json", "agent.mjs", "src/a.mjs", "src/lib/b.mjs"]);
      const hash = imageSourceHash(dir);
      writeFileSync(join(dir, "src/a.test.mjs"), "// another test\n");
      expect(imageSourceHash(dir)).toBe(hash);
      writeFileSync(join(dir, "src/lib/b.mjs"), "export const b = 3;\n");
      expect(imageSourceHash(dir)).not.toBe(hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("covers this agent's code and nothing secret", () => {
    const files = imageFiles(join(dirname(fileURLToPath(import.meta.url)), ".."));
    expect(files).toContain("src/tools.mjs");
    expect(files).toContain("src/sandbox.mjs");
    expect(files.some((file) => file.endsWith(".test.mjs") || file.includes(".env"))).toBe(false);
  });
});
