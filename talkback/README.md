# Talkback — live voice line to Claude

A published Claude Artifact that turns a browser into a two-way voice channel:
you speak, Claude answers out loud, and the whole transcript is mirrored into a
relay that a Claude Code session can read and write.

Live page: https://claude.ai/artifact/Mg2aPLkXALLgfZACoyFzHb

`talkback.html` is the source of record. It is published with
`capabilities: {sample: {}, db: {}}` on runtime contract 0.2.49.

## Why it is built this way

A Claude Code session runs in an ephemeral container with no microphone and no
speakers, so the audio has to happen on the operator's own device. The obvious
design — a hosted relay service that posts speech into the session — does not
work: a session's inbound webhook only accepts deliveries sealed by the artifact
service, and a plain POST to it returns `401 unauthorized`. That rules out
Twilio, Retell or ElevenLabs webhooks reaching a session directly.

What does work is the artifact runtime. The page runs on the operator's device,
where the microphone actually is, and both halves of the loop are capabilities
the viewer grants it:

```
        speech ──► SpeechRecognition ──► sample() ──► SpeechSynthesis ──► audio
   (browser STT)                     (Claude, per turn)        (browser TTS)
                                            │
                                            ▼
                                     db  (the relay)
                                            │
                            read_db / write_db from Claude Code
```

## Signal path

## Interface

The page is a voice surface, not a dashboard: one audio-reactive orb as the hero,
a large live caption, and a single call control. The orb is driven by real signal
— mic RMS off an `AnalyserNode` while listening, and `SpeechSynthesisUtterance`
`onboundary` word events while speaking — not a decorative loop. Diagnostics and
voice/language settings live in a settings sheet; the transcript is a slide-over
panel with an unread badge.

| Stage | Mechanism | Notes |
|---|---|---|
| Speech in | Web Speech API `SpeechRecognition` | Chrome, Edge, Safari. Firefox has none — the page falls back to a text field. |
| Level meter | `getUserMedia` + `AnalyserNode` RMS | Real dBFS, not a decorative animation. |
| Brain | `claude.use("sample")`, `modelTier: "quick"` | Per-turn; no memory beyond the transcript the page sends. |
| Voice out | `SpeechSynthesis` | Speaks each sentence as it streams, so the reply starts before it is finished. |
| Relay | `claude.use("db")` | Durable, readable and writable from a Claude Code session. |

`sample` is deliberately on the `quick` tier: it does not think before writing,
so the first words arrive in about a second instead of 5–60. Replies are spoken
sentence-by-sentence off the `onText` stream rather than after the promise
resolves — that is what keeps the line feeling live.

## Relay protocol

Two documents in the artifact's database.

`relay/outbound` — Claude Code writes, the page reads and speaks:

```json
{ "messages": [ { "id": "m1", "text": "Spoken aloud on the open line.", "at": "..." } ] }
```

Append to `messages`; every open page speaks each id it has not seen. A page
marks the backlog seen on load, so messages written while nothing was listening
are not replayed at the next open.

`relay/status` — the page writes, Claude Code reads:

```json
{ "sessionId": "s20260915-xxxxx", "state": "listening",
  "turnCount": 12, "micOpen": true, "updatedAt": "...",
  "lastSpokenId": "m1", "lastSpokenAt": "..." }
```

`sessions/<sessionId>` — one document per channel, holding the rolling
transcript (last 60 turns, each capped at 4 000 characters). The store caps an
artifact at 5 000 documents, so turns are aggregated into the session document
rather than written one document per turn.

Read the live conversation from a Claude Code session with the Artifact tool:

```
action: read_db   db_op: list   collection: sessions
action: write_db  db_op: update collection: relay  doc_id: outbound
```

## Three traps worth knowing

- `sample` reads consecutive same-role turns as ONE turn. A leading `user`
  instructions turn therefore merges with the viewer's first `user` message,
  and the model answers the instructions instead of the person — then denies
  on the next turn that they ever said anything. The brief must end with an
  explicit end-of-instructions boundary.

- `SVGElement` does not reflect the `hidden` IDL property (it is defined on
  `HTMLElement`). `svg.hidden = true` silently sets a JS expando and the
  `[hidden]` CSS rule never matches, so icon swaps must use
  `setAttribute("hidden", "")` / `removeAttribute("hidden")`.
- `DocumentReference.update()` rejects `invalid_argument` when the document does
  not exist yet. `relay/status` is therefore written with a single `set` of the
  whole body, so `lastSpokenId` is not silently dropped on a fresh channel.

## When the microphone will not open

`getUserMedia` inside an artifact frame can fail before the browser ever asks
the viewer, because a cross-origin frame only gets the microphone if the
embedder delegates it via `allow="microphone"`. The page distinguishes that
case from an ordinary permission denial (`document.featurePolicy
.allowsFeature("microphone")` plus the `DOMException.name`), says which one it
hit, and writes `micError` / `micFramed` / `micPolicy` onto `relay/status` so
the reason is readable from a Claude Code session without the viewer having to
describe it. If the embedder is the blocker, browser speech cannot run here at
all and the voice side has to be hosted outside artifacts.

## Operating notes

- **Half duplex** (default) mutes the microphone while Claude speaks, so the
  synthesiser is never transcribed back as input. **Barge-in** leaves the
  microphone open and cuts Claude off the moment you start talking — better on
  headphones, prone to echo loops on speakers.
- Recognition defaults to `en-AU`.
- The page holds the conversation; `sample` has no memory of its own. Reloading
  starts a fresh channel with a new session id.
- Speech recognition in Chrome is cloud-backed, so utterances leave the device
  to be transcribed. Everything said on the channel is written to the artifact
  database, which is organization-internal and readable by anyone who can open
  the artifact. Do not read secrets onto the line.
