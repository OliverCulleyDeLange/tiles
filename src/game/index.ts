import {
  PLAYER_AREA_HEIGHT,
  PLAYER_AREA_WIDTH,
  PROTOCOL_VERSION,
  createPlayerAreas,
  isDictionaryId,
  sanitizeName,
  sanitizeRoom,
  type ClientMessage,
  type DictionaryId,
  type PlacedTile,
  type PlayerArea,
  type PlayerSummary,
  type RoomSnapshot,
  type ServerMessage,
  type Tile,
} from './protocol';
import { LocalRoomHost } from './local-room';
import { NearbyConnections, isNativeNearby, type NearbyEndpoint } from './nearby';
import { gunzipSync } from 'fflate';
import QRCode from 'qrcode';
import { Capacitor } from '@capacitor/core';

const PRODUCTION_SERVER = import.meta.env.PUBLIC_REALTIME_SERVER
  || 'https://tiles-realtime.oliverdelange.workers.dev';
const DICTIONARY_BASE = `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}dictionaries`;
const ANDROID_NATIVE = Capacitor.getPlatform() === 'android';
const TILE = 48;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.5;

interface LocalTile extends Tile { x: number | null; y: number | null }
interface Point { x: number; y: number }
interface Camera { x: number; y: number; scale: number; rotation: number }
interface Gesture { center: Point; distance: number; angle: number; camera: Camera; world?: Point; rotate?: boolean }
interface FoundWord { text: string; tileIds: string[] }
interface SavedGame {
  room: string;
  name: string;
  phase: RoomSnapshot['phase'];
  playerNames: string[];
  updatedAt: number;
}

const SAVED_GAMES_KEY = 'tiles-saved-games-v1';
const MAX_SAVED_GAMES = 8;

const dictionaryFile = (name: string) => `${DICTIONARY_BASE}/${name}.txt${ANDROID_NATIVE ? '' : '.gz'}`;
const DICTIONARY_FILES: Record<DictionaryId, string> = {
  'scowl-us': dictionaryFile('scowl-us-60'),
  'scowl-gb': dictionaryFile('scowl-gb-60'),
  de: dictionaryFile('de'),
  es: dictionaryFile('es'),
  it: dictionaryFile('it'),
  fr: dictionaryFile('fr'),
  pt: dictionaryFile('pt'),
};

