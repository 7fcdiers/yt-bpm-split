/**
 * split-playlist.ts
 * Splitte une playlist YouTube Music en 2 playlists selon le BPM :
 *   - "<NAME> — Sous 150 BPM"
 *   - "<NAME> — 150 BPM et +"
 *
 * Sources :
 *   - YouTube Data API v3 (lecture playlist + création/insertion)
 *   - API Deezer (gratuite, sans clé) pour le BPM
 *
 * Le script est idempotent : cache BPM + état d'avancement sur disque,
 * relançable sans consommer du quota inutilement.
 *
 * Usage :
 *   PLAYLIST_ID=PLxxxx npx tsx split-playlist.ts
 */

import { authenticate } from "@google-cloud/local-auth";
import { google, youtube_v3 } from "googleapis";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLAYLIST_ID = process.env.PLAYLIST_ID ?? "";
const BPM_THRESHOLD = Number(process.env.BPM_THRESHOLD ?? 150);
const CREDENTIALS_PATH = join(process.cwd(), "credentials.json");
const TOKEN_PATH = join(process.cwd(), "token.json");
const CACHE_PATH = join(process.cwd(), "bpm-cache.json");
const STATE_PATH = join(process.cwd(), "state.json");
const REPORT_PATH = join(process.cwd(), "report.csv");

const SCOPES = ["https://www.googleapis.com/auth/youtube"];

// Throttling
const DEEZER_DELAY_MS = 250; // ~4 req/s, sous la limite Deezer (50 req / 5 s)
const YT_INSERT_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface Track {
  videoId: string;
  rawTitle: string;
  artist: string;
  title: string;
}

interface BpmEntry {
  bpm: number | null; // null = non trouvé sur Deezer
  matchedAs?: string;
}

