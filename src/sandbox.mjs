import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Runs the agent in a Docker container (the image is built from the Dockerfile next to
// agent.mjs), working on the project mounted at /workspace.

export const SANDBOX_IMAGE = "phi-agent-sandbox";
const SOURCE_LABEL = "phi-agent.source";
// Settings the agent takes from its .env or the environment, passed on into the sandbox.
const PASSED_ENV = ["OPENROUTER_API_KEY", "MODEL", "MAX_TOOL_ROUNDS"];

/** The files the image is built from (as .dockerignore lets in), relative to `agentDir`. */
export function imageFiles(agentDir) {
  const src = readdirSync(join(agentDir, "src"), { recursive: true })
    .map((path) => `src/${String(path).replaceAll("\\", "/")}`)
    .filter((path) => !path.endsWith(".test.mjs") && statSync(join(agentDir, path)).isFile());
  return ["Dockerfile", "package.json", "package-lock.json", "agent.mjs", ...src.sort()];
}

/** A hash of what goes into the image, so it is rebuilt when the agent's code changes. */
export function imageSourceHash(agentDir) {
  const hash = createHash("sha256");
  for (const file of imageFiles(agentDir)) hash.update(`${file}\0`).update(readFileSync(join(agentDir, file))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** The Docker volume that holds a project's node_modules in the sandbox, the same each time. */
export function nodeModulesVolume(projectDir, platform = process.platform) {
  const path = resolve(projectDir);
  // Windows paths are case-insensitive: C:\Code and c:\code are the same folder.
  const key = platform === "win32" ? path.toLowerCase() : path;
  return `phi-agent-node-modules-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

// A field of a --mount option, which is comma-separated: one with a comma or quote is quoted.
function mountField(key, value) {
  const field = `${key}=${value}`;
  return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

function mount(type, source, target, { readonly = false } = {}) {
  const fields = [`type=${type}`, mountField("source", source), mountField("target", target)];
  return ["--mount", [...fields, ...(readonly ? ["readonly"] : [])].join(",")];
}

/** SANDBOX_DOCKER_ARGS, split into arguments at spaces. */
export function extraDockerArgs(text) {
  return text?.trim() ? text.trim().split(/\s+/) : [];
}

/**
 * The `docker run` arguments that start the agent on `projectDir`, mounted at /workspace.
 * The project's .git is mounted read-only: nothing in the sandbox can rewrite the history or
 * add a git hook or setting that would later run on the host. A Node project (`hasPackageJson`)
 * gets its own node_modules volume, so packages installed in the sandbox are built for Linux
 * and leave the host's alone. The API key and other settings are passed by name, so their
 * values come from docker's environment instead of its command line.
 */
export function dockerRunArgs({
  projectDir,
  agentArgs = [],
  env = {},
  tty = false,
  user = null,
  hasGitDir = false,
  hasPackageJson = false,
  extraArgs = [],
  platform = process.platform,
}) {
  const args = ["run", "--rm", "--interactive", "--init", "--security-opt", "no-new-privileges"];
  if (tty) args.push("--tty");
  if (user) args.push("--user", user);
  args.push(...mount("bind", projectDir, "/workspace"));
  if (hasGitDir) args.push(...mount("bind", join(projectDir, ".git"), "/workspace/.git", { readonly: true }));
  if (hasPackageJson) args.push(...mount("volume", nodeModulesVolume(projectDir, platform), "/workspace/node_modules"));
  for (const name of PASSED_ENV) if (env[name]) args.push("--env", name);
  args.push("--env", `PHI_AGENT_HOST_PROJECT=${projectDir}`);
  return [...args, ...extraArgs, SANDBOX_IMAGE, ...agentArgs];
}

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", windowsHide: true, ...options });
}

// Why Docker can't run the sandbox, or null if it can.
function dockerProblem() {
  const result = docker(["version", "--format", "{{.Server.Version}}"]);
  if (result.error?.code === "ENOENT") {
    return "Docker isn't installed. Get it from https://docs.docker.com/get-docker/, or start the agent without --sandbox.";
  }
  if (result.status !== 0) return `Docker isn't running. Start Docker Desktop (or the Docker service) and try again.\n${result.stderr.trim()}`;
  return null;
}

// Builds the image unless one of the agent's current code exists. Returns whether there is one.
function ensureImage(agentDir, info) {
  const hash = imageSourceHash(agentDir);
  const current = docker(["image", "inspect", "--format", `{{ index .Config.Labels "${SOURCE_LABEL}" }}`, SANDBOX_IMAGE]);
  if (current.status === 0 && current.stdout.trim() === hash) return true;

  info(current.status === 0 ? "The agent's code changed: rebuilding the sandbox image." : "Building the sandbox image. This takes a minute, the first time only.");
  const build = docker(["build", "--label", `${SOURCE_LABEL}=${hash}`, "--tag", SANDBOX_IMAGE, agentDir], { stdio: "inherit" });
  if (build.status !== 0) return false;
  // The image this one replaces is left without a name; remove it (only images of this agent).
  docker(["image", "prune", "--force", "--filter", `label=${SOURCE_LABEL}`]);
  return true;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs the agent in the sandbox on `projectDir` with this terminal attached, passing it
 * `agentArgs`, and resolves to its exit code. `info` and `warn` show progress and problems.
 */
export async function runInSandbox({ agentDir, projectDir = process.cwd(), agentArgs = [], env = process.env, info, warn }) {
  if (!existsSync(join(agentDir, "Dockerfile"))) {
    warn(`There is no Dockerfile in ${agentDir} to build the sandbox from.`);
    return 1;
  }
  const problem = dockerProblem();
  if (problem) {
    warn(problem);
    return 1;
  }
  if (!ensureImage(agentDir, info)) {
    warn("Building the sandbox image failed; the output above says why.");
    return 1;
  }

  const args = dockerRunArgs({
    projectDir,
    agentArgs,
    env,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    user: typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : null,
    hasGitDir: isDirectory(join(projectDir, ".git")),
    hasPackageJson: existsSync(join(projectDir, "package.json")),
    extraArgs: extraDockerArgs(env.SANDBOX_DOCKER_ARGS),
  });

  // Ctrl+C is for the agent in the sandbox, which gets it through the terminal.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await new Promise((resolveCode) => {
      const child = spawn("docker", args, { stdio: "inherit", env });
      child.on("error", (error) => {
        warn(`Docker couldn't start the sandbox: ${error.message}`);
        resolveCode(1);
      });
      child.on("close", (code) => resolveCode(code ?? 1));
    });
  } finally {
    process.off("SIGINT", ignore);
  }
}
