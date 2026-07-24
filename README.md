<p align="center">
  <img src="docs/header.svg" width="828" alt="open-cursor — cursor pro models, inside opencode">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rama_nigg/open-cursor"><img src="https://img.shields.io/npm/v/%40rama_nigg/open-cursor?style=flat-square&color=555&labelColor=333" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@rama_nigg/open-cursor"><img src="https://img.shields.io/npm/dm/%40rama_nigg/open-cursor?style=flat-square&color=555&labelColor=333" alt="downloads per month"></a>
  <img src="https://img.shields.io/badge/linux%20%C2%B7%20macos%20%C2%B7%20windows-555?style=flat-square&labelColor=333" alt="linux, macos, windows">
</p>

<p align="center">
  <a href="https://nomadcxx.github.io/opencode-cursor/docs/">Documentation</a>
</p>

`open-cursor` connects OpenCode to the models available through your Cursor
subscription. It translates prompts, streaming responses, thinking, and tool
calls between OpenCode and `cursor-agent`.

## Installation

You need OpenCode, a Cursor subscription, and the `cursor-agent` command.

Install the package and configure OpenCode:

```bash
npm install -g @rama_nigg/open-cursor
open-cursor install
```

Authenticate and verify the provider:

```bash
cursor-agent login
opencode models | grep cursor-acp
```

The final command should list `cursor-acp/auto`. The installer backs up your
existing OpenCode configuration before writing it and does not touch `.cursor`
by default.

For shell, manual, and source installation, see the
[installation guide](https://nomadcxx.github.io/opencode-cursor/docs/getting-started/installation/).

Upgrade with `npm update -g @rama_nigg/open-cursor`, then restart OpenCode.

## Usage

Run a prompt with automatic model selection:

```bash
opencode run "Summarise this repository in five bullets." \
  --model cursor-acp/auto
```

You can also start `opencode` and choose a `cursor-acp/*` model from its model
picker.

## Documentation

- [Installation](https://nomadcxx.github.io/opencode-cursor/docs/getting-started/installation/)
- [Authentication](https://nomadcxx.github.io/opencode-cursor/docs/getting-started/authentication/)
- [Configuration](https://nomadcxx.github.io/opencode-cursor/docs/reference/configuration/)
- [Choosing a model](https://nomadcxx.github.io/opencode-cursor/docs/guides/choosing-a-model/)
- [MCP servers](https://nomadcxx.github.io/opencode-cursor/docs/guides/mcp-servers/)
- [Troubleshooting](https://nomadcxx.github.io/opencode-cursor/docs/getting-started/troubleshooting/)
- [Architecture](https://nomadcxx.github.io/opencode-cursor/docs/architecture/overview/)
- [Development](https://nomadcxx.github.io/opencode-cursor/docs/development/building/)

## License

BSD-3-Clause

---

<a href="https://github.com/Nomadcxx"><img src="https://raw.githubusercontent.com/Nomadcxx/Nomadcxx/main/assets/rama-mark.svg" height="22" alt="RAMA"></a> — terminal-native tooling for the linux desktop.
[More projects →](https://github.com/Nomadcxx) · [Sponsor](https://github.com/sponsors/Nomadcxx) ❤️
