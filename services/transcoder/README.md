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

Converted streams are DASH (fMP4), with video and audio in separate streams as Plex does, played with Shaka Player. Copied HEVC is tagged `hvc1`, and the manifest carries the video's full codec string, built from its configuration box (FFmpeg's DASH muxer writes only `hvc1`/`av01`/`vp09`). Chapters are supplied separately from the stream. Audio and embedded subtitle choices use the shared player UI. Plain text subtitles are extracted as WebVTT; ASS/SSA and bitmap subtitles require video burn-in. HDR video plays as it is wherever the browser says it plays PQ HDR (Media Capabilities, `transferFunction: 'pq'`), on an SDR screen too; otherwise it is converted and tone-mapped to SDR. Where the browser can't be asked, an HDR screen (`dynamic-range: high`) decides. External addon subtitles and thumbnail generation are not included in the guest endpoint.

Converted streams keep the source's timestamps (`-copyts -avoid_negative_ts disabled -start_at_zero`, as Jellyfin and Plex do), with each fragment's start in its timestamps (`movflags=+frag_discont+skip_sidx`) rather than an edit list, which browsers skip. With the video copied, `-noaccurate_seek` starts the audio at the same keyframe as the video, and `aresample=async=1` keeps converted audio continuous. The player's position is the source's own, so converted streams report no offset; where a stream can play from is read from its manifest.

FFmpeg jobs are shared when source, selected tracks, encoding profile and available seek interval match. Seeks outside generated media create a new interval while the player preserves original episode time. The service produces approximately two minutes ahead, then pauses encoding until a viewer catches up. Jobs without live heartbeats expire after 60 seconds. Defaults are two simultaneous retained conversion jobs and a 10 GiB segment cache. Capacity errors are shown in the player; guests can retry or use Original. Browser buffering can retain video already downloaded before removal.

## Hardware encoding

CPU (`TRANSCODER_ENCODER=cpu`) is the default. The image includes jellyfin-ffmpeg (libx264, libass, zscale, tonemapx and hardware encoder backends). Unsupported hardware initialization falls back to CPU before playback begins.

For Intel/AMD VAAPI, set `TRANSCODER_ENCODER=vaapi` and add to the transcoder service:

```yaml
devices:
  - /dev/dri:/dev/dri
group_add:
  - "<render-group-id>"
environment:
  VAAPI_DEVICE: /dev/dri/renderD128
```

The container runs as the `node` user. Set the render group ID from the host and make sure the appropriate VAAPI driver is installed in your image. Subtitle burn-in and HDR tone mapping use CPU filters with VAAPI; VAAPI encoding currently falls back to CPU for those paths.

For NVIDIA, install NVIDIA Container Toolkit on the host, set `TRANSCODER_ENCODER=nvidia`, and add:

```yaml
gpus: all
environment:
  NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
```

With NVIDIA, conversions follow Jellyfin's chain on jellyfin-ffmpeg: NVDEC decodes (H.264, MPEG-2, VC-1, MPEG-4 and VP8 in 8-bit, VP9 and AV1 up to 10-bit, HEVC up to 12-bit and 4:4:4), `scale_cuda` scales, and HDR is tone-mapped with `tonemap_cuda`, the frames staying on the GPU into NVENC. Video NVDEC can't decode, a rotated picture or subtitle burn-in is decoded on the CPU and tone-mapped on the GPU from uploaded frames. If a conversion fails before its first segment it runs again with the video decoded on the CPU, then with the tone map on the CPU (`tonemapx`) and NVENC encoding, then all on the CPU. `/health` reports where each job decodes (`decode`) and tone-maps (`tonemap`): `gpu`, `cpu` or null. Every tone map applies a Dolby Vision RPU where there is one, which Dolby Vision profile 5 (no HDR10 base layer) needs for its colours: profile 5 is always converted, since browsers aren't asked whether they play Dolby Vision. The curve is Hable without desaturation (Jellyfin's default is BT.2390).

### Binaural audio for headphones

When the player says it's on headphones (`capabilities.binaural`), TrueHD, E-AC-3, AC-3 and DTS tracks at 48 kHz, Atmos or not (DTS as its channels), are rendered to binaural stereo by `atmos-render` (`services/atmos-render`, built into the image), a renderer following Dolby Atmos for Headphones from traced values; its departures from Dolby's engine are listed in its `DEVIATIONS.md`. The conversion runs as three processes: FFmpeg demuxes the audio track (and reports its first packet's timestamp), `atmos-render` renders it, and the converting FFmpeg reads the rendered stereo from that timestamp, encoding it as FLAC where the browser plays it, else AAC. The response's `binaural` says whether it was rendered here, and the player then adds no virtualiser of its own. If the demuxer or renderer fails before the first segment, the conversion runs again without it and `binaural` is false. `ATMOS_RENDER` overrides the renderer's path.

`capabilities.binauralMode` (`near` or `far`) renders every element in that headphone mode (`atmos-render --modes windows` or `far`); without it each element is in the stream's own mode, Mid where it has none.

A player that decodes TrueHD, E-AC-3, AC-3 or DTS itself lists the codecs in `capabilities.clientBinaural` (the web app does, with `atmos-render` built as WebAssembly): such a track is copied into the DASH stream as it is, with headphones on or off, and the response's `clientBinaural` is true. The player renders binaural for headphones and the speaker version (what this service would have sent) otherwise, so turning headphones on or off doesn't need a new job. A retry after failed playback (`force`) converts it here instead.

Driver/backend availability depends on the host. Hardware configuration examples require device testing on your server.

## Development and verification

Run `node server.mjs` in this directory with `TRANSCODER_SECRET`, `AIOSTREAMS_INTERNAL_URL`, and optionally `CACHE_DIR` set. Set the matching `PARTY_*` variables in AIOStreams. The companion accepts only opaque source handles under the configured AIOStreams origin, not arbitrary guest URLs. All companion endpoints require the shared secret.

Run `node --test services/transcoder/` from the repository root with jellyfin-ffmpeg's `ffmpeg`/`ffprobe` on the PATH (the CPU tone map is its `tonemapx`), or inside the image. Tests generate local fixtures, start local HTTP servers, and verify actual remuxing, audio/video conversion, seek generations, subtitle extraction/burn-in, HDR tone mapping, Dolby Vision profile 5 through its RPU (`fixtures/`), job reuse, capacity, GPU-to-CPU fallback, and binaural conversions (`binaural.test.mjs`, which needs `atmos-render`: in the image, or `ATMOS_RENDER` pointing at a build). Guest authorization tests are in `packages/server/src/guest`.

Authenticated `GET /health` reports active jobs, selected encoder, progress, viewers, and generic failures. Source URLs, credentials, and invite secrets are never included in this response or FFmpeg error messages. Configure your reverse proxy to redact query strings for `/party/guest/media` and `/party/guest/subtitle`: media elements require scoped session credentials in those URLs. The companion is single-instance and uses ephemeral jobs; distributed recovery is outside this version.
