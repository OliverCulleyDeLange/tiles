# Tiles

A real-time crossword tile race for two to eight players. Everyone builds at once on a shared tabletop, with automatic peeling, dumping, dictionary validation, and touch-friendly pan, zoom, and rotation.

The working title is intentionally generic while the final public name is decided.

## Web app

```sh
npm install
npm run dev
```

Production builds respect `BASE_PATH`, which lets GitHub Pages serve the game from `/tiles/`:

```sh
BASE_PATH=/tiles npm run build
```

The hosted client currently defaults to the existing Tile Rush Cloudflare Worker so online games continue to work during the repository move. Deploy `worker/` and update `PRODUCTION_SERVER` in `src/game/index.ts` when the new Worker is ready.

## Realtime worker

```sh
cd worker
npm install
npm run dev
```

Deployment requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Native nearby play

The Capacitor projects in `ios/` and `android/` add nearby-device play for offline situations. Bluetooth and Wi-Fi should remain enabled; an internet connection is not required.

```sh
npm run native:ios
npm run native:android
```

SCOWL word lists are distributed under their own notices in `public/dictionaries/SCOWL-COPYRIGHT.txt`.
