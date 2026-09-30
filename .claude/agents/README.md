# Project agents

Drop custom subagent definitions here as `<name>.md` files. Each file is
frontmatter + a system prompt, e.g.:

```markdown
---
name: my-agent
description: One-line trigger description shown in the agent list.
tools: Read, Grep, Glob   # optional; omit to inherit all tools
model: sonnet             # optional; omit to inherit the default
---

The agent's system prompt / instructions go here.
```

Agents defined here are scoped to this repo and available via the Agent
tool's `subagent_type` (or by name where the harness lists project agents).
