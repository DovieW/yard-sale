# Yard Sale Gold — Feature Log

This file tracks intentionally deferred product ideas so the MVP can stay focused.

## Planned

- **eBay sold-comps integration:** Add an eBay MCP server or eBay developer API tool when credentials are available. Prefer sold listings and retain links and timestamps for each comparable.
- **Configurable alert rules:** Filter by category, value, estimated profit, ROI, brand, condition, or confidence.
- **Batch processing mode:** Use the OpenAI Batch API for uploaded footage where throughput and cost matter more than immediate results. Live camera analysis uses the configured concurrency limit.
- **Visual similarity deduplication:** Add embeddings or image-feature matching so duplicate detection is not limited to normalized semantic fingerprints.
- **Separate user accounts:** Add ownership and optional shared collections if the current shared-inventory workflow needs them.
- **TanStack Start migration:** Revisit moving the full app to TanStack Start when SSR, server functions, authentication, or route-level server loading provide a concrete benefit. TanStack Start is officially supported on Cloudflare Workers, but the current camera-first PWA keeps its existing Worker API.

## Current behavior

- Installable React/Vite PWA that is easy to debug in a desktop or mobile browser.
- GPT-6 Luna through the TypeScript OpenAI Agents SDK, with Priority processing and medium reasoning.
- Browser camera and uploaded-video frame sampling; no direct video model input.
- Configurable parallel frame processing from 1–100 requests, defaulting to five and remembering the previous setting. Each request tracks its own cancellation and keeps its frame paired with the correct summary.
- Unobstructed portrait camera preview, with controls and compact live processing statistics outside it. Findings, summaries, and submitted frames appear in History, alongside usage counters.
- No sound effects, shutter flash, or decorative gradients.
- Optional natural-language find criteria in Settings; uncertain detections are not saved.
- Value records can include retail price, active listings, and sold comparables.
- Dedupe within the active scan and across historical scans.
- D1 stores metadata; R2 stores thumbnails.
- Cloudflare Access protects the deployed app for an email allowlist; authorized users share inventory and deletion permissions.
- Usage counters track frames processed, items identified, searches performed, and total model calls.
- Persistent D1 reservations bound this app's R2 uploads, reads, and lifetime attempted upload bytes.
- Luna returns normalized item coordinates; saved-frame thumbnails and detail views render item-level bounding boxes.
