# @fcx/escalate

Hosted model escalation with approval-gated fallback to hosted models.

## Overview

`@fcx/escalate` provides a safety valve to fall back to hosted models when local models cannot solve a task. All escalations require explicit approval and respect privacy/trust policies.

## Features

- **Approval-gated**: Requires user approval before escalation
- **Policy-aware**: Respects trust, privacy, and policy settings
- **Context filtering**: Only sends necessary, policy-compliant context
- **Audit logging**: Tracks all escalations
- **Graceful fallback**: Seamless handoff to hosted models

## Installation

```bash
bun install
```

## API

```ts
import { shouldEscalate, requestEscalation, EscalationPolicy } from "@fcx/escalate";
```

## Escalation Triggers

- Local model abstains (defense pipeline rejects all candidates)
- Task complexity exceeds local model capabilities
- User explicitly requests escalation

## Privacy

Only minimal necessary context is sent. File contents are filtered based on trust and policy. Escalation is disabled by default and requires `--escalate` or explicit approval.

## License

Apache-2.0