interface State {
  slowPlaylistId?: string;
  fastPlaylistId?: string;
  inserted: string[]; // videoIds déjà insérés (toutes playlists confondues)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function saveJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Nettoie un titre YouTube : "(Official Video)", "[HD]", "feat. X", etc. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[\(\[][^)\]]*(official|video|audio|lyric|clip|hd|4k|remaster|visualizer)[^)\]]*[\)\]]/gi, "")
    .replace(/\b(feat|ft)\.?\s+[^-–(]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Extrait (artiste, titre) depuis un item de playlist YouTube. */
function parseTrack(item: youtube_v3.Schema$PlaylistItem): Track | null {
  const videoId = item.contentDetails?.videoId;
  const rawTitle = item.snippet?.title ?? "";
  if (!videoId || rawTitle === "Deleted video" || rawTitle === "Private video") return null;

  // Sur YT Music, la chaîne est souvent "Artiste - Topic"
  const ownerChannel = item.snippet?.videoOwnerChannelTitle ?? "";
  let artist = ownerChannel.replace(/\s*-\s*Topic$/i, "").trim();
  let title = cleanTitle(rawTitle);

  // Sinon, pattern classique "Artiste - Titre"
  const dashSplit = title.split(/\s+[-–—]\s+/);
  if (!artist && dashSplit.length >= 2) {
    artist = dashSplit[0].trim();
    title = dashSplit.slice(1).join(" - ").trim();
  } else if (artist && dashSplit.length >= 2 && dashSplit[0].toLowerCase() === artist.toLowerCase()) {
    title = dashSplit.slice(1).join(" - ").trim();
  }

  return { videoId, rawTitle, artist, title };
}

/**
 * Normalise le BPM dans une plage "running" [100, 200[.
 * Un titre à 75 BPM est ressenti à 150 en course → on double.
 */
function normalizeBpm(bpm: number): number {
  let b = bpm;
  while (b < 100) b *= 2;
  while (b >= 200) b /= 2;
  return Math.round(b * 10) / 10;
}

// ---------------------------------------------------------------------------
// Deezer
// ---------------------------------------------------------------------------

async function deezerBpm(track: Track): Promise<BpmEntry> {
  const attempts = [
    `artist:"${track.artist}" track:"${track.title}"`,
    `${track.artist} ${track.title}`,
    track.title,
  ].filter((q, i) => (i === 0 ? track.artist.length > 0 : true));

  for (const q of attempts) {
    try {
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`);
      const data = (await res.json()) as { data?: { id: number; title: string; artist: { name: string } }[] };
      const hit = data.data?.[0];
      await sleep(DEEZER_DELAY_MS);
      if (!hit) continue;

      const trackRes = await fetch(`https://api.deezer.com/track/${hit.id}`);
      const trackData = (await trackRes.json()) as { bpm?: number };
      await sleep(DEEZER_DELAY_MS);

      if (trackData.bpm && trackData.bpm > 0) {
        return { bpm: trackData.bpm, matchedAs: `${hit.artist.name} - ${hit.title}` };
      }
    } catch {
      // réseau : on tente la requête suivante
    }
  }
  return { bpm: null };
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

async function getAuthClient() {
  if (existsSync(TOKEN_PATH)) {
    const creds = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    return google.auth.fromJSON(creds) as any;
  }
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials) {
    const keys = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    const key = keys.installed ?? keys.web;
    saveJson(TOKEN_PATH, {
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    });
  }
  return client;
}

async function fetchAllPlaylistItems(yt: youtube_v3.Youtube, playlistId: string): Promise<Track[]> {
  const tracks: Track[] = [];
  let pageToken: string | undefined;
  do {
    const res = await yt.playlistItems.list({
      part: ["snippet", "contentDetails"],
      playlistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of res.data.items ?? []) {
      const t = parseTrack(item);
      if (t) tracks.push(t);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return tracks;
}

async function ensurePlaylist(
  yt: youtube_v3.Youtube,
  state: State,
  key: "slowPlaylistId" | "fastPlaylistId",
  title: string,
  description: string
): Promise<string> {
  if (state[key]) return state[key]!;
  const res = await yt.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: "private" },
    },
  });
  state[key] = res.data.id!;
  saveJson(STATE_PATH, state);
  console.log(`✔ Playlist créée : "${title}" (${state[key]})`);
  return state[key]!;
}

async function insertVideo(yt: youtube_v3.Youtube, playlistId: string, videoId: string) {
  await yt.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!PLAYLIST_ID) {
    console.error("❌ Définis PLAYLIST_ID (ex: PLAYLIST_ID=PLxxxx npx tsx split-playlist.ts)");
    process.exit(1);
  }

  const auth = await getAuthClient();
  const yt = google.youtube({ version: "v3", auth });

  // 1. Lecture de la playlist source
  console.log("→ Lecture de la playlist source…");
  const tracks = await fetchAllPlaylistItems(yt, PLAYLIST_ID);
  console.log(`  ${tracks.length} titres trouvés.`);

  const sourceMeta = await yt.playlists.list({ part: ["snippet"], id: [PLAYLIST_ID] });
  const sourceName = sourceMeta.data.items?.[0]?.snippet?.title ?? "Running";

  // 2. BPM via Deezer (avec cache)
  const cache = loadJson<Record<string, BpmEntry>>(CACHE_PATH, {});
  let done = 0;
  for (const t of tracks) {
    if (!(t.videoId in cache)) {
      cache[t.videoId] = await deezerBpm(t);
      saveJson(CACHE_PATH, cache);
    }
    done++;
    const e = cache[t.videoId];
    const label = e.bpm ? `${e.bpm} BPM (norm. ${normalizeBpm(e.bpm)})` : "INTROUVABLE";
    console.log(`  [${done}/${tracks.length}] ${t.artist} - ${t.title} → ${label}`);
  }

  // 3. Répartition
  const slow: Track[] = [];
  const fast: Track[] = [];
  const unmatched: Track[] = [];
  for (const t of tracks) {
    const e = cache[t.videoId];
    if (!e.bpm) {
      unmatched.push(t);
    } else if (normalizeBpm(e.bpm) < BPM_THRESHOLD) {
      slow.push(t);
    } else {
      fast.push(t);
    }
  }
  console.log(`\n→ Répartition : ${slow.length} < ${BPM_THRESHOLD} BPM | ${fast.length} ≥ ${BPM_THRESHOLD} BPM | ${unmatched.length} non trouvés`);

  // 4. Rapport CSV
  const csv = [
    "videoId;artiste;titre;bpm_brut;bpm_normalise;playlist;match_deezer",
    ...tracks.map((t) => {
      const e = cache[t.videoId];
      const norm = e.bpm ? normalizeBpm(e.bpm) : null;
      const dest = norm === null ? "NON TROUVÉ" : norm < BPM_THRESHOLD ? `<${BPM_THRESHOLD}` : `>=${BPM_THRESHOLD}`;
      return `${t.videoId};${t.artist};${t.title};${e.bpm ?? ""};${norm ?? ""};${dest};${e.matchedAs ?? ""}`;
    }),
  ].join("\n");
  writeFileSync(REPORT_PATH, csv);
  console.log(`✔ Rapport écrit : ${REPORT_PATH}`);

  // 5. Création des playlists + insertion (resumable)
  const state = loadJson<State>(STATE_PATH, { inserted: [] });
  const slowId = await ensurePlaylist(yt, state, "slowPlaylistId",
    `${sourceName} — Sous ${BPM_THRESHOLD} BPM`, `Générée automatiquement (BPM < ${BPM_THRESHOLD})`);
  const fastId = await ensurePlaylist(yt, state, "fastPlaylistId",
    `${sourceName} — ${BPM_THRESHOLD} BPM et +`, `Générée automatiquement (BPM ≥ ${BPM_THRESHOLD})`);

  const jobs: [string, Track[]][] = [[slowId, slow], [fastId, fast]];
  for (const [playlistId, list] of jobs) {
    for (const t of list) {
      if (state.inserted.includes(t.videoId)) continue;
      try {
        await insertVideo(yt, playlistId, t.videoId);
        state.inserted.push(t.videoId);
        saveJson(STATE_PATH, state);
        console.log(`  + ${t.artist} - ${t.title}`);
        await sleep(YT_INSERT_DELAY_MS);
      } catch (err: any) {
        if (err?.code === 403 && /quota/i.test(err?.message ?? "")) {
          console.error("\n⚠ Quota YouTube épuisé. Relance le script demain : il reprendra où il s'est arrêté.");
          process.exit(2);
        }
        console.error(`  ✖ Échec insertion ${t.videoId} : ${err?.message}`);
      }
    }
  }

  console.log("\n✅ Terminé !");
  if (unmatched.length) {
    console.log(`⚠ ${unmatched.length} titres sans BPM (voir report.csv) — à classer manuellement :`);
    unmatched.forEach((t) => console.log(`   - ${t.artist} - ${t.title}`));
  }
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
