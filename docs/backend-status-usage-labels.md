# Backend Status Usage — Frontend Labels Plan

The `backendStatus` object in bootstrap provides per-provider usage metrics. Each provider's `rateLimit.primary.usedPercent` means something different. The frontend should display these with appropriate labels and tooltips.

## What each percentage means

### Codex (`backendStatus.codex`)
- **Source**: Codex `account/rateLimits/read` — the `codex` rate limit pool
- **What it measures**: Percentage of the account-wide Codex API rate limit that has been consumed in the current window
- **Window**: Typically 7 days (10080 minutes), resets weekly
- **Label**: "API rate limit"
- **Tooltip**: "Codex API usage — resets weekly"
- **Color**: Blue (`#6e9dff`)

### Spark (`backendStatus.spark`)
- **Source**: Codex `account/rateLimits/read` — auto-detected pool with `limitName` matching "GPT-5.3-Codex-Spark" (currently keyed as `codex_bengalfox`)
- **What it measures**: Percentage of the Spark-specific rate limit consumed
- **Window**: Typically 7 days, resets weekly
- **Label**: "Spark quota"
- **Tooltip**: "Spark API usage — separate from Codex quota, resets weekly"
- **Color**: Yellow (`#f5c451`)
- **Fallback**: If no spark-specific pool is found, fall back to "Shares Codex quota"

### Claude (`backendStatus.claude`)
- **Source**: `claudeActiveThreads.size / claudeMaxConcurrent * 100` — computed locally by ForgeDeck
- **What it measures**: Percentage of available Claude session slots currently in use
- **Not a rate limit**: This is concurrent session utilization, not an API quota
- **Window**: Real-time (current state, not a window)
- **Label**: "Session slots"
- **Tooltip**: "Claude session slots in use (max 4 concurrent)"
- **Color**: Purple (`#cf75ff`)

## Display recommendations

```
Usage card:
┌─────────────────────────────┐
│ 📊 Usage           Pro plan │
│                             │
│ 🤖 Codex   92% ████████░░  │
│ ✨ Spark   25% ██░░░░░░░░  │
│ 🧠 Claude   0% ░░░░░░░░░░  │
└─────────────────────────────┘
```

When hovering over each bar:
- Codex: "92 of 100% used — resets in 6d 4h"
- Spark: "25 of 100% used — resets in 5d 18h"
- Claude: "0 of 4 concurrent slots in use" (no reset — real-time)

When a provider is unavailable:
- Grey out the row
- Show "Unavailable" instead of percentage
