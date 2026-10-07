# Yard Sale Gold

An installable browser/PWA scanner that samples frames from a live camera or uploaded garage-sale footage, sends them to GPT-6 Luna through the OpenAI Agents SDK with Priority processing and medium reasoning effort, values visible items, and streams finds into a mobile-first UI.

## Stack

- React 19 + Vite + TypeScript
- TanStack Router for URL-driven navigation and TanStack Query for server-state caching
- Cloudflare Workers and the Cloudflare Vite plugin
- OpenAI Agents SDK with `gpt-6-luna`, `service_tier: "priority"`, and `reasoning.effort: "medium"`
- Drizzle ORM + Cloudflare D1
- Cloudflare R2 thumbnails
- Vite PWA service worker and manifest

## Run locally

1. Copy `.dev.vars.example` to `.dev.vars` and replace the placeholder:

   ```dotenv
   OPENAI_API_KEY=your_real_project_key
   ```

2. The checked-in `wrangler.jsonc` targets Dovie's Cloudflare account. Local development uses local D1/R2 bindings. Install dependencies and apply local D1 migrations:

   ```bash
   npm install
   npm run db:migrate:local
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173`. Select a camera for live scanning or snapshots, or upload a photo/video. You can keep your own garage-sale clips in the ignored local `yard-sale-footage/` folder; footage is not included in this repository.

The browser samples JPEG frames at a configurable 1–30 second interval (default 4 seconds). Concurrent processing is configurable from 1–100 frames, defaults to five, and remembers the previous setting. Each capture has its own canvas and request cancellation. Replies can finish in any order: all detections are collected, the latest completed frame stays paired with its summary, and cumulative counters do not move backwards. Lowering the limit lets existing work finish before admitting more frames. Captures are limited to 1600 pixels on the longest side at JPEG quality 0.9, preserving the full frame and its aspect ratio. Frame images are not bundled with the app.

Camera capture requests 1920×1080 on initial open and after switching devices, with browser fallback to supported resolutions. Continuous autofocus is enabled when the camera exposes it; unsupported focus controls do not prevent capture. The preview crops to fill a portrait screen while the AI receives the full frame. The source label reports the actual capture resolution, and the AI-frame thumbnail opens the full submitted image. Multiple front/rear entries remain available because browser entries do not necessarily correspond to separate physical lenses.

Scan and History keep the same mounted video element and camera stream. Live work pauses while the app is hidden and resumes on return. The camera is marked Ready only after fresh preview frames arrive; a five-second frame stall pauses capture and exposes a centered Restart camera action. Returning to the app reattaches/replays the stream, then reacquires the camera if frames still do not arrive. Camera Off exposes a centered Select camera button. Camera Off explicitly releases the stream. Live captures do not flash the screen. Source changes invalidate pending results, API errors pause live scanning, and every completed analysis has a visible summary, including empty or filtered results. Updates are announced in Settings and applied only on request.

The camera preview is unobstructed: controls sit above and below it, with a compact strip above the preview showing active requests, frames, items, searches, and model calls. Saved finds, the latest AI summary, and the submitted-frame thumbnail appear in History, which also shows usage statistics. Resolution details and Restart camera are in Settings; restart is also available in the camera selector. Manual snaps briefly pulse inside the camera frame; Live mode stays quiet, including when Snap is tapped during Live. Reduced motion uses a brief static outline. The app has no sound effects. Screens use solid backgrounds without decorative gradients.

## Routes and state

- `/scan` — camera, snapshots, uploads, and live processing statistics
- `/history` — saved inventory, latest AI summary, and usage statistics
- `/finds/:itemId?from=scan|history` — shareable item detail modal with its originating view preserved
- `/finds/:itemId/activity?from=scan|history` — the persisted agent activity for the item's latest frame

TanStack Query owns remote stats and inventory data. Camera streams, capture timers, in-flight frame work, and recent detections remain local React state because they are ephemeral browser state.

## Useful commands

```bash
npm test                 # deterministic unit tests
npm run build            # type-check and production build
npm run cf-typegen       # regenerate Worker binding types
npm run db:generate      # generate a migration after schema changes
npm run db:migrate:local # apply migrations to local D1
```

## Agent workflow

Each frame starts one bounded agent run. The agent:

1. Identifies prominent visible objects without requiring proof they are for sale. Brand/model stay unknown unless established visually; unclear objects receive a plain explanation rather than a guess.
2. Calls `check_previous_scans` against D1 for semantic fingerprint matches.
3. Uses bounded manufacturer/retailer research and optional eBay active listings for pricing. Previous valuations can be reused, and missing price evidence does not suppress identification. Runs stop after eight turns or 75 seconds.
4. Returns structured retail, active-listing, sold-comparable, and resale-range data.
5. Returns normalized item coordinates and draws bounding boxes over saved frames.
6. Persists new or repeated detections atomically. Exact fingerprints are unique; agent-proposed matches are rejected when established brands or models conflict. Uncertain detections and invalid bounding boxes are not saved. Fuzzy fingerprint overlap alone does not merge objects.
7. Stores a sanitized per-frame audit record containing prompts, ordered run items, tool calls and results, raw model responses, final structured output, and usage. API keys, raw base64 images, encrypted reasoning, and hidden reasoning content are excluded.

History reports cumulative frames processed, items identified, searches performed, and underlying model calls. See [FEATURES.md](./FEATURES.md) for find tracking, natural-language filters, eBay integration, and batch processing.

## Cloud deployment

This instance uses the `yard-sale-gold` Worker, `yard-sale-gold-db` D1 database, and `yard-sale-gold-thumbnails` R2 bucket in Dovie's Cloudflare account. Its intended URL is `https://yard-sale-gold.dovieweinstock.workers.dev`.

For another deployment, create your own D1 database and R2 bucket, then replace the account ID, database ID, and resource names in `wrangler.jsonc`.

Enable R2 in the account before creating the bucket. Apply remote migrations and set `OPENAI_API_KEY` as a Worker secret before scanning. The ignored `.dev.vars` file is for local credentials; it is not uploaded automatically by `npm run deploy`.

Protect production traffic with a Cloudflare Access email allowlist before enabling the AI secret. Preview URLs are disabled. Both users share inventory, statistics, images, and delete permissions; the app does not have separate user accounts.

The app reserves R2 usage atomically in D1 before each upload or image read. It stops at 200 uploads and 10,000 image reads per UTC day, or 1 GB of cumulative attempted uploads across the lifetime of the instance. Failed uploads and deleted images do not refund this lifetime allowance. Database failures also stop R2 access. These controls cover this app only; they are not an account billing cap and cannot prevent charges from other R2 clients or resources. OpenAI scanning is billed separately.

The installed `cf` CLI can manage resources and migrations. Its current deployment command requires the v2 beta Cloudflare Vite plugin, while this app uses v1. Use the existing Wrangler deployment command for this app rather than migrating its build setup merely to deploy it.
