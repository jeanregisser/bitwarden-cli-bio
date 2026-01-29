# bitwarden-cli-bio

A CLI wrapper for Bitwarden that adds biometric unlock support via the Desktop app.

## Why?

The official `bw` CLI requires typing your master password every time you unlock. This wrapper brings biometric unlock (Touch ID, Windows Hello, Polkit) to the CLI by talking to the Desktop app over IPC — the same way the browser extension does.

This should ideally be built into the official CLI — a [PR was proposed](https://github.com/bitwarden/clients/pull/18273) but was closed by the Bitwarden team citing maintenance concerns until they have a proper IPC framework. This standalone wrapper fills the gap in the meantime.

## How It Works

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  bitwarden-cli  │   IPC   │    Bitwarden    │  System │    Touch ID /   │
│      -bio       │ ◄─────► │   Desktop App   │ ◄─────► │  Windows Hello  │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │
        │ delegates (with BW_SESSION)
        ▼
┌─────────────────┐
│   Official bw   │
│      CLI        │
└─────────────────┘
```

### Decision Flow

```
bwbio <args>
    │
    ├─► BW_SESSION already set?
    │       └─► YES → delegate to bw immediately
    │
    ├─► Command is passthrough? (login, logout, status, --help, etc.)
    │       └─► YES → delegate to bw immediately
    │
    └─► Vault locked & command needs unlock?
            └─► Attempt biometric unlock via Desktop IPC
                    │
                    ├─► Success → delegate to bw with BW_SESSION
                    └─► Failure → fall back to bw unlock (password prompt)
```

## Prerequisites

- **Bitwarden Desktop app** with biometrics enabled and "Allow browser integration" turned on
- **Node.js** >= 22
- **Official `bw` CLI** installed and available in PATH

## Install

```bash
npm install -g bitwarden-cli-bio
```

## Usage

```bash
# Use it like bw — biometric unlock happens automatically
bwbio list items --search github
bwbio get password github

# Explicit unlock for scripts (outputs BW_SESSION export)
eval $(bwbio unlock)

# Or alias it for seamless use
alias bw=bwbio
bw get password github  # uses biometrics automatically
```

If `BW_SESSION` is already set, all commands pass through directly to `bw` without any unlock attempt.

## Passthrough Commands

These commands are passed directly to `bw` without attempting unlock:

```
login, logout, lock, config, update, completion, status, serve
--help / -h, --version / -v
```

All other commands trigger biometric unlock if the vault is locked.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BW_SESSION` | If set, all commands pass through to `bw` directly (no biometric unlock attempt) |
| `BWBIO_VERBOSE` | Set to `1` to enable verbose IPC logging |
| `BWBIO_IPC_SOCKET_PATH` | Override the IPC socket path (advanced) |

## Platforms

- **macOS** — Touch ID (including sandboxed App Store builds of Bitwarden Desktop) ✅ Tested
- **Windows** — Windows Hello (untested — feedback welcome)
- **Linux** — Polkit (untested — feedback welcome)

The IPC protocol is the same across platforms, so Windows and Linux should work but haven't been verified yet. If you try it, please [open an issue](https://github.com/jeanregisser/bitwarden-cli-bio/issues) with your results.

## License

[MIT](LICENSE)
