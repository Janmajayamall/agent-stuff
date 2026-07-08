# Pi default-tool sandbox

Pi extension that runs Pi's default tools through [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime).

Covered default tools: `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`. User `!` bash commands are sandboxed too.

## Install


For normal use, copy this directory to:

```text
~/.pi/agent/extensions/sandbox/
```

Then start Pi or run `/reload`.

## Usage

```text
/sandbox
```

Disable for one run:

```bash
pi -e ~/Desktop/sandbox --no-sandbox
```

## Config

Config files are merged in this order:

1. built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<project>/.pi/sandbox.json` if the project is trusted

Objects are deep-merged. Arrays replace lower-priority arrays; they are not appended.

Example:

```json
{
  "enabled": true,
  "failClosed": true,
  "blockNonDefaultTools": true,
  "allowUnsandboxedCustomTools": ["sagent*"],
  "network": {
    "allowedDomains": ["github.com", "*.github.com", "registry.npmjs.org"],
    "deniedDomains": [],
    "strictAllowlist": true
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

`allowUnsandboxedCustomTools` supports exact names and `*` glob-like patterns. Matching custom tools run unsandboxed in Pi's host process.

## Acknowledgements

- pi's sandbox extension [example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/sandbox)
