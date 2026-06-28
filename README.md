# pi-model-filter

Filter and block models from any provider in pi via declarative allow/block rules.

Hide unwanted GitHub Copilot models, enforce global allowlists, block by reasoning capability or context window size — all through a simple JSON config.

## Install

```bash
pi install pi-model-filter
```

## Configuration

Create `model-filter.json` in pi's agent directory (typically `~/.pi/agent/model-filter.json`):

### Schema

```typescript
interface FilterRule {
  provider: string;      // "*" = any provider
  action: "allow" | "block";
  match: {
    ids?: string[];                    // exact model ID match (OR)
    patterns?: string[];               // glob patterns (OR), supports * and ?
    reasoning?: boolean;               // match reasoning capability
    contextWindow?: { min?: number; max?: number }; // match context window size
  };
}

interface FilterConfig {
  rules: FilterRule[];                 // evaluated top-to-bottom, first match wins
  defaultAction: "allow" | "block";   // default: "allow"
}
```

### Rule evaluation

- Rules are evaluated **top to bottom** — first matching rule wins.
- Within a match field, alternatives are **OR'd** (e.g., `ids: ["a", "b"]` matches either).
- Across different match fields, conditions are **AND'd** (e.g., `ids + reasoning` must both match).
- If no rule matches, `defaultAction` applies.
- Invalid or missing config fails open: all models pass through with a warning.

### Examples

**Allowlist for Copilot, leave other providers untouched:**

```json
{
  "rules": [
    {
      "provider": "github-copilot",
      "action": "allow",
      "match": { "ids": ["claude-opus-4.6", "gpt-5.4", "gpt-5.5"] }
    },
    {
      "provider": "github-copilot",
      "action": "block",
      "match": { "patterns": ["*"] }
    }
  ],
  "defaultAction": "allow"
}
```

**Strict global allowlist:**

```json
{
  "rules": [
    {
      "provider": "github-copilot",
      "action": "allow",
      "match": { "ids": ["claude-opus-4.6", "gpt-5.4", "gpt-5.5"] }
    }
  ],
  "defaultAction": "block"
}
```

**Block non-reasoning models:**

```json
{
  "rules": [
    { "provider": "*", "action": "block", "match": { "reasoning": false } }
  ],
  "defaultAction": "allow"
}
```

**Block small context windows:**

```json
{
  "rules": [
    { "provider": "*", "action": "block", "match": { "contextWindow": { "max": 150000 } } }
  ],
  "defaultAction": "allow"
}
```

## How it works

The extension patches `ModelRegistry.prototype` at load time (before startup model resolution) so filtered models are hidden from `/model`, `--model` CLI flags, and request auth resolution. It does not mutate the registry's internal model array — filtering happens on method results.

### Failure behavior

- **Missing or invalid config**: all models pass through, warning logged.
- **pi internals change**: extension detects missing methods and disables itself with a warning.
- **Hot reload**: editing `model-filter.json` takes effect without restarting pi.

## Status

Early release — see [PLAN.md](PLAN.md) for full design details.
