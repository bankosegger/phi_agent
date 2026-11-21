# Tiny Agent

A minimal Node.js coding agent with a basic CLI loop.

## Setup

```bash
npm install
cp .env.example .env # or create .env manually
```

Add your OpenRouter key to `.env`. The agent always reads the `.env` next to `agent.mjs`, whichever folder you run it in:

```env
OPENROUTER_API_KEY=your_key_here
MODEL=openai/gpt-4o-mini
# Optional: model requests per task before the agent stops (default 25)
# MAX_TOOL_ROUNDS=25
# Optional: always run in the Docker sandbox, as with --sandbox
# SANDBOX=docker
```

## Run

Interactive:

```bash
npm run agent
```

Start with a task, then continue chatting:

```bash
npm run agent -- "create hello.js and run it"
```

### In another project

The agent works on the folder it is started in, and `npm run agent` always starts it in this one. To work on another project, link it once and run `phi-agent` from that project's folder:

```bash
npm link           # once, in this folder
cd ../my-app
phi-agent "explain how the build works"
```

Without linking, `node path/to/phi_agent/agent.mjs` does the same. The banner shows the model and the folder the agent is working in.

### Docker sandbox

Start the agent with `--sandbox` to run it in a Docker container, where the commands it runs can't reach the rest of your computer:

```bash
npm run agent -- --sandbox "add tests for the parser"   # works on this folder
phi-agent --sandbox "add tests for the parser"          # works on the folder you're in, after npm link
```

Without `npm link`, `node path/to/phi_agent/agent.mjs --sandbox` works from any folder. The banner says "in a Docker sandbox" when the agent runs in one.

You need Docker (Docker Desktop on Windows and macOS). The first start builds the `phi-agent-sandbox` image from the `Dockerfile` here, which takes a minute; it is rebuilt when the agent's code changes. To always use the sandbox, set `SANDBOX=docker` in `.env`.

In the sandbox:

- The project folder is mounted at `/workspace`, so the agent's changes land in your files as usual and `/undo` works the same. Nothing else on your computer is visible.
- The project's `.git` is read-only, so nothing in the sandbox can rewrite your history or add a git hook that would later run on your computer. You commit, outside the sandbox.
- A Node project gets its own `node_modules` in a Docker volume, so packages installed there are built for Linux and yours stay as they are. The agent runs `npm install` when it needs to. If the project had no `node_modules` folder, Docker leaves an empty one as the volume's mount point.
- Commands run on Linux with `/bin/sh`, and Node, npm and git are installed. The container has network access, which the agent needs to reach OpenRouter.
- The OpenRouter key is passed in from your `.env` when the container starts; it isn't stored in the image. The commands the agent runs don't get it in their environment, but one set on finding it could still read it from the agent's process, so a key with a credit limit is a good idea.

The sandbox protects your computer from the commands the agent runs. It doesn't make the code the agent writes safe to run: review the changes before you run them outside.

For more `docker run` options, like limits on memory and CPU, set `SANDBOX_DOCKER_ARGS` in `.env`, separated by spaces: `SANDBOX_DOCKER_ARGS=--memory 4g --cpus 2`. To free the disk space later, remove the image with `docker image rm phi-agent-sandbox`, and the `node_modules` volumes, named `phi-agent-node-modules-…`, with `docker volume rm`.

### Project instructions

If the project has an `AGENTS.md` file, the agent follows it. Put in it what you would otherwise repeat in every task: how to build and run the tests, code conventions, folders to leave alone. It is read when the agent starts and again on `/clear`, and the banner says when one is in use.

## Commands

