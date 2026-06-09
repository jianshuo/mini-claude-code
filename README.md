# mini-claude-code

A minimal coding assistant in ~50 lines of JavaScript, powered by the [Moonshot (Kimi)](https://www.moonshot.cn/) API. Inspired by Claude Code — it reads, lists, and edits files via tool calls instead of guessing.

## Files

| File | Description |
|------|-------------|
| `code.js` | Bare-bones assistant: read / list / write files, REPL loop |
| `code_with_skills.js` | Extended version with full `~/.claude/skills` support |

## Requirements

- Node.js 18+
- A Moonshot API key: `export MOONSHOT_API_KEY=sk-...`

## Usage

```bash
npm install

# Basic assistant
node code.js

# Assistant with skills loaded from ~/.claude/skills
node code_with_skills.js
```

## Skills support (`code_with_skills.js`)

At startup the assistant scans `~/.claude/skills/*/SKILL.md`, parses the YAML frontmatter, and loads every skill it finds. Skills follow the [Claude Code skill format](https://docs.anthropic.com/en/docs/claude-code/skills) — a `SKILL.md` with a `name`, `description`, and optional `triggers` list.

### Built-in commands

| Command | Effect |
|---------|--------|
| `/list` | List all loaded skills |
| `/search <query>` | Filter skills by name or description |
| `/<skill-name>` | Activate a skill (injects its full instructions) |
| `/<skill-name> <task>` | Activate a skill and run a task immediately |

Auto-trigger: if your message matches a phrase in a skill's `triggers` list (or its "Triggers —" description line), the skill activates automatically.

### How skills work

When a skill is activated, its `SKILL.md` content is injected as a system message so the model follows its instructions. A second system message enforces that the model must **call tools to execute**, not narrate what it would do.

## Architecture

```
user input
   │
   ├── /list / /search  → local output, no model call
   │
   ├── /skill-name      → inject SKILL.md + execute reminder → agentLoop
   │
   ├── trigger match    → inject SKILL.md + execute reminder → agentLoop
   │
   └── plain message    → agentLoop
                              │
                        Moonshot API (moonshot-v1-8k)
                              │
                        tool_calls → read_file / list_files / edit_file
```
