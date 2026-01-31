# AGENTS.md

## What is this?

A CLI wrapper (`bwbio`) for the official Bitwarden CLI (`bw`) that adds biometric unlock via the Bitwarden Desktop app. Communicates with the Desktop app over IPC using the same native messaging protocol as the browser extension.

Zero runtime dependencies — pure Node.js built-ins only.

## Commands

```bash
npm run build          # Build with tsup (ESM output to dist/)
npm run typecheck      # TypeScript strict checking
npm run lint           # Check with biome
npm run lint:fix       # Auto-fix with biome
npm test               # Unit tests (src/**/*.test.ts)
npm run test:e2e       # E2E tests (tests/**/*.e2e.ts, needs bw CLI installed)
npx vitest run         # All tests (unit + e2e)
```

Run a single test file or by name:
```bash
npm test -- src/fingerprint.test.ts
npm test -- -t "returns a stable word phrase"
```

## Architecture

**Decision flow** (`src/main.ts`): Mirrors `--quiet`/`--nointeraction` to env vars → skip biometric if `BW_SESSION` set, `BW_NOINTERACTION`, or passthrough command → attempt biometric unlock → fall back to `bw` on failure.

**IPC protocol** (`src/ipc/`): RSA key exchange → AES-256-CBC + HMAC-SHA256 encrypted channel over Unix socket (macOS/Linux) or named pipe (Windows). Must match Bitwarden Desktop exactly — changes here risk breaking compatibility.

**Session storage** (`src/session-storage.ts`): Encrypts user key with a generated session key using Bitwarden's encryption type 2 format, stores in CLI's `data.json`.

**Fingerprint** (`src/fingerprint.ts`): SHA-256 → HKDF-Expand → EFF wordlist lookup. Must produce identical output to Bitwarden Desktop's algorithm.

**Passthrough** (`src/passthrough.ts`): Commands that skip unlock (`login`, `logout`, `status`, etc.). Conservative — unknown commands default to requiring unlock.

**Logging** (`src/log.ts`): `log()` respects `BW_QUIET`, `logVerbose()` requires `BWBIO_VERBOSE=true`. All user messages go to stderr; stdout is reserved for command output.

## Conventions

- **Biome** for linting/formatting (not eslint/prettier), LF line endings enforced
- **Vitest** for testing with fake timers for IPC timeout tests
- **Conventional commits** — semantic-release auto-publishes from main. Short title only (no body), lowercase, no trailing period. Examples: `feat: add biometric unlock`, `fix: handle timeout on Windows`, `test: add IPC client tests`, `chore: upgrade deps`
- Environment vars use `"true"` not `"1"`, matching the original `bw` CLI
- E2E tests use `MockDesktopServer` to simulate the Desktop app IPC
