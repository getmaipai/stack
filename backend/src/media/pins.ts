// MEDIA-STACK-01: the media service's pinned tools. ffmpeg and ffprobe are
// one verified archive per platform (fetched on demand through the Stack's
// download machinery, checksummed, kept under data/engines/ffmpeg/<tag>);
// yt-dlp is a hashed PyPI requirements file synced into a uv environment
// (data/engines/yt-dlp/<version>/venv), the same recipe as the image tools
// and FileTube's precedent. Nothing here fetches a thing by itself.
//
// Why jellyfin-ffmpeg for ffmpeg and ffprobe. The Stack needs both tools
// from a static build with a clear licence, published where the Stack
// already trusts downloads (GitHub releases, which GitHub itself digests).
// Candidates read on 2026-10-17: eugeneware/ffmpeg-static ships raw
// binaries but they are built with `--enable-nonfree`, which no licence lets
// anyone redistribute; the macOS static builds on other hosts need a second
// download host on the privacy page. jellyfin-ffmpeg publishes portable
// builds for macOS arm64 and x64 and Linux arm64 and x64, one archive each
// with both tools, built `--enable-gpl --enable-version3` and no nonfree
// (libx264 and the native AAC encoder, which is what media.transcode
// needs), GPL-3.0-or-later. The Stack only runs them as subprocesses and
// ships no copy, so the licence asks nothing of MaiPai beyond naming it.
import type { EngineBinaryPin } from "@/lib/engineCatalog";
import darwinArm64Requirements from "./yt-dlp.darwin-arm64.requirements.txt" with { type: "file" };
import linuxArm64Requirements from "./yt-dlp.linux-arm64.requirements.txt" with { type: "file" };
import linuxX64Requirements from "./yt-dlp.linux-x64.requirements.txt" with { type: "file" };

export const FFMPEG_NAME = "ffmpeg";
export const FFMPEG_TAG = "v8.1.3-1";
export const FPCALC_NAME = "fpcalc";
export const FPCALC_TAG = "v1.6.2";
export const YT_DLP_NAME = "yt-dlp";
export const YT_DLP_VERSION = "2026.08.19";

const release = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/${FFMPEG_TAG}`;
function ffmpegPin(platform: "darwin" | "linux", arch: "arm64" | "x64", asset: string, sha256: string, bytes: number, verified: boolean): EngineBinaryPin {
  const label = `${platform === "darwin" ? "macOS" : "Linux"} ${arch}`;
  return {
    id: `ffmpeg-${FFMPEG_TAG}-${platform}-${arch}`, name: FFMPEG_NAME, tag: FFMPEG_TAG, platform, arch, tool: "ffmpeg", requiresNvidia: false,
    label: `ffmpeg and ffprobe 8.1.3 (jellyfin-ffmpeg portable GPL build, ${label})`, docsUrl: "https://github.com/jellyfin/jellyfin-ffmpeg",
    archive: { label: `jellyfin-ffmpeg 8.1.3-1 (${label})`, url: `${release}/${asset}`, sha256, approxBytes: bytes },
    verified,
  };
}

/** One archive per platform holding both `ffmpeg` and `ffprobe`. sha256 and size are GitHub's own digest of the release asset; the macOS arm64 one was also downloaded, hashed and run on 2026-10-17 (verified), the others are not yet run. */
export const FFMPEG_PINS: EngineBinaryPin[] = [
  ffmpegPin("darwin", "arm64", "jellyfin-ffmpeg_8.1.3-1_portable_macarm64-gpl.tar.xz", "22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6", 32_902_204, true),
  ffmpegPin("darwin", "x64", "jellyfin-ffmpeg_8.1.3-1_portable_mac64-gpl.tar.xz", "cb2b5c154d49a6b6bfe29fa6c16510e85dcbf60b805764121a167b093d4bb6fb", 37_952_072, false),
  ffmpegPin("linux", "x64", "jellyfin-ffmpeg_8.1.3-1_portable_linux64-gpl.tar.xz", "b86dc023c64a5a9a410e6e3a938a970460214fae78f31c1553c9f88f1c289b6a", 60_368_340, false),
  ffmpegPin("linux", "arm64", "jellyfin-ffmpeg_8.1.3-1_portable_linuxarm64-gpl.tar.xz", "7bc8e8d0986f7f4693f63e9728570f671f07b6e21c05d5465dd7ce461d1631dc", 54_137_808, false),
];

export function ffmpegPinFor(platform = process.platform, arch = process.arch): EngineBinaryPin | null {
  return FFMPEG_PINS.find((pin) => pin.platform === platform && pin.arch === arch) ?? null;
}

const fpcalcRelease = `https://github.com/acoustid/chromaprint/releases/download/${FPCALC_TAG}`;
function fpcalcPin(platform: "darwin" | "linux", arch: "arm64" | "x64", asset: string, sha256: string, bytes: number, verified: boolean): EngineBinaryPin {
  const label = `${platform === "darwin" ? "macOS" : "Linux"} ${arch}`;
  return {
    id: `fpcalc-${FPCALC_TAG}-${platform}-${arch}`, name: FPCALC_NAME, tag: FPCALC_TAG, platform, arch, tool: "fpcalc", requiresNvidia: false,
    label: `fpcalc 1.6.2 (Chromaprint, ${label})`, docsUrl: "https://github.com/acoustid/chromaprint",
    archive: { label: `Chromaprint fpcalc 1.6.2 (${label})`, url: `${fpcalcRelease}/${asset}`, sha256, approxBytes: bytes },
    verified,
  };
}

