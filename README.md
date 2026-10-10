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

## Safety

File tools are limited to relative paths inside the project. Absolute paths and `..` traversal are blocked.

Root-level writes like `hello.js` are blocked. Project writes must go in a subfolder like `src/hello.js`.

Generated files/assets should use `write_asset`; they go under `.agent/assets/`, which is gitignored and cleared at the start and end of each CLI session.

## Test

```bash
npm test
```
