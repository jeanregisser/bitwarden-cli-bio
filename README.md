# bitwarden-cli-bio

Unlock your Bitwarden CLI vault with biometrics (Touch ID, Windows Hello, Linux Polkit) instead of typing your master password. Again. And again.

```bash
# before: ugh
bw get password github
? Master password: [type your 30-character password]

# after: nice
bwbio get password github
# [Touch ID prompt] → done
```

## How?

`bwbio` talks to the Bitwarden Desktop app over IPC — the same protocol the browser extension uses — to unlock your vault with biometrics. Then it hands off to the official `bw` CLI with the session key. You still need `bw` installed; `bwbio` just handles the unlock part.

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│                 │         │    Bitwarden    │         │   Touch ID /    │
│      bwbio      │   IPC   │    Desktop      │  System │  Windows Hello  │
│                 │ ◄─────► │    App          │ ◄─────► │  Linux Polkit   │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │
        │ delegates (with BW_SESSION)
        ▼
┌─────────────────┐
│   Official bw   │
│      CLI        │
└─────────────────┘
```

If biometrics fail for any reason (Desktop app closed, prompt cancelled, etc.), it falls back to the regular password prompt. It never blocks you.

## Setup

**You'll need:**
- Bitwarden Desktop app with biometrics enabled + "Allow browser integration" on
- Node.js >= 22
- Official `bw` CLI in your PATH

**Install:**

```bash
npm install -g bitwarden-cli-bio
```

## Usage

```bash
# The magic: alias it and forget about it
alias bw=bwbio
bw get password github        # Touch ID, done
bw list items --search email  # still Touch ID, still done

# Or use it directly
bwbio get password github

# For scripts — get a session key
eval $(bwbio unlock)
```

If `BW_SESSION` is already set, `bwbio` stays out of the way and passes everything straight to `bw`.

### Commands that skip biometrics

Some commands don't need an unlocked vault and go directly to `bw`:

```
login, logout, lock, config, update, completion, status, serve
--help / -h, --version / -v
```

Everything else triggers biometric unlock if the vault is locked.

## Environment variables

| Variable | Description |
|----------|-------------|
| `BW_SESSION` | Already set? `bwbio` passes through to `bw` directly |
| `BWBIO_VERBOSE` | Set to `1` for verbose IPC logging |
| `BWBIO_IPC_SOCKET_PATH` | Override the IPC socket path (advanced) |

## Platforms

- **macOS** — Touch ID (including App Store builds) — tested
- **Windows** — Windows Hello — should work, not yet tested
- **Linux** — Polkit — should work, not yet tested

The IPC protocol is the same across platforms. If you try Windows or Linux, please [open an issue](https://github.com/jeanregisser/bitwarden-cli-bio/issues) and let us know how it goes!

## Supply chain trust

Every npm release is automatically built and published from CI via [semantic-release](https://github.com/semantic-release/semantic-release), with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) enabled. This means:

- No human runs `npm publish` — releases come directly from GitHub Actions
- Each package on npm links back to the exact source commit and CI run that produced it
- You can verify this on the [npm package page](https://www.npmjs.com/package/bitwarden-cli-bio) (look for the "Provenance" badge)

## Background

This should really be a feature of the official CLI. A [PR was proposed](https://github.com/bitwarden/clients/pull/18273) but was closed — the Bitwarden team wants to wait until they have a proper IPC framework. This wrapper fills the gap in the meantime using the same IPC code from that PR.

## License

[MIT](LICENSE)