/** One archive per platform holding fpcalc. The macOS arm64 archive was downloaded, hashed and run; the other release assets are pinned but not yet verified locally. */
export const FPCALC_PINS: EngineBinaryPin[] = [
  fpcalcPin("darwin", "arm64", "chromaprint-fpcalc-1.6.2-macos-arm64.tar.gz", "f3bc56cb42d89a01237bb3f3629329e4ec75f7c1b0217acf6e9bf952ac47979b", 1_322_220, true),
  fpcalcPin("darwin", "x64", "chromaprint-fpcalc-1.6.2-macos-x86_64.tar.gz", "5f7b21964163e9e1719ca76d89e71873e2bdba87e9c01d1bcb06da67132da2bb", 1_376_075, false),
  fpcalcPin("linux", "x64", "chromaprint-fpcalc-1.6.2-linux-x86_64.tar.gz", "c968ad4a0821592a79b158fb2e1f46cbe0a22a0a1dbc0743c67d68e75d15d2bb", 2_398_043, false),
  fpcalcPin("linux", "arm64", "chromaprint-fpcalc-1.6.2-linux-arm64.tar.gz", "3aa1498126ed272d805bc9d081c77965c9e1e1a0891bb112c13b56ef2ad47bad", 1_408_792, false),
];

export function fpcalcPinFor(platform = process.platform, arch = process.arch): EngineBinaryPin | null {
  return FPCALC_PINS.find((pin) => pin.platform === platform && pin.arch === arch) ?? null;
}
export function ytDlpRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  if (platform === "linux" && arch === "arm64") return linuxArm64Requirements;
  if (platform === "linux" && arch === "x64") return linuxX64Requirements;
  return null;
}

/** The licence record for every part of the service, rendered into docs/components.md and served by GET /stack/v1/media. */
export interface MediaComponent { name: string; version: string; licence: string; source: string; why: string; }
export const MEDIA_COMPONENTS: MediaComponent[] = [
  { name: "fpcalc (chromaprint)", version: "1.6.2", licence: "LGPL-2.1-or-later", source: "github.com/acoustid/chromaprint, release v1.6.2, per platform, sha256 pinned", why: "Turns a few seconds of music into a fingerprint so Home can name the song; the audio never leaves this computer, only the fingerprint goes to AcoustID" },
  { name: "ffmpeg", version: "8.1.3 (jellyfin-ffmpeg 8.1.3-1)", licence: "GPL-3.0-or-later (built with --enable-gpl --enable-version3, no nonfree parts)", source: "github.com/jellyfin/jellyfin-ffmpeg, release v8.1.3-1, portable build per platform, sha256 pinned", why: "Transcode to H.264 and AAC, thumbnails, storyboards and preview clips; the only static build with a clear licence on every platform the Stack runs on." },
  { name: "ffprobe", version: "8.1.3 (jellyfin-ffmpeg 8.1.3-1)", licence: "GPL-3.0-or-later (same archive as ffmpeg)", source: "the same archive as ffmpeg", why: "Reads duration, codecs, chapters, tags, embedded date and source URL of a file." },
  { name: "yt-dlp", version: YT_DLP_VERSION, licence: "Unlicense (public domain); its default extras: brotli MIT, certifi MPL-2.0, mutagen GPL-2.0-or-later, pycryptodomex BSD-2-Clause, requests Apache-2.0, urllib3 MIT, websockets BSD-3-Clause, yt-dlp-ejs Unlicense", source: "pypi.org, yt-dlp==2026.8.19 with every file hash in the requirements file, in a uv environment", why: "Fetches a link the person chose; FileTube's precedent." },
];
