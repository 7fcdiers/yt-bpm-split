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
```

Au premier lancement, un navigateur s'ouvre pour l'authentification Google.
Le token est sauvegardé dans `token.json` (ne pas committer).

## Quota & reprise

Pour 115 titres : ~100 unités (création des 2 playlists) + 115 × 50 = **~5 900 unités**
sur les 10 000/jour — ça passe en un seul run.

Le script est **idempotent** :
- `bpm-cache.json` : BPM déjà résolus (pas de re-requête Deezer)
- `state.json` : playlists créées + titres déjà insérés

En cas de quota épuisé (code sortie 2), relance le lendemain : il reprend où il s'est arrêté.

## Sortie

- 2 playlists **privées** sur ton compte : `<Nom source> — Sous 150 BPM` et `— 150 BPM et +`
- `report.csv` : détail par titre (BPM brut, normalisé, destination, match Deezer)
- Les titres introuvables sur Deezer sont listés en fin de run pour classement manuel

## Fichiers à ne pas committer

`credentials.json`, `token.json`, `bpm-cache.json`, `state.json`, `report.csv`
(déjà couverts par le `.gitignore`)
