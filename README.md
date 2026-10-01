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
BASE_PATH=/tiles \
PUBLIC_REALTIME_SERVER=https://tiles-realtime.oliverdelange.workers.dev \
npm run build
```

The production client defaults to `https://tiles-realtime.oliverdelange.workers.dev`.
Set `PUBLIC_REALTIME_SERVER` at build time to use a different Cloudflare Worker.

## Realtime worker

```sh
cd worker
npm install
npm run dev
```

Deployment requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
The Worker accepts browser connections from `oliverdelange.co.uk` and its `www` host.

## Native nearby play

The Capacitor projects in `ios/` and `android/` add nearby-device play for offline situations. Bluetooth and Wi-Fi should remain enabled; an internet connection is not required.

```sh
npm run native:ios
npm run native:android
```

SCOWL word lists are distributed under their own notices in `public/dictionaries/SCOWL-COPYRIGHT.txt`.