export function createTiles(root: HTMLElement): void {
  const nameGate = root.querySelector<HTMLElement>('[data-view="name"]')!;
  const lobby = root.querySelector<HTMLElement>('[data-view="lobby"]')!;
  const game = root.querySelector<HTMLElement>('[data-view="game"]')!;
  const nameForm = root.querySelector<HTMLFormElement>('[data-name-form]')!;
  const nameInput = root.querySelector<HTMLInputElement>('[data-name-input]')!;
  const enterLobby = root.querySelector<HTMLButtonElement>('[data-enter-lobby]')!;
  const savedGames = root.querySelector<HTMLElement>('[data-saved-games]')!;
  const savedGameList = root.querySelector<HTMLElement>('[data-saved-game-list]')!;
  const roomNote = root.querySelector<HTMLElement>('[data-room-note]')!;
  const roster = root.querySelector<HTMLElement>('[data-roster]')!;
  const dictionarySelect = root.querySelector<HTMLSelectElement>('[data-dictionary]')!;
  const roomLabels = root.querySelectorAll<HTMLElement>('[data-room-label]');
  const lobbyBack = root.querySelector<HTMLButtonElement>('[data-lobby-back]')!;
  const start = root.querySelector<HTMLButtonElement>('[data-start]')!;
  const onlineInvite = root.querySelector<HTMLElement>('[data-online-invite]')!;
  const roomQr = root.querySelector<HTMLCanvasElement>('[data-room-qr]')!;
  const copyLink = root.querySelector<HTMLButtonElement>('[data-copy-link]')!;
  const share = root.querySelector<HTMLButtonElement>('[data-share]')!;
  const lobbyHelp = root.querySelector<HTMLElement>('.lobby-help')!;
  const board = root.querySelector<HTMLElement>('[data-board]')!;
  const boardLayer = root.querySelector<HTMLElement>('[data-board-layer]')!;
  const boardLabel = root.querySelector<HTMLElement>('[data-board-label]')!;
  const rack = root.querySelector<HTMLElement>('[data-rack]')!;
  const rackWrap = root.querySelector<HTMLElement>('.rack-wrap')!;
  const dump = root.querySelector<HTMLButtonElement>('[data-dump]')!;
  const gameMenuOpen = root.querySelector<HTMLButtonElement>('[data-game-menu-open]')!;
  const gameMenu = root.querySelector<HTMLDialogElement>('[data-game-menu]')!;
  const gameMenuClose = root.querySelector<HTMLButtonElement>('[data-game-menu-close]')!;
  const newGame = root.querySelector<HTMLButtonElement>('[data-new-game]')!;
  const goHome = root.querySelector<HTMLButtonElement>('[data-go-home]')!;
  const bunch = root.querySelector<HTMLElement>('[data-bunch]')!;
  const peel = root.querySelector<HTMLElement>('[data-peel]')!;
  const players = root.querySelector<HTMLElement>('[data-players]')!;
  const rotateLeft = root.querySelector<HTMLButtonElement>('[data-rotate-left]')!;
  const rotateRight = root.querySelector<HTMLButtonElement>('[data-rotate-right]')!;
  const resetView = root.querySelector<HTMLButtonElement>('[data-reset-view]')!;
  const toast = root.querySelector<HTMLElement>('[data-toast]')!;
  const nearbyEntry = root.querySelector<HTMLElement>('[data-nearby-entry]')!;
  const nearbyHostButton = root.querySelector<HTMLButtonElement>('[data-nearby-host]')!;
  const nearbyJoinButton = root.querySelector<HTMLButtonElement>('[data-nearby-join]')!;
  const nearbyDialog = root.querySelector<HTMLDialogElement>('[data-nearby-dialog]')!;
  const nearbyTitle = root.querySelector<HTMLElement>('[data-nearby-title]')!;
  const nearbyStatus = root.querySelector<HTMLElement>('[data-nearby-status]')!;
  const nearbyEndpoints = root.querySelector<HTMLElement>('[data-nearby-endpoints]')!;
  const nearbyClose = root.querySelector<HTMLButtonElement>('[data-nearby-close]')!;
  const updateNotice = root.querySelector<HTMLElement>('[data-update-notice]')!;
  const updateNow = root.querySelector<HTMLButtonElement>('[data-update-now]')!;
  const connectionNotice = root.querySelector<HTMLElement>('[data-connection-notice]')!;
  const connectionMessage = root.querySelector<HTMLElement>('[data-connection-message]')!;
  const retryConnection = root.querySelector<HTMLButtonElement>('[data-retry-connection]')!;

  const params = new URLSearchParams(location.search);
  let roomName = sanitizeRoom(params.get('room'));
  const server = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'ws://localhost:8788'
    : PRODUCTION_SERVER.replace(/^http/, 'ws');
  roomLabels.forEach(label => { label.textContent = roomName; });
  if (roomName) {
    enterLobby.textContent = 'Join lobby';
    roomNote.textContent = `Private room ${roomName} · 2–8 players`;
  }
  nameInput.value = localStorage.getItem('tiles-name') ?? '';
  if (!Capacitor.isNativePlatform()) nameInput.focus();

  let socket: WebSocket | null = null;
  let onlineName = '';
  let onlineReconnectEnabled = false;
  let connectionMode: 'online' | 'nearby-host' | 'nearby-join' | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let localHost: LocalRoomHost | null = null;
  let nearbyHostId: string | null = null;
  let nearbyHostName = '';
  let nearbyAutoReconnect = false;
  let nearbyConnectingId: string | null = null;
  let nearbyReconnectAttempt = 0;
  let nearbyReconnectTimer: number | null = null;
  let nearbyName = '';
  let nearbyPermissionAliases: string[] | undefined;
  let transportSend: ((message: object) => void) | null = null;
  let myId = '';
  let state: RoomSnapshot | null = null;
  let tiles: LocalTile[] = [];
  let selectedId: string | null = null;
  const selectedIds = new Set<string>();
  let peelSent = -1;
  let dictionaryWords = new Set<string>();
  let loadedDictionary: DictionaryId | null = null;
  let loadingDictionary: DictionaryId | null = null;
  let dragging: {
    id: string;
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    wasPlaced: boolean;
    dragIds: string[];
    ghosts: Array<{ element: HTMLElement; dx: number; dy: number }>;
    target: HTMLElement;
    pointerId: number;
  } | null = null;
  let camera: Camera = { x: 0, y: 0, scale: 1, rotation: 0 };
  const pointers = new Map<number, Point>();
  let gesture: Gesture | null = null;
  let nativeGesture: { camera: Camera; x: number; y: number } | null = null;
  let toastTimer: number | null = null;

  function readSavedGames(): SavedGame[] {
    try {
      const value = JSON.parse(localStorage.getItem(SAVED_GAMES_KEY) ?? '[]') as unknown;
      if (!Array.isArray(value)) return [];
      const records = value.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object') return [];
        const record = candidate as Partial<SavedGame>;
        const savedRoom = sanitizeRoom(record.room);
        if (!savedRoom || typeof record.name !== 'string' || !['lobby', 'playing', 'review', 'finished'].includes(record.phase ?? '')) return [];
        return [{
          room: savedRoom,
          name: sanitizeName(record.name),
          phase: record.phase as SavedGame['phase'],
          playerNames: Array.isArray(record.playerNames)
            ? record.playerNames.filter(value => typeof value === 'string').map(sanitizeName).filter(Boolean).slice(0, 8)
            : [],
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        }];
      }).filter(record => record.name && localStorage.getItem(`tiles-session:${record.room}`));
      const fallbackName = sanitizeName(localStorage.getItem('tiles-name'));
      if (fallbackName) {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (!key?.startsWith('tiles-session:')) continue;
          const savedRoom = sanitizeRoom(key.slice('tiles-session:'.length));
          if (!savedRoom || savedRoom === 'nearby' || records.some(record => record.room === savedRoom)) continue;
          records.push({ room: savedRoom, name: fallbackName, phase: 'playing', playerNames: [], updatedAt: 0 });
        }
      }
      return records.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED_GAMES);
    } catch {
      return [];
    }
  }

  function writeSavedGames(records: SavedGame[]): void {
    localStorage.setItem(SAVED_GAMES_KEY, JSON.stringify(records.slice(0, MAX_SAVED_GAMES)));
  }

  function rememberGame(room: RoomSnapshot): void {
    if (connectionMode !== 'online' || !roomName) return;
    const records = readSavedGames().filter(record => record.room !== roomName);
    const me = room.players.find(player => player.id === myId);
    const name = sanitizeName(me?.name ?? onlineName);
    if (name && localStorage.getItem(sessionKey())) records.unshift({
      room: roomName,
      name,
      phase: room.phase,
      playerNames: room.players.map(player => player.name),
      updatedAt: Date.now(),
    });
    writeSavedGames(records);
  }

  function renderSavedGames(): void {
    const records = roomName ? [] : readSavedGames();
    savedGameList.replaceChildren();
    savedGames.hidden = records.length === 0;
    for (const record of records) {
      const item = document.createElement('div');
      item.className = 'saved-game';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'saved-game-open';
      open.dataset.savedRoom = record.room;
      open.dataset.savedName = record.name;
      const title = document.createElement('strong');
      title.textContent = record.playerNames.length ? record.playerNames.join(', ') : `Room ${record.room}`;
      const detail = document.createElement('span');
      detail.textContent = `${record.phase === 'finished' ? 'Winner called · finish your grid' : record.phase === 'review' ? 'Finishing' : record.phase === 'playing' ? 'In progress' : 'In lobby'} · ${new Date(record.updatedAt).toLocaleString()}`;
      open.append(title, detail);
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'saved-game-forget';
      forget.dataset.forgetRoom = record.room;
      forget.setAttribute('aria-label', `Forget room ${record.room}`);
      forget.textContent = '×';
      item.append(open, forget);
      savedGameList.append(item);
    }
  }

  function show(message: string, tone: 'good' | 'bad' | 'plain' = 'plain'): void {
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.style.bottom = game.hidden
      ? '1.5rem'
      : `${Math.max(12, window.innerHeight - rackWrap.getBoundingClientRect().top + 12)}px`;
    if (toastTimer != null) window.clearTimeout(toastTimer);
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
      toastTimer = null;
    }, 2200);
  }

  function send(message: object): void {
    if (transportSend) transportSend(message);
    else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function connectionRestored(): void {
    root.dataset.connection = 'online';
    connectionNotice.hidden = true;
    retryConnection.disabled = false;
  }

  function connectionLost(message: string): void {
    root.dataset.connection = 'offline';
    connectionMessage.textContent = message;
    connectionNotice.hidden = false;
    retryConnection.disabled = false;
  }

  async function loadDictionary(dictionary: DictionaryId): Promise<void> {
    if (loadedDictionary === dictionary || loadingDictionary === dictionary) return;
    loadingDictionary = dictionary;
    dictionaryWords = new Set();
    renderTiles();
    try {
      const response = await fetch(DICTIONARY_FILES[dictionary]);
      if (!response.ok) throw new Error(`Dictionary request failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contents = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
      const words = new TextDecoder().decode(contents)
        .split(/\s+/).filter(Boolean).map(word => word.toUpperCase());
      if (loadingDictionary !== dictionary) return;
      dictionaryWords = new Set(words);
      loadedDictionary = dictionary;
      loadingDictionary = null;
      renderTiles();
    } catch {
      if (loadingDictionary !== dictionary) return;
      loadingDictionary = null;
      show('Could not load the selected dictionary.', 'bad');
    }
  }

  function createRoomName(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  function handleServerMessage(message: ServerMessage): void {
    if (message.t === 'welcome') {
      myId = message.id;
      if (message.resumeToken) localStorage.setItem(sessionKey(), message.resumeToken);
      connectionRestored();
      reconnectAttempt = 0;
      updateRoom(message.room);
    } else if (message.t === 'room') updateRoom(message.room);
    else if (message.t === 'new-game') {
      cancelDrag();
      tiles = [];
      selectedId = null;
      selectedIds.clear();
      peelSent = -1;
      renderTiles();
    } else if (message.t === 'layout') {
      const player = state?.players.find(value => value.id === message.playerId);
      if (!player) return;
      player.board = message.board;
      player.tilesLeft = player.tiles.length - message.board.length;
      if (message.playerId === myId) syncOwnBoard(state!);
      if (!dragging && !gesture && !nativeGesture) renderTiles();
    } else if (message.t === 'hand') {
      if (message.replace) {
        const previous = new Map(tiles.map(tile => [tile.id, tile]));
        const restored = new Map((state?.players.find(player => player.id === myId)?.board ?? []).map(tile => [tile.id, tile]));
        const incoming = new Map(message.tiles.map(tile => [tile.id, tile]));
        const slots: Array<LocalTile | null> = tiles.map(existing => {
          const tile = incoming.get(existing.id);
          if (!tile) return null;
          incoming.delete(existing.id);
          const placed = previous.get(tile.id) ?? restored.get(tile.id);
          return { ...tile, x: placed?.x ?? null, y: placed?.y ?? null };
        });
        const additions = [...incoming.values()].map(tile => {
          const placed = restored.get(tile.id);
          return { ...tile, x: placed?.x ?? null, y: placed?.y ?? null } as LocalTile;
        });
        if (!slots.length) tiles = additions;
        else tiles = fillRackSpaces(slots, additions);
      } else {
        const slots: Array<LocalTile | null> = [...tiles];
        tiles = fillRackSpaces(slots, message.tiles.map(tile => ({ ...tile, x: null, y: null })));
      }
      if (!dragging) {
        selectedId = null;
        selectedIds.clear();
        renderTiles();
      }
    } else if (message.t === 'toast') show(message.text, message.tone);
    else if (message.t === 'error') {
      show(message.message, 'bad');
      if (!myId) enterLobby.disabled = false;
    }
  }

  function connectOnline(name: string): void {
    onlineName = name;
    connectionMode = 'online';
    onlineReconnectEnabled = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    transportSend = null;
    onlineInvite.hidden = false;
    void renderInviteCode();
    lobbyHelp.textContent = 'Share the private link to invite up to seven other players. The host chooses the dictionary for everyone.';
    const connection = new WebSocket(`${server}/rooms/${encodeURIComponent(roomName)}`);
    socket = connection;
    connection.addEventListener('open', () => {
      const resumeToken = localStorage.getItem(sessionKey()) ?? undefined;
      connection.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, resumeToken } satisfies ClientMessage));
    });
    connection.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
      handleServerMessage(message);
    });
    connection.addEventListener('close', () => {
      if (socket !== connection || !onlineReconnectEnabled) return;
      connectionLost('Connection lost. Retrying automatically…');
      scheduleReconnect();
    });
  }

  function sessionKey(): string {
    return `tiles-session:${roomName}`;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer != null || !onlineReconnectEnabled || !onlineName) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (connectionMode !== 'online' || !onlineReconnectEnabled) return;
      connectOnline(onlineName);
    }, delay);
  }

  function stopOnlineTransport(): void {
    onlineReconnectEnabled = false;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    current?.close();
  }

  async function renderInviteCode(): Promise<void> {
    try {
      await QRCode.toCanvas(roomQr, location.href, {
        width: 164,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#17150f', light: '#fffdf3' },
      });
    } catch {
      onlineInvite.hidden = true;
      show('Could not create the invite QR code.', 'bad');
    }
  }

  async function copyGameLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(location.href);
      show('Game link copied', 'good');
    } catch {
      show('Could not copy this link', 'bad');
    }
  }

  const nearbyEndpointMap = new Map<string, NearbyEndpoint>();
  const localPeerId = `local-${crypto.randomUUID().slice(0, 8)}`;

  function clearNearbyReconnectTimer(): void {
    if (nearbyReconnectTimer != null) window.clearTimeout(nearbyReconnectTimer);
    nearbyReconnectTimer = null;
  }

  function sendNearby(endpointId: string, message: object): void {
    void NearbyConnections.send({ endpointIds: [endpointId], payload: JSON.stringify(message) }).catch(() => {
      if (connectionMode === 'nearby-join' && nearbyHostId === endpointId) beginNearbyReconnect();
    });
  }

  function beginNearbyReconnect(): void {
    if (connectionMode !== 'nearby-join') return;
    nearbyHostId = null;
    transportSend = null;
    nearbyAutoReconnect = true;
    nearbyConnectingId = null;
    connectionLost('Nearby connection lost. Reconnecting…');
    scheduleNearbyTransport(0);
  }

  function scheduleNearbyTransport(delay?: number): void {
    if (nearbyReconnectTimer != null || (connectionMode !== 'nearby-host' && connectionMode !== 'nearby-join')) return;
    const wait = delay ?? Math.min(8_000, 500 * 2 ** Math.min(nearbyReconnectAttempt++, 4));
    nearbyReconnectTimer = window.setTimeout(() => {
      nearbyReconnectTimer = null;
      void resumeNearbyTransport();
    }, wait);
  }

  async function resumeNearbyTransport(): Promise<void> {
    if (connectionMode !== 'nearby-host' && connectionMode !== 'nearby-join') return;
    try {
      await NearbyConnections.setKeepAwake({ enabled: true });
      if (connectionMode === 'nearby-host') {
        await NearbyConnections.startAdvertising({ name: nearbyName });
        nearbyReconnectAttempt = 0;
        return;
      }
      if (nearbyHostId) return;
      await NearbyConnections.stopDiscovery();
      await NearbyConnections.startDiscovery({ name: nearbyName });
      nearbyAutoReconnect = true;
      clearNearbyReconnectTimer();
      nearbyReconnectTimer = window.setTimeout(() => {
        nearbyReconnectTimer = null;
        if (!nearbyHostId) void resumeNearbyTransport();
      }, 8_000);
    } catch {
      scheduleNearbyTransport();
    }
  }

  function requireNearbyName(): string | null {
    const name = sanitizeName(nameInput.value);
    if (!name) { nameInput.focus(); return null; }
    localStorage.setItem('tiles-name', name);
    nearbyName = name;
    return name;
  }

  async function requestNearbyPermissions(): Promise<void> {
    if (Capacitor.getPlatform() === 'android') await NearbyConnections.ensurePermissions();
    else await NearbyConnections.requestPermissions(nearbyPermissionAliases?.length ? { permissions: nearbyPermissionAliases } : undefined);
  }

  function renderNearbyEndpoints(): void {
    nearbyEndpoints.innerHTML = '';
    for (const endpoint of nearbyEndpointMap.values()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = endpoint.name;
      button.addEventListener('click', () => {
        nearbyStatus.textContent = `Connecting to ${endpoint.name}…`;
        void NearbyConnections.requestConnection({ endpointId: endpoint.endpointId, name: nearbyName });
      });
      nearbyEndpoints.append(button);
    }
    if (!nearbyEndpointMap.size) nearbyEndpoints.textContent = 'No nearby games found yet.';
  }

  async function initializeNearby(): Promise<void> {
    if (!isNativeNearby()) return;
    const availability = await NearbyConnections.isAvailable().catch(() => ({ available: false }));
    if (!availability.available) return;
    nearbyPermissionAliases = 'permissionAliases' in availability ? availability.permissionAliases : undefined;
    nearbyEntry.hidden = false;

    await NearbyConnections.addListener('endpointFound', endpoint => {
      nearbyEndpointMap.set(endpoint.endpointId, endpoint);
      renderNearbyEndpoints();
      if (connectionMode === 'nearby-join' && nearbyAutoReconnect && !nearbyHostId && !nearbyConnectingId
        && (!nearbyHostName || endpoint.name === nearbyHostName)) {
        nearbyConnectingId = endpoint.endpointId;
        nearbyStatus.textContent = `Reconnecting to ${endpoint.name}…`;
        void NearbyConnections.requestConnection({ endpointId: endpoint.endpointId, name: nearbyName }).catch(() => {
          nearbyConnectingId = null;
          scheduleNearbyTransport();
        });
      }
    });
    await NearbyConnections.addListener('endpointLost', endpoint => {
      nearbyEndpointMap.delete(endpoint.endpointId);
      if (nearbyConnectingId === endpoint.endpointId) nearbyConnectingId = null;
      renderNearbyEndpoints();
    });
    await NearbyConnections.addListener('verificationRequired', verification => {
      nearbyStatus.textContent = `Connecting to ${verification.name}…`;
      void NearbyConnections.acceptVerification({ endpointId: verification.endpointId, accept: true });
    });
    await NearbyConnections.addListener('connected', endpoint => {
      connectionRestored();
      if (localHost) {
        nearbyReconnectAttempt = 0;
        nearbyStatus.textContent = `${endpoint.name} connected.`;
        if (nearbyDialog.open) nearbyDialog.close();
        return;
      }
      clearNearbyReconnectTimer();
      nearbyReconnectAttempt = 0;
      nearbyAutoReconnect = false;
      nearbyConnectingId = null;
      nearbyHostId = endpoint.endpointId;
      nearbyHostName = endpoint.name;
      transportSend = message => sendNearby(endpoint.endpointId, message);
      void NearbyConnections.stopDiscovery();
      if (nearbyDialog.open) nearbyDialog.close();
      const resumeToken = localStorage.getItem(sessionKey()) ?? undefined;
      send({ t: 'hello', v: PROTOCOL_VERSION, name: nearbyName, resumeToken });
    });
    await NearbyConnections.addListener('disconnected', endpoint => {
      if (localHost) {
        localHost.disconnect(endpoint.endpointId);
        show(`${endpoint.name} disconnected. Waiting for them to rejoin…`, 'bad');
        scheduleNearbyTransport(0);
      }
      else if (nearbyHostId === endpoint.endpointId) {
        beginNearbyReconnect();
      } else if (nearbyConnectingId === endpoint.endpointId) {
        nearbyConnectingId = null;
        scheduleNearbyTransport();
      }
    });
    await NearbyConnections.addListener('payloadReceived', event => {
      try {
        if (localHost) localHost.receive(event.endpointId, JSON.parse(event.payload) as ClientMessage);
        else handleServerMessage(JSON.parse(event.payload) as ServerMessage);
      } catch { /* Ignore malformed nearby payloads. */ }
    });
  }

  async function hostNearby(): Promise<void> {
    const name = requireNearbyName();
    if (!name) return;
    try {
      await requestNearbyPermissions();
      connectionMode = 'nearby-host';
      nearbyName = name;
      nearbyAutoReconnect = false;
      nearbyConnectingId = null;
      nearbyReconnectAttempt = 0;
      clearNearbyReconnectTimer();
      connectionRestored();
      stopOnlineTransport();
      await NearbyConnections.setKeepAwake({ enabled: true });
      await NearbyConnections.startAdvertising({ name });
      roomName = 'nearby';
      roomLabels.forEach(label => { label.textContent = 'Nearby'; });
      onlineInvite.hidden = true;
      lobbyHelp.textContent = 'Friends can join from the nearby-play option. Keep Bluetooth and Wi-Fi enabled.';
      localHost = new LocalRoomHost((peerId, message) => {
        if (peerId === localPeerId) handleServerMessage(message);
        else sendNearby(peerId, message);
      });
      transportSend = message => localHost?.receive(localPeerId, message as ClientMessage);
      localHost.receive(localPeerId, { t: 'hello', v: PROTOCOL_VERSION, name });
      show('Nearby lobby ready. Friends can discover you now.', 'good');
    } catch {
      show('Nearby play needs Bluetooth, Wi-Fi and permission to find devices.', 'bad');
    }
  }

  async function joinNearby(): Promise<void> {
    const name = requireNearbyName();
    if (!name) return;
    try {
      await requestNearbyPermissions();
      connectionMode = 'nearby-join';
      nearbyName = name;
      nearbyAutoReconnect = false;
      nearbyConnectingId = null;
      nearbyReconnectAttempt = 0;
      clearNearbyReconnectTimer();
      connectionRestored();
      stopOnlineTransport();
      await NearbyConnections.setKeepAwake({ enabled: true });
      await NearbyConnections.startDiscovery({ name });
      localHost = null;
      nearbyHostId = null;
      nearbyHostName = '';
      roomName = 'nearby';
      roomLabels.forEach(label => { label.textContent = 'Nearby'; });
      onlineInvite.hidden = true;
      lobbyHelp.textContent = 'This game is connected directly to the nearby host—no internet or invite link needed.';
      nearbyEndpointMap.clear();
      nearbyTitle.textContent = 'Finding nearby games…';
      nearbyStatus.textContent = 'Keep Bluetooth and Wi-Fi enabled.';
      renderNearbyEndpoints();
      nearbyDialog.showModal();
    } catch {
      show('Nearby play needs Bluetooth, Wi-Fi and permission to find devices.', 'bad');
    }
  }

  function updateRoom(next: RoomSnapshot): void {
    if (dragging && next.phase !== 'playing') cancelDrag();
    const previousPhase = state?.phase;
    const dictionary = next.dictionary ?? 'scowl-gb';
    state = next;
    state.dictionary = dictionary;
    rememberGame(next);
    bunch.textContent = String(next.bunch);
    peel.textContent = String(next.peel);
    roster.innerHTML = next.players.map(player =>
      `<li><span class="presence ${player.connected === false ? 'is-offline' : ''}" aria-hidden="true"></span><strong>${escapeHtml(player.name)}</strong>${player.connected === false ? '<em>Reconnecting</em>' : player.id === next.hostId ? '<em>Host</em>' : ''}</li>`
    ).join('');
    players.innerHTML = next.players.map((player, index) =>
      `<li><span class="player-chip ${player.id === myId ? 'is-you' : ''} ${player.eliminated ? 'is-out' : ''} ${player.connected === false ? 'is-offline' : ''}" style="--owner-color:${ownerColor(index)}"><i></i><span>${escapeHtml(player.name)}</span><b>${player.connected === false ? 'OFFLINE' : player.eliminated ? 'OUT' : `${player.tilesLeft} loose`}</b></span></li>`
    ).join('');
    start.hidden = myId !== next.hostId;
    start.disabled = next.players.length < 2;
    start.textContent = next.players.length < 2 ? 'Waiting for an opponent…' : `Start with ${next.players.length} players`;
    dictionarySelect.value = dictionary;
    dictionarySelect.disabled = myId !== next.hostId || next.phase !== 'lobby';
    newGame.disabled = myId !== next.hostId || next.players.length < 2;
    newGame.title = myId === next.hostId ? '' : 'Only the host can start a new game.';
    void loadDictionary(dictionary);

    nameGate.hidden = true;
    lobby.hidden = next.phase !== 'lobby';
    game.hidden = next.phase === 'lobby';

    if ((next.phase === 'playing' && previousPhase === 'lobby') || (previousPhase == null && next.phase !== 'lobby')) {
      peelSent = -1;
      const myIndex = next.players.findIndex(player => player.id === myId);
      const myArea = areaFor(next.players[myIndex], myIndex, next.players.length);
      const startingScale = [0.92, 0.92, 0.72, 0.6, 0.54, 0.47, 0.42, 0.38, 0.35][next.players.length] ?? 0.35;
      camera = { x: 0, y: 0, scale: startingScale, rotation: -(myArea?.rotation ?? 0) };
      applyCamera();
    }
    if (next.phase === 'finished' && next.winnerId && previousPhase !== 'finished') {
      const winner = next.players.find(player => player.id === next.winnerId);
      show(winner?.id === myId ? 'You are Top Banana!' : `${winner?.name ?? 'A player'} wins — you can finish your grid.`, 'good');
    }
    if (!dragging) renderTiles();
  }

  function syncOwnBoard(room: RoomSnapshot): void {
    const mine = room.players.find(player => player.id === myId);
    if (!mine || !tiles.length) return;
    const positions = new Map(mine.board.map(tile => [tile.id, tile]));
    for (const tile of tiles) {
      const position = positions.get(tile.id);
      tile.x = position?.x ?? null;
      tile.y = position?.y ?? null;
    }
  }

  function renderTiles(): void {
    boardLayer.querySelectorAll('.letter-tile').forEach(node => node.remove());
    boardLayer.querySelectorAll('.player-area').forEach(node => node.remove());
    rack.innerHTML = '';
    boardLabel.textContent = `Shared table · ${Math.round(camera.scale * 100)}% · drag, pinch and twist`;

    for (const [playerIndex, player] of (state?.players ?? []).entries()) {
      const color = ownerColor(playerIndex);
      const area = areaFor(player, playerIndex, state?.players.length ?? 1);
      if (area) boardLayer.append(makePlayerArea(player, area, color));
      const isMine = player.id === myId;
      const sourceTiles = isMine ? tiles : player.tiles.map(tile => ({ ...tile, x: null, y: null }));
      const playerBoard = isMine ? boardPayload() : player.board;
      const positions = new Map(playerBoard.map(tile => [tile.id, tile]));
      const validity = wordValidity(playerBoard, area?.rotation ?? 0);
      for (const source of sourceTiles) {
        const position = positions.get(source.id);
        if (!position) continue;
        const tile = { ...source, x: position.x, y: position.y } as LocalTile;
        const element = makeTile(tile, player, color, isMine && canEditTiles(), area?.rotation ?? 0, validity.get(tile.id));
        positionTile(element, position.x, position.y);
        boardLayer.append(element);
      }
    }

    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const me = state?.players.find(player => player.id === myId);
    for (const tile of tiles) {
      const slot = document.createElement('div');
      slot.className = 'rack-slot';
      slot.dataset.rackId = tile.id;
      if (tile.x == null || tile.y == null) slot.append(makeTile(tile, me, ownerColor(Math.max(0, myIndex)), canEditTiles(), 0));
      rack.append(slot);
    }
    dump.disabled = !selectedId || (state?.bunch ?? 0) < 3 || state?.phase !== 'playing';
    maybePeel();
  }

  function canEditTiles(): boolean {
    return state?.phase === 'playing' || (state?.phase === 'finished' && state.winnerId !== myId);
  }

  function makePlayerArea(player: PlayerSummary, area: PlayerArea, color: string): HTMLElement {
    const element = document.createElement('div');
    element.className = `player-area${player.id === myId ? ' is-you' : ''}`;
    element.style.left = `calc(50% + ${area.x * TILE}px)`;
    element.style.top = `calc(50% + ${area.y * TILE}px)`;
    element.style.width = `${PLAYER_AREA_WIDTH * TILE}px`;
    element.style.height = `${PLAYER_AREA_HEIGHT * TILE}px`;
    element.style.transform = `translate(-50%, -50%) rotate(${area.rotation}rad)`;
    element.style.setProperty('--owner-color', color);
    element.innerHTML = `<span>${escapeHtml(player.name)}${player.id === myId ? ' · YOU' : ''}</span>`;
    return element;
  }

  function makeTile(
    tile: LocalTile,
    owner: PlayerSummary | undefined,
    color: string,
    editable: boolean,
    rotation: number,
    validity?: 'valid' | 'invalid',
  ): HTMLElement {
    const element = document.createElement(editable ? 'button' : 'span');
    if (element instanceof HTMLButtonElement) element.type = 'button';
    element.className = `letter-tile${editable ? '' : ' is-spectating'}`;
    element.textContent = tile.letter;
    element.dataset.id = tile.id;
    element.style.setProperty('--owner-color', color);
    element.style.setProperty('--tile-rotation', `${rotation}rad`);
    element.setAttribute('aria-label', `Letter ${tile.letter}, ${owner?.name ?? 'player'}'s tile`);
    element.classList.toggle('is-selected', editable && selectedIds.has(tile.id));
    element.classList.toggle('is-valid-word', validity === 'valid');
    element.classList.toggle('is-invalid-word', validity === 'invalid');
    if (editable) element.addEventListener('pointerdown', event => beginDrag(event as PointerEvent, tile));
    return element;
  }

  function positionTile(element: HTMLElement, x: number, y: number): void {
    element.style.left = `calc(50% + ${x * TILE - TILE / 2}px)`;
    element.style.top = `calc(50% + ${y * TILE - TILE / 2}px)`;
  }

  function beginDrag(event: PointerEvent, tile: LocalTile): void {
    if (!canEditTiles()) return;
    event.stopPropagation();
    if (pointers.has(event.pointerId) || pointers.size > 1) return;
    const target = event.currentTarget as HTMLElement;
    const wasPlaced = tile.x != null && tile.y != null;
    const rect = target.getBoundingClientRect();
    dragging = {
      id: tile.id,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      wasPlaced,
      dragIds: [],
      ghosts: [],
      target,
      pointerId: event.pointerId,
    };
    target.setPointerCapture(event.pointerId);
    target.addEventListener('pointermove', moveDrag);
    target.addEventListener('pointerup', endDrag, { once: true });
    target.addEventListener('pointercancel', endDrag, { once: true });
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging.lastX = event.clientX;
    dragging.lastY = event.clientY;
    if (!dragging.moved && Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 6) return;
    if (!dragging.moved) startDragVisuals(dragging);
    dragging.moved = true;
    for (const ghost of dragging.ghosts) {
      ghost.element.style.left = `${event.clientX - ghost.dx}px`;
      ghost.element.style.top = `${event.clientY - ghost.dy}px`;
    }
  }

  function startDragVisuals(interaction: NonNullable<typeof dragging>): void {
    const tile = tiles.find(value => value.id === interaction.id);
    if (!tile) return;
    if (interaction.wasPlaced) {
      if (!selectedIds.has(tile.id)) {
        selectedIds.clear();
        selectedIds.add(tile.id);
        selectedId = tile.id;
      }
      interaction.dragIds = [...selectedIds].filter(id => {
        const value = tiles.find(candidate => candidate.id === id);
        return value?.x != null && value.y != null;
      });
    } else interaction.dragIds = [tile.id];

    for (const id of interaction.dragIds) {
      const original = [...root.querySelectorAll<HTMLElement>('.letter-tile')].find(element => element.dataset.id === id);
      if (!original) continue;
      const rect = original.getBoundingClientRect();
      const ghost = original.cloneNode(true) as HTMLElement;
      ghost.classList.add('is-dragging', 'tile-drag-overlay');
      ghost.style.position = 'fixed';
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.pointerEvents = 'none';
      document.body.append(ghost);
      original.style.visibility = 'hidden';
      interaction.ghosts.push({
        element: ghost,
        dx: interaction.startX - rect.left,
        dy: interaction.startY - rect.top,
      });
    }
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    const tile = tiles.find(value => value.id === dragging!.id);
    const interaction = dragging;
    if (!interaction.moved) {
      finishDrag(interaction);
      if (tile && interaction.wasPlaced) toggleSelection(tile.id);
      else if (tile && !boardPayload().length) placeFirstTile(tile);
      else if (tile && selectedId && tiles.some(value => value.id === selectedId && value.x != null && value.y != null)) {
        addTappedTile(tile, selectedId);
      }
      else if (tile) {
        selectedIds.clear();
        selectedIds.add(tile.id);
        selectedId = tile.id;
      }
      renderTiles();
      return;
    }
    const rect = board.getBoundingClientRect();
    let layoutChanged = false;
    if (tile && pointInRect(event.clientX, event.clientY, rect)) {
      const world = screenToWorld(event.clientX, event.clientY);
      const x = Math.round(world.x / TILE);
      const y = Math.round(world.y / TILE);
      const moving = interaction.dragIds.length ? interaction.dragIds : [tile.id];
      const movingSet = new Set(moving);
      const originX = tile.x;
      const originY = tile.y;
      const dx = originX == null ? 0 : x - originX;
      const dy = originY == null ? 0 : y - originY;
      const destinations = moving.map(id => {
        const value = tiles.find(candidate => candidate.id === id)!;
        return { value, x: id === tile.id && originX == null ? x : (value.x ?? x) + dx, y: id === tile.id && originY == null ? y : (value.y ?? y) + dy };
      });
      const occupied = allPlaced().find(value => !movingSet.has(value.tile.id) && destinations.some(destination => destination.x === value.tile.x && destination.y === value.tile.y));
      const outOfBounds = destinations.some(destination => Math.abs(destination.x) > 100 || Math.abs(destination.y) > 100);
      if (outOfBounds) {
        show('That is beyond the edge of the table.', 'bad');
      } else if (occupied) {
        show(`${occupied.ownerName}'s tile is already there.`, 'bad');
      } else {
        for (const destination of destinations) {
          destination.value.x = destination.x;
          destination.value.y = destination.y;
        }
        selectedIds.clear();
        moving.forEach(id => selectedIds.add(id));
        selectedId = tile.id;
        layoutChanged = true;
      }
    } else if (tile && !interaction.wasPlaced && pointInRect(event.clientX, event.clientY, rack.getBoundingClientRect())) {
      reorderRack(tile.id, event.clientX, event.clientY);
    } else if (tile && interaction.dragIds.length) {
      for (const id of interaction.dragIds) {
        const value = tiles.find(candidate => candidate.id === id);
        if (value) { value.x = null; value.y = null; }
      }
      if (pointInRect(event.clientX, event.clientY, rackWrap.getBoundingClientRect())) {
        reorderRack(tile.id, event.clientX, event.clientY);
      }
      selectedIds.clear();
      selectedId = null;
      layoutChanged = interaction.wasPlaced;
    }
    finishDrag(interaction);
    if (layoutChanged) sendOwnLayout();
    renderTiles();
  }

  function placeFirstTile(tile: LocalTile): void {
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const area = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1);
    const rotation = area?.rotation ?? 0;
    const left = -(PLAYER_AREA_WIDTH / 2 - 0.5);
    const top = -(PLAYER_AREA_HEIGHT / 2 - 0.5) + 1;
    tile.x = Math.round((area?.x ?? 0) + left * Math.cos(rotation) - top * Math.sin(rotation));
    tile.y = Math.round((area?.y ?? 0) + left * Math.sin(rotation) + top * Math.cos(rotation));
    selectedIds.clear();
    selectedIds.add(tile.id);
    selectedId = tile.id;
    sendOwnLayout();
  }

  function addTappedTile(tile: LocalTile, anchorId: string): void {
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const area = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1);
    const anchor = tiles.find(value => value.id === anchorId && value.x != null && value.y != null);
    if (!anchor || anchor.x == null || anchor.y == null) return;

    const placed = boardPayload();
    const at = new Map(placed.map(value => [`${value.x},${value.y}`, value]));
    const rotation = area?.rotation ?? 0;
    const rightX = Math.round(Math.cos(rotation));
    const rightY = Math.round(Math.sin(rotation));
    const downX = -rightY;
    const downY = rightX;
    const verticalRun = axisRun(anchor.x, anchor.y, downX, downY, at);
    const followDown = verticalRun.length >= 2;
    const stepX = followDown ? downX : rightX;
    const stepY = followDown ? downY : rightY;
    const run = followDown ? verticalRun : axisRun(anchor.x, anchor.y, rightX, rightY, at);
    const end = run.at(-1);
    const targetX = (end?.x ?? anchor.x) + stepX;
    const targetY = (end?.y ?? anchor.y) + stepY;
    const occupied = allPlaced().find(value => value.tile.x === targetX && value.tile.y === targetY);
    if (occupied) {
      show(`${occupied.ownerName}'s tile is already there.`, 'bad');
      return;
    }

    tile.x = targetX;
    tile.y = targetY;
    selectedIds.clear();
    selectedIds.add(tile.id);
    selectedId = tile.id;
    sendOwnLayout();
  }

  function axisRun(
    startX: number,
    startY: number,
    dx: number,
    dy: number,
    at: Map<string, PlacedTile>,
  ): PlacedTile[] {
    const values: PlacedTile[] = [];
    let x = startX;
    let y = startY;
    while (at.has(`${x - dx},${y - dy}`)) {
      x -= dx;
      y -= dy;
    }
    while (at.has(`${x},${y}`)) {
      values.push(at.get(`${x},${y}`)!);
      x += dx;
      y += dy;
    }
    return values;
  }

  function sendOwnLayout(): void {
    const board = boardPayload();
    const player = state?.players.find(value => value.id === myId);
    if (player) {
      player.board = board;
      player.tilesLeft = player.tiles.length - board.length;
    }
    send({ t: 'layout', board });
  }

  function fillRackSpaces(slots: Array<LocalTile | null>, additions: LocalTile[]): LocalTile[] {
    const displaced: LocalTile[] = [];
    for (const tile of additions) {
      const index = slots.findIndex(value => value == null || (value.x != null && value.y != null));
      if (index < 0) {
        slots.push(tile);
        continue;
      }
      const occupant = slots[index];
      if (occupant) displaced.push(occupant);
      slots[index] = tile;
    }
    return [...slots.filter((tile): tile is LocalTile => tile != null), ...displaced];
  }

  function cancelDrag(): void {
    if (!dragging) return;
    finishDrag(dragging);
  }

  function finishDrag(interaction: NonNullable<typeof dragging>): void {
    interaction.target.removeEventListener('pointermove', moveDrag);
    interaction.target.removeEventListener('pointerup', endDrag);
    interaction.target.removeEventListener('pointercancel', endDrag);
    try {
      if (interaction.target.hasPointerCapture(interaction.pointerId)) {
        interaction.target.releasePointerCapture(interaction.pointerId);
      }
    } catch {}
    interaction.ghosts.forEach(ghost => ghost.element.remove());
    if (dragging === interaction) dragging = null;
  }

  function reorderRack(tileId: string, clientX: number, clientY: number): void {
    const tile = tiles.find(value => value.id === tileId);
    if (!tile) return;
    const sourceIndex = tiles.findIndex(value => value.id === tileId);
    const slots = [...rack.querySelectorAll<HTMLElement>('[data-rack-id]')];
    const targetSlot = slots.reduce<HTMLElement | null>((closest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      if (pointInRect(clientX, clientY, rect)) return candidate;
      if (!closest) return candidate;
      const closestRect = closest.getBoundingClientRect();
      const distance = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
      const closestDistance = Math.hypot(clientX - (closestRect.left + closestRect.width / 2), clientY - (closestRect.top + closestRect.height / 2));
      return distance < closestDistance ? candidate : closest;
    }, null);
    const targetIndex = tiles.findIndex(value => value.id === targetSlot?.dataset.rackId);
    const targetTile = tiles[targetIndex];
    if (targetTile && targetTile.id !== tileId && targetTile.x != null && targetTile.y != null) {
      [tiles[sourceIndex], tiles[targetIndex]] = [tiles[targetIndex], tiles[sourceIndex]];
      return;
    }

    const remaining = tiles.filter(value => value.id !== tileId);
    const elements = slots
      .filter(element => element.dataset.rackId !== tileId);
    let insertion = remaining.length;
    if (elements.length) {
      const rows: Array<{ centerY: number; entries: Array<{ id: string; centerX: number }> }> = [];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        let row = rows.find(value => Math.abs(value.centerY - centerY) < rect.height / 2);
        if (!row) { row = { centerY, entries: [] }; rows.push(row); }
        row.entries.push({ id: element.dataset.rackId!, centerX: rect.left + rect.width / 2 });
      }
      rows.sort((a, b) => a.centerY - b.centerY);
      const row = rows.reduce((closest, candidate) =>
        Math.abs(candidate.centerY - clientY) < Math.abs(closest.centerY - clientY) ? candidate : closest
      );
      row.entries.sort((a, b) => a.centerX - b.centerX);
      const before = row.entries.find(entry => clientX < entry.centerX);
      const anchorId = before?.id ?? row.entries.at(-1)?.id;
      const anchorIndex = remaining.findIndex(value => value.id === anchorId);
      insertion = before ? anchorIndex : anchorIndex + 1;
    }
    remaining.splice(Math.max(0, insertion), 0, tile);
    tiles = remaining;
  }

  function clearSelection(): void {
    selectedIds.clear();
    selectedId = null;
    root.querySelectorAll('.letter-tile.is-selected').forEach(element => element.classList.remove('is-selected'));
    dump.disabled = true;
  }

  function toggleSelection(id: string): void {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      selectedId = [...selectedIds].at(-1) ?? null;
    } else {
      selectedIds.add(id);
      selectedId = id;
    }
  }

  function allPlaced(): Array<{ tile: PlacedTile; ownerId: string; ownerName: string }> {
    return (state?.players ?? []).flatMap(player => {
      const values = player.id === myId ? boardPayload() : player.board;
      return values.map(tile => ({ tile, ownerId: player.id, ownerName: player.name }));
    });
  }

  function boardPayload(): PlacedTile[] {
    return tiles.filter((tile): tile is LocalTile & { x: number; y: number } => tile.x != null && tile.y != null)
      .map(({ id, letter, x, y }) => ({ id, letter, x, y }));
  }

  function findWords(values: PlacedTile[], rotation = 0): FoundWord[] {
    const cells = new Map(values.map(tile => [`${tile.x},${tile.y}`, tile]));
    const words: FoundWord[] = [];
    const rightX = Math.round(Math.cos(rotation));
    const rightY = Math.round(Math.sin(rotation));
    const directions = [[rightX, rightY], [-rightY, rightX]] as const;
    for (const tile of values) {
      for (const [dx, dy] of directions) {
        if (cells.has(`${tile.x - dx},${tile.y - dy}`) || !cells.has(`${tile.x + dx},${tile.y + dy}`)) continue;
        const run: PlacedTile[] = [];
        let x = tile.x;
        let y = tile.y;
        while (cells.has(`${x},${y}`)) {
          run.push(cells.get(`${x},${y}`)!);
          x += dx;
          y += dy;
        }
        words.push({ text: run.map(value => value.letter).join('').toUpperCase(), tileIds: run.map(value => value.id) });
      }
    }
    return words;
  }

  function wordValidity(values: PlacedTile[], rotation = 0): Map<string, 'valid' | 'invalid'> {
    const result = new Map<string, 'valid' | 'invalid'>();
    if (!state || loadedDictionary !== state.dictionary) return result;
    for (const word of findWords(values, rotation)) {
      const status = dictionaryWords.has(word.text) ? 'valid' : 'invalid';
      for (const id of word.tileIds) {
        if (status === 'invalid' || !result.has(id)) result.set(id, status);
      }
    }
    return result;
  }

  function allWordsValid(values: PlacedTile[]): boolean {
    if (!state || loadedDictionary !== state.dictionary) return false;
    const myIndex = state.players.findIndex(player => player.id === myId);
    const rotation = areaFor(state.players[myIndex], myIndex, state.players.length)?.rotation ?? 0;
    const words = findWords(values, rotation);
    if (!words.length || words.some(word => !dictionaryWords.has(word.text))) return false;
    const covered = new Set(words.flatMap(word => word.tileIds));
    return covered.size === values.length;
  }

  function connected(values: PlacedTile[]): boolean {
    if (values.length < 2) return false;
    const cells = new Set(values.map(tile => `${tile.x},${tile.y}`));
    const reached = new Set<string>();
    const queue = [cells.values().next().value as string];
    while (queue.length) {
      const cell = queue.pop()!;
      if (reached.has(cell)) continue;
      reached.add(cell);
      const [x, y] = cell.split(',').map(Number);
      for (const next of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        if (cells.has(next) && !reached.has(next)) queue.push(next);
      }
    }
    return reached.size === values.length;
  }

  function maybePeel(): void {
    if (!state || state.phase !== 'playing' || tiles.length === 0 || tiles.some(tile => tile.x == null)) return;
    const payload = boardPayload();
    if (!connected(payload) || !allWordsValid(payload) || peelSent === state.peel) return;
    peelSent = state.peel;
    send({ t: 'peel', peel: state.peel, board: payload });
  }

  function applyCamera(): void {
    boardLayer.style.transform = `translate(${camera.x}px, ${camera.y}px) rotate(${camera.rotation}rad) scale(${camera.scale})`;
    boardLabel.textContent = `Shared table · ${Math.round(camera.scale * 100)}% · drag, pinch and twist`;
  }

  function screenToWorld(clientX: number, clientY: number): Point {
    return screenToWorldFor(clientX, clientY, camera);
  }

  function screenToWorldFor(clientX: number, clientY: number, view: Camera): Point {
    const rect = board.getBoundingClientRect();
    const dx = clientX - rect.left - rect.width / 2 - view.x;
    const dy = clientY - rect.top - rect.height / 2 - view.y;
    const cosine = Math.cos(-view.rotation);
    const sine = Math.sin(-view.rotation);
    return {
      x: (dx * cosine - dy * sine) / view.scale,
      y: (dx * sine + dy * cosine) / view.scale,
    };
  }

  function transformAt(scale: number, rotation: number, clientX: number, clientY: number): void {
    const world = screenToWorld(clientX, clientY);
    const rect = board.getBoundingClientRect();
    const pivotX = clientX - rect.left - rect.width / 2;
    const pivotY = clientY - rect.top - rect.height / 2;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    camera.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    camera.rotation = rotation;
    camera.x = pivotX - (world.x * cosine - world.y * sine) * camera.scale;
    camera.y = pivotY - (world.x * sine + world.y * cosine) * camera.scale;
    applyCamera();
  }

  function rotateToPlayerView(direction: -1 | 1): void {
    if (!state?.players.length) return;
    const turn = Math.PI * 2;
    const normalized = ((camera.rotation % turn) + turn) % turn;
    const views = [...new Set(state.players.map((player, index) => {
      const area = areaFor(player, index, state!.players.length);
      return (((-(area?.rotation ?? 0)) % turn) + turn) % turn;
    }))];
    const deltas = views.map(view => direction > 0
      ? (view - normalized + turn) % turn
      : -((normalized - view + turn) % turn)
    ).filter(delta => Math.abs(delta) > 0.001);
    if (!deltas.length) return;
    const delta = direction > 0 ? Math.min(...deltas) : Math.max(...deltas);
    const rect = board.getBoundingClientRect();
    transformAt(camera.scale, camera.rotation + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function gestureFromPointers(): { center: Point; distance: number; angle: number } | null {
    const values = [...pointers.values()];
    if (values.length < 2) return null;
    const [a, b] = values;
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  function resetPointerGesture(): void {
    for (const pointerId of pointers.keys()) {
      try {
        if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
      } catch {}
    }
    pointers.clear();
    gesture = null;
    board.classList.remove('is-panning');
  }

  function resetAllGestures(): void {
    cancelDrag();
    resetPointerGesture();
    nativeGesture = null;
  }

  nameForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = sanitizeName(nameInput.value);
    if (!name) return nameInput.focus();
    if (!roomName) {
      roomName = createRoomName();
      const url = new URL(location.href);
      url.searchParams.set('room', roomName);
      history.replaceState(null, '', url);
      roomLabels.forEach(label => { label.textContent = roomName; });
      roomNote.textContent = `Private room ${roomName} · 2–8 players`;
    }
    localStorage.setItem('tiles-name', name);
    enterLobby.disabled = true;
    connectOnline(name);
  });
  savedGameList.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const open = target.closest<HTMLButtonElement>('[data-saved-room]');
    if (open?.dataset.savedRoom && open.dataset.savedName) {
      localStorage.setItem('tiles-name', open.dataset.savedName);
      const url = new URL(location.href);
      url.searchParams.set('room', open.dataset.savedRoom);
      location.assign(url);
      return;
    }
    const forget = target.closest<HTMLButtonElement>('[data-forget-room]');
    if (!forget?.dataset.forgetRoom) return;
    const forgottenRoom = forget.dataset.forgetRoom;
    writeSavedGames(readSavedGames().filter(record => record.room !== forgottenRoom));
    localStorage.removeItem(`tiles-session:${forgottenRoom}`);
    renderSavedGames();
  });
  nearbyHostButton.addEventListener('click', () => { void hostNearby(); });
  nearbyJoinButton.addEventListener('click', () => { void joinNearby(); });
  nearbyClose.addEventListener('click', async () => {
    nearbyDialog.close();
    if (connectionMode !== 'nearby-join' || state) return;
    connectionMode = null;
    nearbyEndpointMap.clear();
    await NearbyConnections.stop().catch(() => undefined);
  });
  dictionarySelect.addEventListener('change', () => {
    const dictionary = dictionarySelect.value as DictionaryId;
    if (isDictionaryId(dictionary)) send({ t: 'dictionary', dictionary });
  });
  start.addEventListener('click', () => send({ t: 'start' }));
  copyLink.addEventListener('click', () => { void copyGameLink(); });
  share.addEventListener('click', async () => {
    const data = {
      title: 'Join my Tiles game',
      text: 'Join my private Tiles lobby.',
      url: location.href,
    };
    try {
      if (navigator.share) await navigator.share(data);
      else await copyGameLink();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      await copyGameLink();
    }
  });

  board.addEventListener('pointerdown', event => {
    if ((event.target as HTMLElement).closest('.letter-tile, [data-board-controls]')) return;
    if (pointers.has(event.pointerId)) return;
    if (!pointers.size) {
      nativeGesture = null;
      clearSelection();
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    board.setPointerCapture(event.pointerId);
    board.classList.add('is-panning');
    const current = gestureFromPointers();
    gesture = current ? { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) } : {
      center: { x: event.clientX, y: event.clientY }, distance: 0, angle: 0, camera: { ...camera }, rotate: event.shiftKey || event.altKey,
    };
  });
  root.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !dragging || dragging.pointerId === event.pointerId) return;
    const firstPointerId = dragging.pointerId;
    const firstPoint = { x: dragging.lastX, y: dragging.lastY };
    cancelDrag();
    pointers.clear();
    pointers.set(firstPointerId, firstPoint);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { board.setPointerCapture(firstPointerId); } catch {}
    try { board.setPointerCapture(event.pointerId); } catch {}
    board.classList.add('is-panning');
    const current = gestureFromPointers();
    if (current) gesture = { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) };
    event.preventDefault();
  }, { capture: true });
  board.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gestureFromPointers();
    if (current && gesture.distance > 0) {
      const rect = board.getBoundingClientRect();
      const world = gesture.world ?? screenToWorldFor(gesture.center.x, gesture.center.y, gesture.camera);
      const scale = clamp(gesture.camera.scale * current.distance / gesture.distance, MIN_SCALE, MAX_SCALE);
      const rotation = gesture.camera.rotation + current.angle - gesture.angle;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      camera.scale = scale;
      camera.rotation = rotation;
      camera.x = current.center.x - rect.left - rect.width / 2 - (world.x * cosine - world.y * sine) * scale;
      camera.y = current.center.y - rect.top - rect.height / 2 - (world.x * sine + world.y * cosine) * scale;
    } else if (gesture.rotate) {
      const point = pointers.values().next().value as Point;
      transformAt(camera.scale, gesture.camera.rotation + (point.x - gesture.center.x) * 0.01, gesture.center.x, gesture.center.y);
      return;
    } else {
      const point = pointers.values().next().value as Point;
      camera.x = gesture.camera.x + point.x - gesture.center.x;
      camera.y = gesture.camera.y + point.y - gesture.center.y;
    }
    applyCamera();
  });
  const endGesture = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!pointers.size) {
      gesture = null;
      board.classList.remove('is-panning');
      return;
    }
    const current = gestureFromPointers();
    const point = pointers.values().next().value as Point;
    gesture = current ? { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) } : {
      center: point, distance: 0, angle: 0, camera: { ...camera },
    };
  };
  window.addEventListener('pointerup', endGesture, { capture: true });
  window.addEventListener('pointercancel', endGesture, { capture: true });
  board.addEventListener('wheel', event => {
    event.preventDefault();
    if (event.altKey || event.shiftKey) {
      transformAt(camera.scale, camera.rotation - event.deltaY * 0.003, event.clientX, event.clientY);
    } else if (event.ctrlKey || event.metaKey) {
      transformAt(camera.scale * Math.exp(-event.deltaY * 0.01), camera.rotation, event.clientX, event.clientY);
    } else {
      camera.x -= event.deltaX;
      camera.y -= event.deltaY;
      applyCamera();
    }
  }, { passive: false });
  board.addEventListener('gesturestart', raw => {
    const event = raw as Event & { clientX?: number; clientY?: number };
    event.preventDefault();
    cancelDrag();
    resetPointerGesture();
    const rect = board.getBoundingClientRect();
    nativeGesture = {
      camera: { ...camera },
      x: event.clientX || rect.left + rect.width / 2,
      y: event.clientY || rect.top + rect.height / 2,
    };
  }, { passive: false });
  board.addEventListener('gesturechange', raw => {
    const event = raw as Event & { scale?: number; rotation?: number };
    if (!nativeGesture) return;
    event.preventDefault();
    transformAt(
      nativeGesture.camera.scale * (event.scale ?? 1),
      nativeGesture.camera.rotation + (event.rotation ?? 0) * Math.PI / 180,
      nativeGesture.x,
      nativeGesture.y,
    );
  }, { passive: false });
  const endNativeGesture = () => {
    nativeGesture = null;
    resetPointerGesture();
  };
  board.addEventListener('gestureend', endNativeGesture);
  board.addEventListener('gesturecancel', endNativeGesture);
  window.addEventListener('blur', resetAllGestures);
  window.addEventListener('pagehide', resetAllGestures);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') resetAllGestures();
  });
  rotateLeft.addEventListener('click', () => {
    rotateToPlayerView(-1);
  });
  rotateRight.addEventListener('click', () => {
    rotateToPlayerView(1);
  });
  resetView.addEventListener('click', () => {
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? -1;
    const area = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1);
    camera = { x: 0, y: 0, scale: camera.scale, rotation: -(area?.rotation ?? 0) };
    applyCamera();
  });

  dump.addEventListener('click', () => {
    if (selectedId) send({ t: 'dump', tileId: selectedId });
  });
  gameMenuOpen.addEventListener('click', () => gameMenu.showModal());
  gameMenuClose.addEventListener('click', () => gameMenu.close());
  newGame.addEventListener('click', () => {
    if (!state || myId !== state.hostId || state.players.length < 2) return;
    send({ t: 'new-game' });
    gameMenu.close();
  });
  async function leaveToHome(forgetLobby: boolean): Promise<void> {
    const leavingRoom = roomName;
    connectionMode = null;
    stopOnlineTransport();
    clearNearbyReconnectTimer();
    transportSend = null;
    if (isNativeNearby()) await NearbyConnections.stop().catch(() => undefined);
    if (forgetLobby && leavingRoom) {
      localStorage.removeItem(`tiles-session:${leavingRoom}`);
      writeSavedGames(readSavedGames().filter(record => record.room !== leavingRoom));
    }
    location.assign(import.meta.env.BASE_URL);
  }
  lobbyBack.addEventListener('click', () => { void leaveToHome(true); });
  goHome.addEventListener('click', () => { void leaveToHome(false); });
  retryConnection.addEventListener('click', async () => {
    retryConnection.disabled = true;
    if (connectionMode === 'online' && onlineName) {
      connectionMessage.textContent = 'Reconnecting…';
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connectOnline(onlineName);
      return;
    }
    if (connectionMode === 'nearby-join') {
      connectionMessage.textContent = 'Reconnecting to the nearby host…';
      nearbyAutoReconnect = true;
      nearbyConnectingId = null;
      clearNearbyReconnectTimer();
      await resumeNearbyTransport();
      retryConnection.disabled = false;
    }
  });
  window.addEventListener('resize', applyCamera);
  window.setInterval(() => {
    if (connectionMode === 'online') send({ t: 'ping' });
  }, 25_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'
      && (connectionMode === 'nearby-host' || (connectionMode === 'nearby-join' && !nearbyHostId))) {
      clearNearbyReconnectTimer();
      void resumeNearbyTransport();
    }
  });
  initializeUpdates();
  void initializeNearby();
  renderSavedGames();
  const savedName = sanitizeName(localStorage.getItem('tiles-name'));
  if (roomName && savedName && localStorage.getItem(sessionKey())) {
    enterLobby.disabled = true;
    connectOnline(savedName);
  }

  function initializeUpdates(): void {
    if (!('serviceWorker' in navigator)) return;
    let hadController = navigator.serviceWorker.controller != null;

    const showUpdate = (): void => {
      updateNotice.hidden = false;
    };
    const checkForUpdate = (): void => {
      navigator.serviceWorker.controller?.postMessage({ type: 'odl-check-page', url: location.href });
    };

    navigator.serviceWorker.addEventListener('message', event => {
      const message = event.data as { type?: unknown; url?: unknown } | null;
      if (message?.type !== 'odl-page-update-ready' || typeof message.url !== 'string') return;
      const updated = new URL(message.url, location.origin);
      if (updated.origin === location.origin && updated.pathname === location.pathname) showUpdate();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdate();
      hadController = true;
    });
    updateNow.addEventListener('click', () => {
      updateNow.disabled = true;
      updateNow.textContent = 'Updating…';
      location.reload();
    });

    void navigator.serviceWorker.register('/sw.js').then(registration => {
      void registration.update();
      window.setTimeout(checkForUpdate, 1_000);
      window.setInterval(() => {
        void registration.update();
        checkForUpdate();
      }, 60_000);
    }).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    window.addEventListener('focus', checkForUpdate);
  }
}

function ownerColor(index: number): string {
  return ['#ff664d', '#2478d4', '#1b8b58', '#9a55cc', '#e58b18', '#d14486', '#008b95', '#735c3b'][index % 8];
}

function areaFor(player: PlayerSummary | undefined, index: number, count: number): PlayerArea | undefined {
  if (!player || index < 0) return undefined;
  // Derive this locally so active rooms immediately pick up coordinate-system
  // fixes instead of retaining an older persisted seating angle.
  return createPlayerAreas(count)[index];
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
