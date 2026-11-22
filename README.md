# Tiny Agent

A minimal Node.js coding agent with a basic CLI loop.

## Setup

You need Node.js 22.1 or later.

```bash
npm install
cp .env.example .env # or create .env manually
```

Add an API key to `.env`: an [OpenRouter](https://openrouter.ai) key for the models it has, from many providers, an Anthropic key for Claude models through the Claude API, or both (see [Models](#models)). The agent always reads the `.env` next to `agent.mjs`, whichever folder you run it in:

```env
OPENROUTER_API_KEY=your_key_here
# ANTHROPIC_API_KEY=your_anthropic_key_here
MODEL=openai/gpt-4o-mini
# Optional: model requests per task before the agent stops (default 25)
# MAX_TOOL_ROUNDS=25
# Optional: how much Claude models think through the Claude API: low, medium, high, xhigh or max
# EFFORT=high
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

Pick up where you left off, or run one task without chatting (see [Scripts and CI](#scripts-and-ci)):

```bash
npm run agent -- --continue                    # the last conversation in this folder
npm run agent -- --print "summarize README.md" # prints the reply and exits
```

`--help` lists the options: `--continue` (`-c`), `--sandbox`, `--model <id>`, `--plan`, `--print` (`-p`), `--yes` (`-y`) and `--version` (`-v`).

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

Without `npm link`, `node path/to/phi_agent/agent.mjs --sandbox` works from any folder. The banner says when the agent runs in the sandbox.

You need Docker (Docker Desktop on Windows and macOS). The first start builds the `phi-agent-sandbox` image from the `Dockerfile` here, which takes a minute; it is rebuilt when the agent's code changes. To always use the sandbox, set `SANDBOX=docker` in `.env`.

In the sandbox:

- The project folder is mounted at `/workspace`, so the agent's changes land in your files as usual and `/undo` works the same. Nothing else on your computer is visible.
- The project's `.git` is read-only, so nothing in the sandbox can rewrite your history or add a git hook that would later run on your computer. You commit, outside the sandbox.
- A Node project gets its own `node_modules` in a Docker volume, so packages installed there are built for Linux and yours stay as they are. The agent runs `npm install` when it needs to. If the project had no `node_modules` folder, Docker leaves an empty one as the volume's mount point.
- Commands run on Linux with `/bin/sh`, and Node, npm and git are installed. The container has network access, which the agent needs to reach OpenRouter and the Claude API.
- The API keys are passed in from your `.env` when the container starts; they aren't stored in the image. The commands the agent runs don't get them in their environment, but one set on finding them could still read them from the agent's process, so keys with a spending limit are a good idea.

The sandbox protects your computer from the commands the agent runs. It doesn't make the code the agent writes safe to run: review the changes before you run them outside.

For more `docker run` options, like limits on memory and CPU, set `SANDBOX_DOCKER_ARGS` in `.env`, separated by spaces: `SANDBOX_DOCKER_ARGS=--memory 4g --cpus 2`. To free the disk space later, remove the image with `docker image rm phi-agent-sandbox`, and the `node_modules` volumes, named `phi-agent-node-modules-…`, with `docker volume rm`.

### Project instructions

If the project has an `AGENTS.md` file, the agent follows it. Put in it what you would otherwise repeat in every task: how to build and run the tests, code conventions, folders to leave alone. It is read when the agent starts and again on `/clear`, and the banner says when one is in use.

For what applies to all your projects, like how you like answers or what your machine has installed, write an `AGENTS.md` in a `.phi-agent` folder in your home folder (`~/.phi-agent/AGENTS.md`). The agent follows both; where they disagree, the project's wins. In the Docker sandbox, the folder is mounted read-only, so the agent reads it there too.

## Models

The model's ID says which service the agent asks:

- An ID with a slash, like `openai/gpt-4o-mini` or `anthropic/claude-sonnet-4.5`, is a model on [OpenRouter](https://openrouter.ai/models), used with `OPENROUTER_API_KEY`. OpenRouter reports what each request cost.
- An ID that starts with `claude-`, like `claude-opus-5-5`, is a Claude model through Anthropic's Claude API, used with `ANTHROPIC_API_KEY`, which you get in the [Claude Console](https://platform.claude.com). The Claude API is billed per token to that account: a Claude Pro or Max subscription doesn't cover it.

`MODEL` in `.env` sets the model, and `--model` overrides it. Without either, the model is `openai/gpt-4o-mini` when there is an OpenRouter key, and `claude-opus-5-5` when there is only an Anthropic one. `/model <id>` switches to any model whose key is set, and Tab completes the IDs of both services.

### Claude through the Claude API

- Claude thinks before it answers, as much as the task needs. Its thinking goes back to it with the rest of the conversation, so it keeps its train of thought across tool calls. `EFFORT` in `.env` (`low`, `medium`, `high`, `xhigh` or `max`) sets how much it thinks; without it, each model thinks as much as it does by default (`medium` for Claude Opus 5.5). More effort is slower and costs more, as thinking is billed as output.
- The system prompt and the conversation are cached: each request reads what the request before it sent from the cache, at a tenth of the usual price or less, instead of paying for the whole conversation again. The usage line after a task says how much of its input came from the cache.
- When a model declines a request for safety reasons, which its classifiers can do for legitimate security work too, its fallback model takes over, and the agent says so. If there is no fallback model, or it declines too, the task stops with an error.
- The Claude API doesn't report what a request cost, so the usage line shows an estimate from Anthropic's list prices, marked `~`. For a model the agent has no prices for, it shows no cost.

### Claude through OpenRouter

With an `anthropic/` model on OpenRouter, the agent marks the prompt for caching, as Claude needs; other models cache by themselves. All of a conversation's requests go to the same provider, which has its prompt cached.

## Commands

| Input | Effect |
| --- | --- |
| `/help` | Show the commands |
| `/clear` | Start a new conversation |
| `/resume [n]` | List the saved conversations, or continue conversation n |
| `/compact` | Summarize the conversation so far, to free up the model's context |
| `/undo` | Revert the file changes of the last task; run it again for the task before |
| `/plan` | Turn plan mode on or off (see [Plan mode](#plan-mode)) |
| `/model [name]` | Show the model, its context size and whether it sees images, or switch to another (see [Models](#models)) |
| `/processes` | List the commands the agent left running in the background |
| `/stop <n>`, `/stop all` | Stop background process n, or all of them |
| `/permissions` | List what runs without asking; `/permissions remove <n>` takes one back |
| `/exit`, `/quit` | Quit |
| Ctrl+C while the agent works | Cancel the current task and return to the prompt |
| Ctrl+C or Ctrl+D at the prompt | Quit |
| `y`, `n` or `a` when asked to confirm (`? Run this command? y/N …`) | Run the tool call, skip it, or run it and allow calls like it for good in this project (see [Permissions](#permissions)) |

A cancelled task keeps the conversation usable: any tool calls it had started are recorded as cancelled, and you can carry on with a new task. Cancelling also stops a running `shell` command and any processes it started.

You can type while the agent works: a message you enter then runs after the current task, unless you cancel the task with Ctrl+C. Pasting several lines sends them as one message, so a pasted error message is one task, not one per line.

Tab completes commands, model IDs after `/model`, and file paths. The up arrow brings back what you entered before, in this project too, as it is saved in `.agent/history`.

When the agent needs you after working a while, at a confirmation after 10 seconds or at the end of a task that took 30, it rings the terminal's bell, which can flash the window or mark its tab. `BELL=off` in `.env` silences it.

Each tool call gets a line, like `● Edit src/app.js` or `● Run npm test`; calls that only look around, like reading a file, are dimmed, so the ones that change something stand out. Before a tool that changes files runs, the agent shows what it will do. `edit_file`, and `write_file` on an existing file, show the lines that change with a little context, numbered as in the file. A new file shows its first lines, and so does a file about to be deleted; a folder about to be deleted shows its files. After a `shell` command, you see the last lines of its output, whether it worked, and how long it took. If any tool fails, you see why. A call that would fail anyway, like an edit of text that isn't in the file, is reported without asking you to approve it. For such an edit, the model is shown the closest text the file has, and told when only spaces and tabs differ, so it can fix the edit without reading the file again.

When you skip a tool call, the model is told not to retry it and to ask you instead.

While the agent works, a spinner shows what it is waiting on and for how long: the model, a file the model is writing, or a running command. After a few seconds, it also says how to cancel.

Replies are formatted as they stream in, when the terminal shows colors: headings, bold, italic and struck-out text, lists, quotes, and tables drawn in a box. Code blocks are colored by language (JavaScript and TypeScript, Python, shell and PowerShell, JSON, YAML, TOML, SQL, Go, Rust, C-like languages, and diffs), and links show their text with the address after it. Piped output, and `--print`, keep the model's markdown as it is.

The old Windows console can't draw some of the symbols the agent uses, like `✓` and `❯`, so there it uses simpler ones. Windows Terminal and VS Code show them all.

After each task, the agent lists the files it changed, then draws a line across the terminal with how long the task took, how many tokens it used (and how many of them were read from the prompt cache), what it cost, and how full the model's context window is. The cost is OpenRouter's, or for the Claude API an estimate, marked `~`.

When a reply stops at the model's output limit, the agent says so. A tool call the limit cut off doesn't run: the model is told to make it again, in smaller parts.

### Undo

`/undo` puts back the files the last task changed: edited or overwritten files get their old content back exactly, deleted and moved files come back where they were, and files the agent created are deleted, along with folders made for them. Run it again to undo the task before that. A file that changed again after the agent wrote it, by you or by a command, is kept and named instead. The model is told what was undone, so it doesn't assume its changes are still there.

Only the file tools are tracked. What a `shell` command changes can't be undone this way.

### Plan mode

For a bigger change, have the agent plan it first. In plan mode (`/plan`, or `--plan` at the start, the prompt reads `plan ❯`), the agent reads and searches as much as it needs but changes nothing: file changes and commands are refused, without asking you. It replies with a plan. Talk it over, then `/plan` again and tell it to go ahead.

### Permissions

Answering `a` when asked to confirm a tool call allows calls like that one for good, in this project:

- for `shell`, commands that start the same way. The question shows how: `a = always allow "npm test"` allows `npm test` and `npm test -- --watch`, but not `npm install`. A script run by an interpreter is part of the rule, like `node scripts/build.js`.
- for `fetch_url`, pages from the same site, like `docs.python.org`.
- for the file tools, every call of that tool. Their changes can be undone.

Some commands always ask: ones that chain or start other commands, or redirect output (`&&`, `;`, `|`, `>`, `$(…)`), since a rule for `npm test` mustn't let `npm test && rm -rf ~` through, and ones whose damage can't be undone, like `rm`, `sudo`, `chmod` or `kill`.

The rules are saved in `.agent/permissions.json`. `/permissions` lists them, and `/permissions remove <n>` takes one back.

### Saved conversations

After each task, the conversation is saved in the project's `.agent/sessions` folder, which git ignores. `--continue` picks up the one you used last in that folder, so quitting, or a stray Ctrl+C, loses nothing. `/resume` lists the saved conversations, and `/resume <n>` goes back to one. The 30 you used last are kept.

A continued conversation gets a fresh system prompt, with the project's `AGENTS.md` as it is now. `/undo` only covers changes since the agent started, and background processes don't carry over.

### Scripts and CI

`--print` (`-p`) runs one task and exits, without asking you anything. The model's final reply goes to stdout and everything else, like the tool calls, goes to stderr, so a script gets only the reply. Input piped in is added to the task; with a task given as an argument, the agent waits up to 3 seconds for piped input to start, in case nothing is coming:

```bash
git diff | phi-agent -p "review this change"
phi-agent -p "list the TODOs in src" > todos.md
```

The exit code is 0 when the task ran, 1 when it failed (an API error, say), 2 without a task, and 130 when cancelled with Ctrl+C.

A tool call that would ask is skipped, and the model is told so, unless a [permissions rule](#permissions) allows it or you add `--yes` (`-y`), which approves everything. `--yes` works in a chat too. Use it in the [Docker sandbox](#docker-sandbox), where commands can't reach the rest of your computer:

```bash
phi-agent --sandbox -p -y "run the tests and fix what fails"
```

The conversation is saved as usual, so `--continue` can pick it up afterwards.

### Long conversations

Every request sends the whole conversation, so it grows with each task. The agent keeps it inside the model's context window, whose size it gets from the model list of OpenRouter or the Claude API (for a model that isn't listed, it assumes 128k tokens). When a request would fill three quarters of the window, the agent first removes old tool output, which the model can fetch again if it needs it. If that isn't enough, it has the model summarize the earlier tasks. `/compact` does that whenever you like, which also makes later requests cheaper.

If a request is too long for the model anyway, the agent shortens it to fit the window the error states and tries once more.

### Images

To show the model a screenshot, put the image's path in your message: drag the file into the terminal, which types its full path, or write `@` and a path in the project, like `@docs/mockup.png`. The agent attaches PNG, JPEG, GIF and WebP images up to 5 MB, and says which ones it attached. The model can also open images in the project itself, with `view_image`.

Both need a model that can see images. `/model` says whether yours can, from its model list; with one that can't, the model gets only the file names. In the Docker sandbox, only images inside the project can be attached.

### Background processes

A command that doesn't exit, like a dev server or a file watcher, would hold up the agent until its time limit. The agent runs those in the background instead: it sees their first output, reads what they print later with `process_output`, and stops them with `stop_process`, so it can start a server and then test against it. Up to 5 can run at once.

`/processes` lists them, with the last line each one printed, and `/stop` stops one. They are all stopped when you quit, and when `/clear` starts a new conversation.

In the Docker sandbox, a server the agent starts can only be reached inside the container. To open it in your browser, publish its port with `SANDBOX_DOCKER_ARGS=-p 3000:3000`, and have the server listen on `0.0.0.0` rather than `localhost`.

## Tools

| Tool | Purpose | Asks for confirmation |
| --- | --- | --- |
| `read_file` | Read a file, optionally a line range. Long files come back in parts that say which line to continue from | only a file that may hold secrets, like `.env` |
| `list_dir` | List a directory, optionally recursively | no |
| `find_files` | Find files by glob pattern, like `*.test.js` or `src/**/*.ts` | no |
| `grep` | Regex search across project files, optionally only files matching a glob, or ignoring case | only to search a file that may hold secrets |
| `git` | Read-only `status`, `diff` (optionally `--staged`), or `log` | no |
| `fetch_url` | Fetch a web page as readable text, or other text like JSON. Long pages come in parts | yes |
| `view_image` | Look at an image in the project, like a screenshot. Only for models that can see images | no |
| `edit_file` | Replace one unique string in a file | yes |
| `write_file` | Write a file. New files go in a folder like `src/`, not the project root | yes |
| `append_file` | Append to a file. New files go in a folder, not the project root | yes |
| `delete_file` | Delete a file, or a folder and everything in it | yes |
| `move_file` | Move or rename a file or folder | yes |
| `write_asset` | Save generated output, like a report, under `.agent/assets/` | yes |
| `shell` | Run a shell command. It is stopped after 120 seconds, or up to 600 if the model asks for more, unless it runs in the background | yes |
| `process_output` | Read what a background process printed since the last read | no |
| `stop_process` | Stop a background process | no |

`list_dir`, `find_files` and `grep` skip `node_modules`, `.git` and `.agent`. In a git repository they also skip what git ignores, like `dist/` or `.env`, so results stay about your source. `list_dir` names the ignored entries it left out, and naming an ignored folder as the `path` searches it anyway. `grep` also leaves out files that may hold secrets (see [Safety](#safety)), unless one is its `path`.

Long `shell` output keeps its start and end, so the model still sees error summaries and the exit code.

`fetch_url` turns HTML into text with its links, leaving out scripts, menus and footers, so the model can read documentation, an issue, or a page from a server it started. It asks first, like `shell`: a URL can carry data out of your project as well as bring it in.

`delete_file` and `move_file` remove the folders they leave empty, and `move_file` creates the folders the new path needs. So that `/undo` can put things back, they keep what they delete or move in memory, which is why they refuse folders with more than 1000 files or 50 MB, links, and folders with a `.git` inside (another repository). For those, the model has to use `shell`, which asks you first and which `/undo` can't reverse.

Files keep their line endings. Models write `\n`, but Git for Windows checks files out with `\r\n` by default. Edits still match those files, and the lines they add use `\r\n` like the rest of the file.

## Safety

Commands, file changes and web requests ask before they run, unless a [permissions rule](#permissions) or `--yes` allows them. Reading and searching the project doesn't ask, except for files that may hold secrets.

What the model reads goes to its provider, so reading a file that may hold secrets asks first, every time: `.env` files (but not templates like `.env.example`), private keys and certificates (`id_rsa`, `.pem`, `.key` and the like), and credential files like `.npmrc`, `.netrc` and `credentials.json`. `grep` leaves them out of its searches, unless asked to search one.

File tools are limited to relative paths inside the project. Absolute paths and `..` traversal are blocked.

Commands the agent runs don't get your API keys in their environment, so a command that prints its environment doesn't put a key into the conversation.

New files can't be created at the project root, so the agent puts them in a folder like `src/` instead of next to `package.json`. Existing root files, like `package.json` or `.gitignore`, can be edited. The file tools can't change anything inside `.git`.

Generated output that isn't project source, like a report, goes under `.agent/assets/` with `write_asset`. The files stay after the session, and the agent adds a `.agent/.gitignore` so git ignores the folder in whichever project you run it in.

The saved conversations in `.agent/sessions` hold whatever the agent read along the way, like file contents and command output. Git ignores them, but keep them as private as the project.

## Test

```bash
npm test
```
