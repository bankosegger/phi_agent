# Tiny Agent

A minimal Node.js coding agent with a basic CLI loop.

## Setup

```bash
npm install
cp .env.example .env # or create .env manually
```

Add your OpenRouter key to `.env`:

```env
OPENROUTER_API_KEY=your_key_here
MODEL=openai/gpt-4o-mini
# Optional: model requests per task before the agent stops (default 25)
# MAX_TOOL_ROUNDS=25
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

## Commands

| Input | Effect |
| --- | --- |
| `/help` | Show the commands |
| `/clear` | Start a new conversation |
| `/exit`, `/quit` | Quit |
| Ctrl+C while the agent works | Cancel the current task and return to the prompt |
| Ctrl+C or Ctrl+D at the prompt | Quit |

A cancelled task keeps the conversation usable: any tool calls it had started are recorded as cancelled, and you can carry on with a new task. Cancelling also stops a running `shell` command and any processes it started.

Before a tool that changes files runs, the agent shows what it will do: `edit_file` shows the removed and added lines, and `write_file` says whether it creates a new file or overwrites an existing one.

## Tools

| Tool | Purpose | Asks for confirmation |
| --- | --- | --- |
| `read_file` | Read a file, optionally a line range | no |
| `list_dir` | List a directory, optionally recursively | no |
| `grep` | Regex search across project files | no |
| `git` | Read-only `status`, `diff` (optionally `--staged`), or `log` | no |
| `edit_file` | Replace one unique string in a file | yes |
| `write_file` | Write a file in a project subfolder | yes |
| `append_file` | Append to a file in a project subfolder | yes |
| `write_asset` | Store a generated file under `.agent/assets/` | yes |
| `shell` | Run a shell command | yes |

`list_dir` and `grep` skip `node_modules`, `.git` and `.agent`.

## Safety

File tools are limited to relative paths inside the project. Absolute paths and `..` traversal are blocked.

Root-level writes like `hello.js` are blocked. Project writes must go in a subfolder like `src/hello.js`.

Generated files/assets should use `write_asset`; they go under `.agent/assets/`, which is gitignored and cleared at the start and end of each CLI session.

## Test

```bash
npm test
```