| Input | Effect |
| --- | --- |
| `/help` | Show the commands |
| `/clear` | Start a new conversation |
| `/compact` | Summarize the conversation so far, to free up the model's context |
| `/undo` | Revert the file changes of the last task; run it again for the task before |
| `/model [name]` | Show the model, or switch to another [OpenRouter model](https://openrouter.ai/models) |
| `/exit`, `/quit` | Quit |
| Ctrl+C while the agent works | Cancel the current task and return to the prompt |
| Ctrl+C or Ctrl+D at the prompt | Quit |
| `y`, `n` or `a` at a `[confirm]` prompt | Run the tool call, skip it, or run it and stop asking about that tool until you quit |

A cancelled task keeps the conversation usable: any tool calls it had started are recorded as cancelled, and you can carry on with a new task. Cancelling also stops a running `shell` command and any processes it started.

You can type while the agent works: a message you enter then runs after the current task, unless you cancel the task with Ctrl+C. Pasting several lines sends them as one message, so a pasted error message is one task, not one per line.

Before a tool that changes files runs, the agent shows what it will do. `edit_file`, and `write_file` on an existing file, show the lines that change with a little context. A new file shows its first lines. After a `shell` command, you see the last lines of its output and its exit code if it failed. If any tool fails, you see why. A call that would fail anyway, like an edit of text that isn't in the file, is reported without asking you to approve it.

When you skip a tool call, the model is told not to retry it and to ask you instead.

While the agent works, a spinner shows what it is waiting on and for how long: the model, a file the model is writing, or a running command.

After each task, the agent lists the files it changed, how many tokens the task used with the cost that OpenRouter reports, and how full the model's context window is.

### Undo

`/undo` puts back the files the last task changed: edited or overwritten files get their old content back exactly, and files the agent created are deleted, along with folders made for them. Run it again to undo the task before that. A file that changed again after the agent wrote it, by you or by a command, is kept and named instead. The model is told what was undone, so it doesn't assume its changes are still there.

Only the file tools are tracked. What a `shell` command changes can't be undone this way.

### Long conversations

Every request sends the whole conversation, so it grows with each task. The agent keeps it inside the model's context window, whose size it gets from OpenRouter's model list (for a model that isn't listed, it assumes 128k tokens). When a request would fill three quarters of the window, the agent first removes old tool output, which the model can fetch again if it needs it. If that isn't enough, it has the model summarize the earlier tasks. `/compact` does that whenever you like, which also makes later requests cheaper.

If a request is too long for the model anyway, the agent shortens it to fit the window the error states and tries once more.

## Tools

| Tool | Purpose | Asks for confirmation |
| --- | --- | --- |
| `read_file` | Read a file, optionally a line range. Long files come back in parts that say which line to continue from | no |
| `list_dir` | List a directory, optionally recursively | no |
| `find_files` | Find files by glob pattern, like `*.test.js` or `src/**/*.ts` | no |
| `grep` | Regex search across project files, optionally only files matching a glob, or ignoring case | no |
| `git` | Read-only `status`, `diff` (optionally `--staged`), or `log` | no |
| `edit_file` | Replace one unique string in a file | yes |
| `write_file` | Write a file. New files go in a folder like `src/`, not the project root | yes |
| `append_file` | Append to a file. New files go in a folder, not the project root | yes |
| `write_asset` | Save generated output, like a report, under `.agent/assets/` | yes |
| `shell` | Run a shell command. It is stopped after 120 seconds, or up to 600 if the model asks for more | yes |

`list_dir`, `find_files` and `grep` skip `node_modules`, `.git` and `.agent`. In a git repository they also skip what git ignores, like `dist/` or `.env`, so results stay about your source. `list_dir` names the ignored entries it left out, and naming an ignored folder as the `path` searches it anyway.

Long `shell` output keeps its start and end, so the model still sees error summaries and the exit code.

Files keep their line endings. Models write `\n`, but Git for Windows checks files out with `\r\n` by default. Edits still match those files, and the lines they add use `\r\n` like the rest of the file.

## Safety

File tools are limited to relative paths inside the project. Absolute paths and `..` traversal are blocked.

Commands the agent runs don't get your OpenRouter key in their environment, so a command that prints its environment doesn't put the key into the conversation.

New files can't be created at the project root, so the agent puts them in a folder like `src/` instead of next to `package.json`. Existing root files, like `package.json` or `.gitignore`, can be edited. The file tools can't change anything inside `.git`.

Generated output that isn't project source, like a report, goes under `.agent/assets/` with `write_asset`. The files stay after the session, and the agent adds a `.agent/.gitignore` so git ignores the folder in whichever project you run it in.

## Test

```bash
npm test
```
