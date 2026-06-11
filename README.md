# yt-bpm-split

Splitte une playlist YouTube Music en 2 playlists selon le BPM (seuil par défaut : 150).
BPM récupéré via l'API Deezer (gratuite, sans clé), avec normalisation half/double-time
dans la plage [100, 200[ (un titre à 75 BPM est classé comme 150).

## Prérequis (une seule fois)

1. **Projet Google Cloud** : https://console.cloud.google.com
   - Créer un projet (ou réutiliser un existant)
   - Activer **YouTube Data API v3** (APIs & Services → Library)
2. **Écran de consentement OAuth** (APIs & Services → OAuth consent screen)
   - Type : External, mode Testing
   - Ajouter ton compte Google (celui de YT Music) comme *test user*
3. **Identifiants OAuth** (APIs & Services → Credentials)
   - Create Credentials → OAuth client ID → **Desktop app**
   - Télécharger le JSON → le renommer `credentials.json` à la racine du projet

## Installation

```bash
npm install
```

## Lancement

```bash
# L'ID de playlist est dans l'URL : music.youtube.com/playlist?list=PLxxxx
PLAYLIST_ID=PLxxxx npm run split

# Seuil personnalisé :
PLAYLIST_ID=PLxxxx BPM_THRESHOLD=160 npm run split

# Désactiver la normalisation half/double-time (classement sur BPM brut) :
PLAYLIST_ID=PLxxxx NORMALIZE=off npm run split

# Activer le fallback GetSongBPM (clé gratuite : https://getsongbpm.com/api) :
PLAYLIST_ID=PLxxxx GETSONGBPM_KEY=xxxx npm run split
```

## Sources BPM

Ordre de résolution : `overrides.csv` → Deezer (5 candidats par recherche) → GetSongBPM (si clé).
Deezer renvoie souvent `bpm: 0` même sur un bon match, d'où l'intérêt du fallback.

**`overrides.csv`** (optionnel, à la racine) : corrections manuelles, prioritaires sur tout.
```
videoId;bpm
gr5PFgUDD5Q;115
dQw4w9WgXcQ;113
```
Les titres encore "non trouvés" en cache sont automatiquement retentés à chaque run
(les BPM résolus, eux, ne sont jamais re-demandés).

## Normalisation half/double-time

Un titre à 75 BPM est classé à 150 : en course, on pose un pas sur chaque demi-temps,
donc la cadence ressentie est doublée. C'est une heuristique — elle se trompe parfois.
Les titres "repliés" (×2 ou ÷2) sont marqués `replie=oui` dans `report.csv` et ⚠ dans
le dashboard : vérifie-les, et corrige via `overrides.csv` si besoin
(ou désactive tout avec `NORMALIZE=off`).

Au premier lancement, un navigateur s'ouvre pour l'authentification Google.
Le token est sauvegardé dans `token.json` (ne pas committer).

## Quota & reprise

Pour 115 titres : ~100 unités (création des 2 playlists) + 115 × 50 = **~5 900 unités**
sur les 10 000/jour — ça passe en un seul run.

Le script est **idempotent** :
- `bpm-cache.json` : BPM déjà résolus (seuls les "non trouvés" sont retentés)
- `state.json` : playlists créées + titres déjà insérés

En cas de quota épuisé (code sortie 2), relance le lendemain : il reprend où il s'est arrêté.

## Sortie

- 2 playlists **privées** sur ton compte : `<Nom source> — Sous 150 BPM` et `— 150 BPM et +`
- `report.csv` : détail par titre (BPM brut, normalisé, destination, match Deezer)
- Les titres introuvables sur Deezer sont listés en fin de run pour classement manuel

## Fichiers à ne pas committer

`credentials.json`, `token.json`, `bpm-cache.json`, `state.json`, `report.csv`
(déjà couverts par le `.gitignore`)

## Note API

Les titres et descriptions de playlists YouTube ne doivent contenir ni `<` ni `>`
(erreur 400 `invalidPlaylistSnippet`) — le script n'en génère plus.

## Crédits

BPM data provided by [GetSongBPM](https://getsongbpm.com) and [Deezer](https://www.deezer.com).