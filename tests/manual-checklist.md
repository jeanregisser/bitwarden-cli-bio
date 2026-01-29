# Manual Testing Checklist

Run these before releases:

## Prerequisites
- [ ] Bitwarden Desktop app running
- [ ] Biometrics enabled in Desktop settings
- [ ] "Allow browser integration" enabled in Desktop settings
- [ ] Same account logged in on CLI and Desktop

## Happy Path
- [ ] `bwbio unlock` triggers Touch ID prompt
- [ ] After unlock, `bwbio get password <item>` works
- [ ] Session persists for subsequent commands
- [ ] `bwbio unlock --raw` outputs just the session key

## Passthrough Commands
- [ ] `bwbio --help` works without Desktop running
- [ ] `bwbio -v` shows version
- [ ] `bwbio status` works without unlock
- [ ] `bwbio login` prompts for login
- [ ] `bwbio logout` logs out
- [ ] `BW_SESSION=xxx bwbio get ...` skips biometrics

## Fallback Scenarios
- [ ] Desktop app closed → falls back to password prompt
- [ ] Cancel Touch ID → falls back to password prompt
- [ ] Different user on Desktop → shows warning, falls back
- [ ] Biometrics disabled in Desktop → shows message, falls back

## Environment Variables
- [ ] `BWBIO_VERBOSE=1` shows debug output
- [ ] Existing `BW_SESSION` is respected (no unlock attempt)

## Cross-Platform (if applicable)
- [ ] macOS: Touch ID works
- [ ] Windows: Windows Hello works
- [ ] Linux: Polkit authentication works
