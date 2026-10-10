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

## Test

```bash
npm test
```
