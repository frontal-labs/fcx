# @fcx/model

Model host interface, ggml-node wrapper, model registry, and mock host for local GGUF model inference.

## Overview

`@fcx/model` provides the abstraction layer between fcx recipes and local LLM inference. It manages model loading, registry lookups, and provides both real (ggml-node) and mock implementations for testing.

## Features

- **ModelHost interface**: Unified interface for all model backends
- **ggml-node wrapper**: Native Node.js bindings to ggml for GGUF model inference
- **Model registry**: Discovery and management of local GGUF models
- **Mock host**: Deterministic mock for testing without models
- **Prompt-prefix caching**: Leverages KV cache reuse for stable system prompts

## Installation

```bash
bun install
```

## API

```ts
import { ModelHost, GgmlModelHost, MockModelHost, ModelRegistry } from "@fcx/model";
```

## Key Modules

- `host.ts` - ModelHost interface definition
- `ggml.ts` - ggml-node integration and inference
- `registry.ts` - Model discovery and metadata
- `mock.ts` - Mock implementation for testing
- `types.ts` - Model and inference types

## Usage

Models are GGUF format, typically ~1.5B parameters optimized for coding tasks. The host supports structured output via JSON schema.

## License

Apache-2.0
