// The command line: options anywhere among the arguments, and the rest as the task.

export const USAGE = `Usage: phi-agent [options] [task]

Starts the agent on the folder you are in. With a task, it starts on that task.

Options:
  --continue, -c    Continue the last conversation in this folder
  --sandbox         Run in a Docker container that can only reach this folder
  --model <id>      Use this OpenRouter model, like openai/gpt-4o-mini
  --print, -p       Run the task, print the reply and exit: for scripts and CI
  --yes, -y         Approve every tool call without asking (with --print, or alone)
  --plan            Start in plan mode: the agent only looks around and replies with a plan
  --help, -h        Show this help`;

const FLAGS = {
  "--continue": "continue",
  "-c": "continue",
  "--sandbox": "sandbox",
  "--print": "print",
  "-p": "print",
  "--yes": "yes",
  "-y": "yes",
  "--plan": "plan",
  "--help": "help",
  "-h": "help",
};

/**
 * Reads the arguments: { options: { continue, sandbox, print, yes, plan, help, model }, task }.
 * An argument is an option only if it is one exactly, so a task like "explain -c" (one argument)
 * stays whole. Throws for --model without a model.
 */
export function parseArgs(argv) {
  const options = { continue: false, sandbox: false, print: false, yes: false, plan: false, help: false, model: null };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(FLAGS, arg)) {
      options[FLAGS[arg]] = true;
    } else if (arg === "--model" || arg === "-m") {
      options.model = argv[++i];
      if (!options.model || options.model.startsWith("-")) throw new Error(`${arg} needs a model ID, like --model openai/gpt-4o-mini`);
    } else if (arg.startsWith("--model=")) {
      options.model = arg.slice("--model=".length);
      if (!options.model) throw new Error("--model= needs a model ID, like --model=openai/gpt-4o-mini");
    } else {
      words.push(arg);
    }
  }
  return { options, task: words.join(" ").trim() };
}
