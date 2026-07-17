# Backend Status Usage — Frontend Labels Plan

The `backendStatus` object from `/api/account/status` provides per-provider usage metrics. Each provider's `rateLimit.primary.usedPercent` means something different. The frontend should display these with appropriate labels and tooltips. ForgeDeck admission may reserve the operator-configured headroom percentage, but that quota fact is still not a currency cost; versioned estimates are exposed separately by `/api/usage`.

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
- **Sources**: ForgeDeck's active Claude session tracker, plus Claude Code's Anthropic `rate_limit_event` when the provider rejects a request
- **What it measures**: Local Claude session-slot utilization (`activeCount / maxConcurrent`), unless Anthropic has reported that the provider limit is exhausted.
- **Persistence**: Provider observations are stored in `provider_quota_events`, survive ForgeDeck restarts, and expire at Anthropic's reset time. A rejection without a reset time uses the configured quota-staleness window.
- **Provider override**: A current rejected event reports 100% until reset. An allowed event clears an earlier rejection and returns the display to local session-slot utilization, marked with `rateLimit.source` as `local_concurrency`.
- **Window**: Local utilization is real-time; a provider rejection identifies its window (for example, `five_hour`) and supplies `resetsAt`.
- **Label**: "Session slots"
- **Tooltip**: "Claude session slots in use; provider-reported rejections show 100% until reset"
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
- Claude: "API session limit reached — resets in 58m" when provider-limited; otherwise the local slot fallback

When a provider is unavailable:
- Grey out the row
- Show "Unavailable" instead of percentage
