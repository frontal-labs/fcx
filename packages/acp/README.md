# @fcx/acp

Agent Client Protocol (ACP v10) server over stdio for IDE integration.

## Overview

`@fcx/acp` implements the [Agent Client Protocol](https://agentclientprotocol.com/) to allow fcx to integrate with ACP-compatible editors and IDEs like Zed, JetBrains, etc. It exposes fcx functionality over stdio using the ACP SDK.

## Features

- **ACP v10 compliant**: Full implementation of Agent Client Protocol
- **stdio transport**: Works with editor integrations
- **Recipe exposure**: Maps fcx recipes to ACP operations
- **Session management**: Handles ACP sessions and context
- **Tool integration**: Exposes fcx tools to ACP clients

## Installation

```bash
bun install
```

## Usage

```bash
fcx acp
```

The server communicates over stdin/stdout using JSON-RPC as per ACP specification.

## API

```ts
import { startAcpServer } from "@fcx/acp";
```

## Dependencies

- `@agentclientprotocol/sdk` 2.2.0

## Integration

Configure your ACP-compatible editor to run `fcx acp` as the agent server.

## License

Apache-2.0
