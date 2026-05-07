# pi-adaptive-finder

Fast read-only Finder for Pi. It uses local `rg` and path retrieval first, then optionally reranks candidate files with fast OpenAI-compatible providers such as Cerebras or Groq.

## Why

Normal codebase spelunking burns agent context and time. This tool makes one broad reconnaissance pass and returns likely entrypoints, supporting files, and line-cited evidence.

## Install

From npm, once published:

```bash
pi install npm:pi-adaptive-finder
```

From a local checkout while developing:

```bash
pi install /absolute/path/to/pi-adaptive-finder
```

Temporary one-run test:

```bash
pi -e /absolute/path/to/pi-adaptive-finder
```

## Tool

By default the extension registers:

```text
adaptive_finder
```

Example prompt inside Pi:

```text
Use adaptive_finder to find where saved views are implemented in Nexus, including hooks, API clients, mocks, and tests.
```

To replace an existing `finder` tool instead:

```bash
export PI_ADAPTIVE_FINDER_TOOL_NAME=finder
```

## Provider presets

The extension works without an API key using local ranking only. With API keys, it adds rerankers.

### Cerebras

```bash
export CEREBRAS_API_KEY="..."
export PI_ADAPTIVE_FINDER_PRESET=cerebras
```

Default Cerebras rerankers:

- `gpt-oss-120b`, `reasoning_effort: low`
- `zai-glm-4.7`, `reasoning_effort: none`

On macOS it also checks Keychain services:

- `cerebras-api-key`

### Groq

```bash
export GROQ_API_KEY="..."
export PI_ADAPTIVE_FINDER_PRESET=groq
```

Default Groq rerankers:

- `openai/gpt-oss-120b`, `reasoning_effort: low`
- `openai/gpt-oss-20b`, `reasoning_effort: low`

On macOS it also checks Keychain services:

- `groq-api-key`

### Auto

Default preset:

```bash
export PI_ADAPTIVE_FINDER_PRESET=auto
```

`auto` tries available Cerebras and Groq rerankers, capped by `PI_ADAPTIVE_FINDER_MAX_RERANKERS`.

### Local only

```bash
export PI_ADAPTIVE_FINDER_PRESET=local
```

## Custom OpenAI-compatible rerankers

Set `PI_ADAPTIVE_FINDER_RERANKERS` to a JSON array. Each provider uses chat completions. `baseUrl` can be either the API root or the full `/chat/completions` endpoint.

```bash
export PI_ADAPTIVE_FINDER_RERANKERS='[
  {
    "name": "groq-oss-120b",
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyEnv": "GROQ_API_KEY",
    "model": "openai/gpt-oss-120b",
    "reasoningEffort": "low"
  },
  {
    "name": "cerebras-glm",
    "baseUrl": "https://api.cerebras.ai/v1",
    "apiKeyEnv": "CEREBRAS_API_KEY",
    "model": "zai-glm-4.7",
    "reasoningEffort": "none",
    "extraBody": { "clear_thinking": false }
  }
]'
```

Supported fields:

```ts
type RerankerConfig = {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
  keychainService?: string;
  reasoningEffort?: "none" | "low" | "medium";
  maxCompletionTokens?: number;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
};
```

## Other configuration

```bash
export PI_ADAPTIVE_FINDER_TOOL_NAME=adaptive_finder
export PI_ADAPTIVE_FINDER_PRESET=auto
export PI_ADAPTIVE_FINDER_MAX_RERANKERS=2
export PI_ADAPTIVE_FINDER_MAX_CANDIDATES=72
export PI_ADAPTIVE_FINDER_MAX_SELECTED=8
export PI_ADAPTIVE_FINDER_TIMEOUT_MS=12000
```

## Development

```bash
npm install
npm run check
npm run pack:check
pi -e .
```

## Publish to npm

1. Pick the package name and update `package.json` metadata.
2. Login:

```bash
npm login
```

3. Verify the tarball:

```bash
npm run pack:check
```

4. Publish:

```bash
npm publish --access public
```

5. Install from npm:

```bash
pi install npm:pi-adaptive-finder
```

Pi's package gallery discovers npm packages tagged with the `pi-package` keyword.

## Security

Pi extensions run with full local permissions. This extension is read-only by design and shells out only to `rg` and macOS `security` for optional Keychain lookup. Review code before installing any third-party Pi package.
