# Beam

A small, no-frills video calling app — think Google Meet, built from scratch to actually understand how WebRTC works instead of just importing a library. No accounts, no database. Create a room, share the link, talk.

## What it does

**Video calls, multiple people at once.** Every participant connects directly to every other participant (a WebRTC mesh), so there's no media server in the middle re-streaming video — your camera and mic go straight to everyone else in the room.

**Room codes and shareable links.** Creating a room gives you a short 6-character code (e.g. `qa4e96`) and a link like `beamwebrtc.vercel.app/r/qa4e96`.

**Host approval before joining.** Rooms aren't open-door — anyone joining via a code or link "knocks" first, and the host sees a request with the person's name and can approve or deny it. Nobody ends up in your call uninvited.

**Roster panel.** A people icon in the call shows a live count of who's in the room; clicking it lists everyone by name, with the host clearly labeled. Closes automatically if you click anywhere else.

**Join/leave notifications.** When someone leaves the room, everyone else gets a quick toast saying so — no wondering if someone's video just froze or they actually left.

**Camera and mic controls.** Toggle either on or off mid-call. A live volume meter on your own mic gives you visual proof it's actually picking up sound, since (unlike the camera) there's nothing else to look at.

**Works behind strict networks, too.** Direct peer-to-peer connections fail on some networks (symmetric NAT, corporate firewalls). Beam falls back to a TURN relay server in that case, so calls still connect instead of silently failing.

**Survives a dropped connection.** If a host's phone locks or the app gets backgrounded for a moment, the room doesn't instantly collapse — the server holds it open for a short grace period, and the client automatically reconnects and resumes right where it left off, including replaying any join requests that came in while the connection was down. While actively hosting, Beam also requests a screen wake lock so the phone's screen doesn't sleep and trigger this in the first place.

## How it's built

- **Client:** React 19 + Vite, plain TypeScript, no UI framework — hand-rolled CSS.
- **Signaling:** a raw WebSocket server (Node + the `ws` library, no Socket.IO) that only ever relays small JSON messages — room creation, join requests, WebRTC offers/answers/ICE candidates. It never touches the actual audio/video.
- **Media:** native browser WebRTC APIs (`RTCPeerConnection`, `getUserMedia`) end to end — nothing wrapping it.
- **Monorepo:** pnpm workspaces with three packages — `client/`, `server/`, and `shared/` (just the TypeScript types both sides agree on).

## Running it locally

```bash
pnpm install          # from the repo root — resolves the shared/ workspace package
pnpm --filter server dev
pnpm --filter client dev
```

The client defaults to `ws://localhost:3000` if `VITE_WS_URL` isn't set, so local dev works with no `.env` file at all. Copy `client/.env.example` to `client/.env` if you want to test against a real TURN server or a deployed signaling server.

## Deployment

The client and server are hosted in two completely different places, because they have completely different needs.

**Client → Vercel.** It's a static Vite build, so Vercel just serves the compiled files off a CDN — no server needed. The one wrinkle: `client/vercel.json` adds a catch-all rewrite so a direct link like `/r/qa4e96` serves `index.html` instead of 404ing (a normal static host has no idea that route belongs to the client-side router, not a real file). The Vercel project's Root Directory is set to `client/`, with "include files outside the Root Directory" turned on so the build can still resolve the `@beam/shared` workspace package that lives next to it.

**Server → a Google Cloud e2-micro VM, on the Always Free tier.** A signaling server needs to be reachable and holding WebSocket connections open for as long as calls are running, which rules out most free PaaS options (Render, Railway, etc.) — they spin the service down after a stretch of inactivity, which would just kill live calls. GCP's Always Free tier includes one e2-micro VM, running 24/7, for $0 (only in a few specific regions, and only with a Standard — not Balanced — boot disk; both are easy to get wrong when creating the instance). The compiled server (`server/dist/index.js`) runs there as a plain Node process under `systemd`, which means it starts on boot and restarts on its own if it ever crashes.

**Caddy, as the reverse proxy in front of it.** The VM's firewall only opens ports 80 and 443 to the internet; Caddy listens there and forwards everything to the Node process on `localhost:3000`. It's Caddy instead of nginx for two reasons: it gets a free, auto-renewing TLS certificate from Let's Encrypt with almost no setup, and it proxies WebSocket upgrade requests correctly by default. (nginx can do the same thing, but needs explicit `Upgrade`/`Connection` header rules to do it — a common thing to forget, and the kind of bug that only shows up as calls mysteriously failing to connect.) The site config:

```
trybeam.duckdns.org {
    tls {
        alpn http/1.1
    }
    reverse_proxy localhost:3000
}
```

The `tls { alpn http/1.1 }` block isn't optional boilerplate — it fixes a real bug. Caddy serves HTTP/2 by default, and Firefox (and Chrome) will try to open a WebSocket over an existing HTTP/2 connection using a newer bootstrapping method (RFC 8441) when the server offers it. Caddy's `reverse_proxy` doesn't speak that method to a plain WebSocket backend, so instead of falling back cleanly, the connection just hangs with no response — the browser's network tab shows the request sent and nothing ever coming back. Pinning this site to HTTP/1.1-only removes the ambiguity: there's no HTTP/2 connection to attempt that bootstrap over, so the browser just does the traditional `Upgrade: websocket` handshake, which is what the Node server actually understands.

**DuckDNS for the hostname.** Let's Encrypt won't issue a TLS certificate for a bare IP address, only for a real domain name, and this project didn't need a paid domain for that. DuckDNS gives a free subdomain pointed at a chosen IP. The VM's external IP is reserved as *static* rather than left on GCP's default ephemeral assignment — ephemeral IPs change on every VM restart, which would silently break DNS until someone noticed calls had stopped connecting.

Put together: Vercel serves the app instantly off a CDN, the browser opens a `wss://` connection straight to `trybeam.duckdns.org`, Caddy terminates the TLS and hands the raw WebSocket traffic to Node, and the whole signaling layer never touches a database or any persistent storage — room state only ever lives in memory for as long as a room has people in it.
