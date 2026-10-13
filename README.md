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
