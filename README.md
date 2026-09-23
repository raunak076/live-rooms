# Live Rooms

A working Node.js chat application with a clean responsive UI, gentle bounce animations, live group rooms, username contacts, private conversations, and a Gemini assistant you can mention inside any chat.

## Run on Windows / macOS / Linux

Install Node.js 22.13+ (Node 24 recommended), unzip, open a terminal inside `live-rooms`, then:

```sh
npm ci
```

Copy `.env.example` to `.env`. Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```sh
cp .env.example .env
```

Edit `.env` with your own Google Gemini API key:

```dotenv
PORT=3000
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
```

Then:

```sh
npm start
```

Open http://localhost:3000. Create an account with a unique username and password. In a second browser or incognito window, create another account to test live delivery.

Get a key at https://aistudio.google.com/apikey. The model is configurable: use a Flash model available to your project. The API integration follows Google's Interactions REST API: https://ai.google.dev/gemini-api/docs/get-started. The API key stays server-side and is never returned to the browser. Without a key, normal chat works and AI mentions show a configuration error.

## What is included

- Create group rooms and join through a shareable link or room code.
- Username-based accounts with salted scrypt password hashes and seven-day sessions.
- Find an existing username and open a private, two-account conversation.
- Switch between multiple rooms and contacts, with unread counts while connected and separate message drafts.
- WebSocket-first Socket.IO transport with polling fallback and reconnection.
- Optimistic message rendering, server acknowledgements and duplicate suppression for retries of retained messages.
- Online members, typing indicators and Gemini thinking feedback.
- Low-latency WebRTC voice calls in group rooms and private chats, with incoming-call prompts, mute, call duration, participant count and clean hang-up handling.
- Installable PWA experience on supported desktop and mobile browsers, with an iPhone/iPad Add to Home Screen hint.
- Permission-based Web Push notifications for new messages and incoming calls, including system notification sound/vibration when the OS and browser allow it.
- Android notification actions for replying or clearing a message without opening the chat.
- Authenticated image, audio-file and recorded voice-note sharing (up to 8 MB per attachment).
- Camera capture, multi-contact group creation, profile About text and optional read receipts.
- `@gemini` mentions trigger an AI answer in the same room; ordinary messages do not call AI.
- Delete your own messages for everyone. The server checks ownership and replaces retained content with a tombstone.
- SQLite persistence for accounts, hashed sessions, room membership and the most recent 100 messages per chat.
- Responsive layout, button spring feedback and message-entry bounce; respects reduced-motion settings.

Example: `@gemini explain Java HashMap with a small example`.

Click **Voice** inside any conversation and allow microphone access. Other online members in that chat see a join prompt. Audio travels over WebRTC; Socket.IO only relays the small offer, answer and ICE setup messages.

After signing in, click **Allow** on the notification card so messages and incoming calls can alert you while the tab is in the background. Browser and phone notification settings control the final sound/vibration behavior. On iPhone/iPad, install the app from **Share → Add to Home Screen** before enabling Web Push.

## Data and behavior

Each AI mention sends up to 20 recent, non-deleted messages from that chat to Google. Its reply is visible to everyone in the chat. Deleting a message removes its text from the application's retained history, but cannot retract data already seen by participants, sent to Google, copied, or included in an earlier AI response. Database backups and SQLite WAL pages are not secure-erased by a deletion. Pending AI replies are suppressed when their trigger message was deleted before completion.

Room invites grant access to anyone signed in who has the link. DMs cannot be joined by outsiders, even if their ID is known. This is not end-to-end encrypted chat: the server stores message text and can read it. Session tokens are stored in browser local storage and only their hashes are stored in SQLite. Sign out revokes the current token. Account deletion is password-confirmed from Profile; password reset is not included.

This version retains 100 messages per conversation. Older messages are automatically removed. Rooms and contacts remain across server restarts. Unread badges are per active browser session. Direct-message read receipts persist unless the reader disables them in Profile. Presence means connected to the service, not necessarily currently viewing that conversation.

Uploaded media is stored under the persistent `data/uploads` directory and is served only after session and room-membership checks. Deleting its chat message makes the media endpoint unavailable, although the underlying file is retained for operational recovery.

## Hosting

Use a Node.js host with WebSocket support and persistent local disk. Run one application process for this version; SQLite and in-memory AI limits are designed for a single instance. Set `APP_ORIGIN` to the exact HTTPS origin of your deployed app. Terminate HTTPS at your reverse proxy and forward WebSocket upgrade headers. Keep `data/` on persistent storage and back it up. Never commit `.env` or expose the data directory as static assets.

A Dockerfile and Compose file are included:

```sh
docker compose up --build -d
```

Open port 3000 locally. For internet access, configure a domain, HTTPS proxy and APP_ORIGIN. The Compose file mounts `chat-data` at `/app/data` so accounts and chats survive container recreation.

Performance choices reduce avoidable client wait time, but no internet latency SLA or load-tested capacity is claimed. Gemini response time is separate from chat delivery. For multiple server instances, move persistence to a shared database, use the Socket.IO Redis adapter, centralize rate limits, and load-test before scaling. The built-in limits are basic abuse controls, not a complete internet-scale defense.

Microphone access works on `localhost` during development and requires HTTPS when deployed. The server supplies STUN plus TURN/turns routes to the browser and the client performs an ICE restart when the selected path fails. For reliable calls across restrictive office/mobile NATs, configure `TURN_HOST`, `TURN_URLS` and either `TURN_USERNAME` + `TURN_CREDENTIAL` or `TURN_SECRET` in production. Group calls use a peer-to-peer mesh, which is best for small rooms; use an SFU such as LiveKit, mediasoup or Janus before supporting large voice rooms.

## Verification

```sh
npm test
```

Integration tests use real Socket.IO clients and temporary SQLite databases. They cover room delivery, private-chat isolation, authenticated access, call membership and signaling, delete ownership, deletion propagation, retries, AI mention routing with a mocked provider, token reconnect and persistence after restart. A separate check verifies the missing-key behavior. Actual Gemini output requires your API key and was not tested against Google.

The application starts and HTTP endpoints were verified. Automated visual browser review was blocked because the available browser could not open the local server; visual appearance has not been independently screenshot-verified.

## Files

- `server.js`: Express, authentication, Socket.IO events, SQLite and Gemini integration.
- `public/`: HTML, CSS, browser client and favicon.
- `test/chat.test.js`: multi-client integration tests.
- `.env.example`: environment setup.
- `Dockerfile`, `compose.yaml`: single-instance container deployment.
