# Talkback — hosted voice line with Face ID login

The standalone version of Talkback: a private live voice line to Claude on its
own origin, behind a biometric login, with the transcript held server-side.

This exists because the artifact version could not be a private usable system.
An artifact lives inside the claude.ai viewer, is organisation-internal, cannot
have its own domain, and — being a cross-origin frame — is at the mercy of the
embedder for both microphone and WebAuthn permission. On its own origin all of
that goes away.

**Status: built, not deployed.** It was written for AppDeploy, whose account hit
a permanent lifetime deploy limit (125/125, Free plan) before the first deploy
landed. Everything here is complete and parses clean; it needs a host.

## What it is

```
frontend (react-vite)                backend (@appdeploy/sdk)
  Face ID unlock  ──── passkey ────►  WebAuthn verify (WebCrypto, no deps)
  voice console   ──── /api/chat ───►  ai.generate  ──► reply
  transcript      ──── /api/... ────►  db (credentials, turns, challenges)
```

## Face ID, honestly

"Face ID" here is WebAuthn with a platform authenticator and
`userVerification: 'required'`. On an iPhone or Mac that is literally Face ID or
Touch ID; on Windows it is Hello; on Android it is the device biometric.

What matters is where the biometric is checked: **on the device, by the
operating system.** No face data is transmitted, stored, or seen by this app.
Enrolment sends one public key. Every later sign-in sends a signature that the
backend verifies against that key.

The backend verification (`backend/index.ts`) does the full ceremony rather than
trusting the client:

- the challenge is server-issued, single-use, and consumed on verify, so a
  captured assertion cannot be replayed;
- `clientDataJSON.type` and `.origin` must match the ceremony and the pinned
  origin;
- `rpIdHash` in the authenticator data must equal SHA-256 of the pinned RP ID;
- the UP flag must be set, and the **UV flag must be set** — that bit is what
  distinguishes a real biometric check from a mere tap;
- the signature is verified with WebCrypto (ES256 via `ECDSA P-256`, with the
  DER→raw conversion authenticators require, or RS256);
- the signature counter must advance, which catches a cloned authenticator.

Sessions are HMAC-signed tokens with a server-held key and a 30-day expiry.

### Who may enrol

The first passkey **claims** the app and pins its origin. After that,
registration requires an existing valid session, so a public URL cannot be
taken over once its owner has enrolled. The lock screen says plainly when it is
unclaimed. This is trust-on-first-use: it is only safe if the owner enrols
promptly after deployment.

## Deploying it

### On AppDeploy (what it targets today)

Needs a paid plan — https://appdeploy.ai/pricing. Then deploy with
`app_type: frontend+backend`, `frontend_template: react-vite`, and
`features: ["api", "database", "ai.generate"]`. No secrets or API keys are
required; `ai.generate` is provided by the platform.

### On Railway, Render, Fly or similar

The frontend is plain Vite and portable as-is. The backend needs two swaps,
both contained:

- `db` → Postgres or any store; the tables are `config`, `credentials`,
  `challenges`, `turns`, and nothing is relational.
- `ai.generate` → the Anthropic API with your own key, mapping `system` and
  `messages` across directly.

The WebAuthn code needs no changes: it is pure WebCrypto with no dependencies
and no platform coupling.

## Interface

iOS design language — the system font stack, Apple's published system colour
roles in both appearances, grouped inset lists, sheets with a grabber, and
message bubbles in the transcript. The voice console keeps the audio-reactive
orb: real microphone RMS while listening, and `SpeechSynthesisUtterance`
`onboundary` word events while speaking.

## Traps found building this

- `sample` and most chat APIs read consecutive same-role turns as ONE turn, so a
  leading `user` instructions turn merges with the speaker's first message and
  the model answers the instructions instead of the person. The brief needs an
  explicit end-of-instructions boundary.
- `SVGElement` does not reflect the `hidden` IDL property — it is defined on
  `HTMLElement`. `svg.hidden = true` sets a dead expando and the `[hidden]` rule
  never matches; use `setAttribute`/`removeAttribute`.
- `api.get(url, data)` passes an axios *config*, not query params. Query strings
  have to be built into the URL.
- A side effect inside a `setState` updater runs twice under StrictMode.
- `getUserMedia` in a cross-origin frame fails *before* the browser can ask the
  user unless the embedder delegates `microphone`. WebAuthn is the same, via
  `publickey-credentials-get`. Both are moot on a first-party origin — which is
  the main reason this version exists.
