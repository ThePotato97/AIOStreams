# Guest streaming companion

AIOStreams hosts the guest page, authenticates guests, resolves the party's selected source and proxies media. This private service runs FFmpeg/ffprobe. Its API is versioned with this source tree; build the companion and AIOStreams from the same checkout.

## Run

Add `PARTY_TRANSCODER_SECRET` to `.env` with a random secret of at least 32 characters (for example, generate one using `openssl rand -hex 32`). Then build both services:

```sh
docker compose -f compose.yaml -f compose.guest.yaml up -d --build
```

This overlay builds the modified AIOStreams image; the upstream published image does not include guest streaming. It uses port 3000 between containers. If your server uses another internal port or a reverse-proxy path prefix, adjust `PARTY_INTERNAL_URL`, `AIOSTREAMS_INTERNAL_URL`, and `PARTY_TRANSCODER_URL` accordingly. Set your usual public AIOStreams base URL to the HTTPS address visitors can reach. Do not publish the transcoder's port.

Start a party on **This server**. In **People and invite**, select **Allow guests and copy link**. The link opens a browser player with a display-name prompt and Play button. It follows the party queue across episodes and uses the existing chat, reactions and playback-control rules. **Stop guest streaming** revokes the invitation and guest sessions. Guest playback does not update the host's watch history.

Guest streaming is opt-in at server level (`PARTY_GUEST_STREAMING`, false by default) and separately for each party. Remote-relay parties are unchanged. A server restart expires guest invites and sessions; generate a fresh guest link. The original sharing host must remain signed in; a party transferring host to a guest does not give that guest access to configuration credentials or allow publication of new sources.

## Playback

The browser reports its capabilities against the probed source. Original selects direct playback, container remuxing, audio conversion, or H.264 video conversion as needed. 1080p/8 Mbps and 720p/4 Mbps cap video resolution and bitrate without upscaling. Audio conversion produces stereo AAC at 192 kbps. A failed direct-play attempt retries once through H.264/AAC conversion.

Converted streams use HLS/fMP4. Native HLS is preferred; other browsers load hls.js. Chapters are supplied separately from the stream. Audio and embedded subtitle choices use the shared player UI. Plain text subtitles are extracted as WebVTT; ASS/SSA and bitmap subtitles require video burn-in. HDR video that requires conversion is tone-mapped to SDR. External addon subtitles and thumbnail generation are not included in the guest endpoint.

FFmpeg jobs are shared when source, selected tracks, encoding profile and available seek interval match. Seeks outside generated media create a new interval while the player preserves original episode time. The service produces approximately two minutes ahead, then pauses encoding until a viewer catches up. Jobs without live heartbeats expire after 60 seconds. Defaults are two simultaneous retained conversion jobs and a 10 GiB segment cache. Capacity errors are shown in the player; guests can retry or use Original. Browser buffering can retain video already downloaded before removal.

## Hardware encoding

CPU (`TRANSCODER_ENCODER=cpu`) is the default. The image includes Debian FFmpeg with libx264, libass, zscale and hardware encoder backends. Unsupported hardware initialization falls back to CPU before playback begins.

For Intel/AMD VAAPI, set `TRANSCODER_ENCODER=vaapi` and add to the transcoder service:

```yaml
devices:
  - /dev/dri:/dev/dri
group_add:
  - "<render-group-id>"
environment:
  VAAPI_DEVICE: /dev/dri/renderD128
```

The container runs as the `node` user. Set the render group ID from the host and make sure the appropriate VAAPI driver is installed in your image. Subtitle burn-in and HDR tone mapping use CPU filters; VAAPI encoding currently falls back to CPU for those paths.

For NVIDIA, install NVIDIA Container Toolkit on the host, set `TRANSCODER_ENCODER=nvidia`, and add:

```yaml
gpus: all
environment:
  NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
```

Driver/backend availability depends on the host. Hardware configuration examples require device testing on your server.

## Development and verification

Run `node server.mjs` in this directory with `TRANSCODER_SECRET`, `AIOSTREAMS_INTERNAL_URL`, and optionally `CACHE_DIR` set. Set the matching `PARTY_*` variables in AIOStreams. The companion accepts only opaque source handles under the configured AIOStreams origin, not arbitrary guest URLs. All companion endpoints require the shared secret.

Run `node services/transcoder/media.test.mjs` from the repository root with FFmpeg/ffprobe installed. Tests generate local fixtures, start local HTTP servers, and verify actual remuxing, audio/video conversion, seek generations, subtitle extraction/burn-in, HDR tone mapping, job reuse, capacity, and GPU-to-CPU fallback. Guest authorization tests are in `packages/server/src/guest`.

Authenticated `GET /health` reports active jobs, selected encoder, progress, viewers, and generic failures. Source URLs, credentials, and invite secrets are never included in this response or FFmpeg error messages. Configure your reverse proxy to redact query strings for `/party/guest/media` and `/party/guest/subtitle`: media elements require scoped session credentials in those URLs. The companion is single-instance and uses ephemeral jobs; distributed recovery is outside this version.
