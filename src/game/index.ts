import {
  PLAYER_AREA_HEIGHT,
  PLAYER_AREA_WIDTH,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  createPlayerAreas,
  isDictionaryId,
  sanitizeName,
  sanitizePlayerColor,
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
import { LocalRoomHost, type StoredLocalRoom } from './local-room';
import { NearbyConnections, isNativeNearby, type NearbyEndpoint, type NearbyPayload, type NearbyVerification } from './nearby';
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
interface TouchGesture { ids: [number, number]; center: Point; distance: number; angle: number; camera: Camera; world: Point }
interface FoundWord { text: string; tileIds: string[] }
interface EditSnapshot {
  positions: Array<{ id: string; x: number | null; y: number | null }>;
  rackOrder: Array<string | null>;
  selectedId: string | null;
  selectedIds: string[];
}
interface SavedGame {
  kind: 'online';
  room: string;
  name: string;
  phase: RoomSnapshot['phase'];
  playerNames: string[];
  updatedAt: number;
}
interface SavedLocalSession {
  version: 1;
  role: 'participant';
  name: string;
  hostName: string;
  playerNames: string[];
  phase: RoomSnapshot['phase'];
  updatedAt: number;
}
interface PendingChatMessage { text: string; attempts: number; timer: number | null }

const SAVED_GAMES_KEY = 'tiles-saved-games-v1';
const LOCAL_GAME_KEY = 'tiles-local-game-v1';
const LOCAL_SESSION_KEY = 'tiles-local-session-v1';
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
  const colorInputs = Array.from(root.querySelectorAll<HTMLInputElement>('[data-player-colors] input[type="radio"]'));
  const homeOptions = root.querySelector<HTMLElement>('[data-home-options]')!;
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
  const lobbyTitle = root.querySelector<HTMLElement>('[data-lobby-title]')!;
  const lobbyConnectionNotice = root.querySelector<HTMLElement>('[data-lobby-connection-notice]')!;
  const lobbyConnectionMessage = root.querySelector<HTMLElement>('[data-lobby-connection-message]')!;
  const lobbyRetryConnection = root.querySelector<HTMLButtonElement>('[data-lobby-retry-connection]')!;
  const chatLog = root.querySelector<HTMLElement>('[data-chat-log]')!;
  const chatForm = root.querySelector<HTMLFormElement>('[data-chat-form]')!;
  const chatInput = root.querySelector<HTMLInputElement>('[data-chat-input]')!;
  const chatSend = root.querySelector<HTMLButtonElement>('[data-chat-send]')!;
  const board = root.querySelector<HTMLElement>('[data-board]')!;
  const boardLayer = root.querySelector<HTMLElement>('[data-board-layer]')!;
  const playerScroll = root.querySelector<HTMLElement>('[data-player-scroll]')!;
  const rack = root.querySelector<HTMLElement>('[data-rack]')!;
  const rackWrap = root.querySelector<HTMLElement>('.rack-wrap')!;
  const dump = root.querySelector<HTMLButtonElement>('[data-dump]')!;
  const gameMenuOpen = root.querySelector<HTMLButtonElement>('[data-game-menu-open]')!;
  const gameMenu = root.querySelector<HTMLDialogElement>('[data-game-menu]')!;
  const gameMenuClose = root.querySelector<HTMLButtonElement>('[data-game-menu-close]')!;
  const newGame = root.querySelector<HTMLButtonElement>('[data-new-game]')!;
  const bugReport = root.querySelector<HTMLButtonElement>('[data-bug-report]')!;
  const goHome = root.querySelector<HTMLButtonElement>('[data-go-home]')!;
  const bunch = root.querySelector<HTMLElement>('[data-bunch]')!;
  const peel = root.querySelector<HTMLElement>('[data-peel]')!;
  const dumps = root.querySelector<HTMLElement>('[data-dumps]')!;
  const players = root.querySelector<HTMLElement>('[data-players]')!;
  const playerDisconnect = root.querySelector<HTMLElement>('[data-player-disconnect]')!;
  const fillDirection = root.querySelector<HTMLButtonElement>('[data-fill-direction]')!;
  const flipWordButton = root.querySelector<HTMLButtonElement>('[data-flip-word]')!;
  const randomiseButton = root.querySelector<HTMLButtonElement>('[data-randomise]')!;
  const peelAnimation = root.querySelector<HTMLElement>('[data-peel-animation]')!;
  const undoButton = root.querySelector<HTMLButtonElement>('[data-undo]')!;
  const redoButton = root.querySelector<HTMLButtonElement>('[data-redo]')!;
  const toast = root.querySelector<HTMLElement>('[data-toast]')!;
  const nearbyEntry = root.querySelector<HTMLElement>('[data-nearby-entry]')!;
  const nearbyStartButton = root.querySelector<HTMLButtonElement>('[data-nearby-start]')!;
  const nearbyStatus = root.querySelector<HTMLElement>('[data-nearby-status]')!;
  const nearbyEndpoints = root.querySelector<HTMLElement>('[data-nearby-endpoints]')!;
  const inviteDialog = root.querySelector<HTMLDialogElement>('[data-invite-dialog]')!;
  const inviteName = root.querySelector<HTMLElement>('[data-invite-name]')!;
  const inviteAccept = root.querySelector<HTMLButtonElement>('[data-invite-accept]')!;
  const inviteDecline = root.querySelector<HTMLButtonElement>('[data-invite-decline]')!;
  const updateNow = root.querySelector<HTMLButtonElement>('[data-update-now]')!;
  const connectionNotice = root.querySelector<HTMLElement>('[data-connection-notice]')!;
  const connectionMessage = root.querySelector<HTMLElement>('[data-connection-message]')!;
  const retryConnection = root.querySelector<HTMLButtonElement>('[data-retry-connection]')!;

  const params = new URLSearchParams(location.search);
  let roomName = sanitizeRoom(params.get('room'));
  const server = !Capacitor.isNativePlatform()
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'ws://localhost:8788'
    : PRODUCTION_SERVER.replace(/^http/, 'ws');
  roomLabels.forEach(label => { label.textContent = roomName; });
  if (roomName) {
    enterLobby.textContent = 'Join online game';
    roomNote.textContent = `Private room ${roomName} · 2–8 players`;
  }
  nameInput.value = localStorage.getItem('tiles-name') ?? '';
  updateHomeReadiness();
  if (!Capacitor.isNativePlatform()) nameInput.focus();

  let socket: WebSocket | null = null;
  let onlineConnectTimer: number | null = null;
  let onlineName = '';
  let onlineReconnectEnabled = false;
  let connectionMode: 'online' | 'nearby-home' | 'nearby-host' | 'nearby-join' | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let localHost: LocalRoomHost | null = null;
  let nearbyHostId: string | null = null;
  let nearbyHostName = '';
  let nearbyAutoReconnect = false;
  let nearbyConnectingId: string | null = null;
  let nearbyReconnectAttempt = 0;
  let nearbyReconnectTimer: number | null = null;
  let nearbyConnectionAttemptTimer: number | null = null;
  let nearbyHelloTimer: number | null = null;
  let nearbyAwaitingWelcome = false;
  let nearbyHomeRefreshTimer: number | null = null;
  let nearbyHomeGeneration = 0;
  let nearbyName = '';
  let nearbyPermissionAliases: string[] | undefined;
  const selectedNearbyIds = new Set<string>();
  const outgoingNearbyInvites = new Set<string>();
  const approvedNearbyNames = new Set<string>();
  const pendingReinviteNames = new Set<string>();
  const nearbyInviteStates = new Map<string, { name: string; status: 'requested' | 'received' | 'accepted' }>();
  type NearbyPeerPhase = 'searching' | 'found' | 'requesting' | 'requested' | 'authenticating' | 'transport' | 'syncing' | 'synced' | 'disconnected' | 'failed';
  const nearbyPeerStates = new Map<string, { phase: NearbyPeerPhase; detail: string }>();
  type NearbyWirePacket =
    | { w: 1; t: 'data'; sequence: number; payload: ClientMessage | ServerMessage }
    | { w: 1; t: 'ack'; sequence: number };
  interface PendingNearbyPacket {
    endpointId: string;
    endpointName: string;
    sequence: number;
    encoded: string;
    attempts: number;
    timer: number | null;
  }
  const nearbySendSequences = new Map<string, number>();
  const nearbyReceiveSequences = new Map<string, number>();
  const nearbyReceiveBuffers = new Map<string, Map<number, ClientMessage | ServerMessage>>();
  const pendingNearbyPackets = new Map<string, PendingNearbyPacket>();
  let nearbyHomeStarting = false;
  let nearbyHomeRestart: Promise<void> | null = null;
  let nameChangeTimer: number | null = null;
  let nearbyHomePhase: 'idle' | 'permission' | 'permission-required' | 'starting' | 'visible' | 'searching' | 'failed' = 'idle';
  let nearbySuspended = false;
  let pendingNearbyInvite: NearbyVerification | null = null;
  let transportSend: ((message: object) => void) | null = null;
  let myId = '';
  let state: RoomSnapshot | null = null;
  const playerHeartbeats = new Map<string, {
    status: 'checking' | 'available' | 'unavailable';
    latencyMs?: number;
    at: number;
  }>();
  const heartbeatSamples = new Map<string, number[]>();
  let cameraAnimationTimer: number | null = null;
  let tiles: LocalTile[] = [];
  let rackOrder: Array<string | null> = [];
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
  let touchGesture: TouchGesture | null = null;
  let lastCanvasTap: { x: number; y: number; at: number } | null = null;
  let canvasPress: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  let marquee: { pointerId: number; start: Point; current: Point; element: HTMLElement } | null = null;
  let autoFillDirection: 'right' | 'down' = 'right';
  let viewingPlayerId: string | null = null;
  const undoStack: EditSnapshot[] = [];
  const redoStack: EditSnapshot[] = [];
  const unreadChatMessages = new Map<string, string>();
  const pendingChatMessages = new Map<string, PendingChatMessage>();
  let toastTimer: number | null = null;
  const diagnostics: Array<{ at: string; event: string; detail?: unknown }> = [];

  function diagnose(event: string, detail?: unknown): void {
    diagnostics.push({ at: new Date().toISOString(), event, detail });
    if (diagnostics.length > 300) diagnostics.shift();
  }

  async function saveBugReport(): Promise<void> {
    setButtonLoading(bugReport, true, 'Preparing report…');
    const report = {
      generatedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      platform: Capacitor.getPlatform(),
      userAgent: navigator.userAgent,
      connectionMode,
      nearbyHostName,
      nearbyPeerStates: [...nearbyPeerStates.entries()],
      pendingPackets: [...pendingNearbyPackets.values()].map(packet => ({
        endpointName: packet.endpointName, sequence: packet.sequence, attempts: packet.attempts,
      })),
      room: state,
      localTiles: tiles,
      diagnostics,
    };
    const file = new File([JSON.stringify(report, null, 2)], `tiles-bug-report-${Date.now()}.json`, { type: 'application/json' });
    try {
      const shareData = { title: 'Tiles bug report', files: [file] };
      if (navigator.share && navigator.canShare?.(shareData)) await navigator.share(shareData);
      else {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
      }
      show('Bug report saved.', 'good');
      gameMenu.close();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) show('Could not save the bug report.', 'bad');
    } finally {
      setButtonLoading(bugReport, false);
    }
  }

  window.addEventListener('error', event => diagnose('window-error', { message: event.message, file: event.filename, line: event.lineno }));
  window.addEventListener('unhandledrejection', event => diagnose('unhandled-rejection', String(event.reason)));

  function readSavedGames(): SavedGame[] {
    try {
      const value = JSON.parse(localStorage.getItem(SAVED_GAMES_KEY) ?? '[]') as unknown;
      if (!Array.isArray(value)) return [];
      const records = value.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object') return [];
        const record = candidate as Partial<SavedGame>;
        const savedRoom = sanitizeRoom(record.room);
        if (!savedRoom || savedRoom === 'nearby' || typeof record.name !== 'string' || !['lobby', 'playing', 'review', 'finished'].includes(record.phase ?? '')) return [];
        return [{
          kind: 'online' as const,
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
          records.push({ kind: 'online', room: savedRoom, name: fallbackName, phase: 'playing', playerNames: [], updatedAt: 0 });
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

  function readLocalGame(): StoredLocalRoom | null {
    try {
      const value = JSON.parse(localStorage.getItem(LOCAL_GAME_KEY) ?? 'null') as Partial<StoredLocalRoom> | null;
      if (!value || value.version !== 1 || !Array.isArray(value.players) || typeof value.updatedAt !== 'number') return null;
      if (!['lobby', 'playing', 'review', 'finished'].includes(value.phase ?? '') || !isDictionaryId(value.dictionary)) return null;
      return value as StoredLocalRoom;
    } catch {
      return null;
    }
  }

  function saveLocalGame(value: StoredLocalRoom): void {
    localStorage.setItem(LOCAL_GAME_KEY, JSON.stringify(value));
  }

  function readLocalSession(): SavedLocalSession | null {
    try {
      const value = JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) ?? 'null') as Partial<SavedLocalSession> | null;
      if (!value || value.version !== 1 || value.role !== 'participant') return null;
      const name = sanitizeName(value.name);
      const hostName = sanitizeName(value.hostName);
      if (!name || !hostName || !['lobby', 'playing', 'review', 'finished'].includes(value.phase ?? '')) return null;
      return {
        version: 1, role: 'participant', name, hostName,
        playerNames: Array.isArray(value.playerNames) ? value.playerNames.map(sanitizeName).filter(Boolean).slice(0, 8) : [],
        phase: value.phase as RoomSnapshot['phase'], updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  function rememberGame(room: RoomSnapshot): void {
    if (connectionMode === 'nearby-join') {
      const me = room.players.find(player => player.id === myId);
      const host = room.players.find(player => player.id === room.hostId);
      if (me && host && localStorage.getItem('tiles-session:nearby')) {
        const session: SavedLocalSession = {
          version: 1, role: 'participant', name: me.name, hostName: host.name,
          playerNames: room.players.map(player => player.name), phase: room.phase, updatedAt: Date.now(),
        };
        localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
      }
      return;
    }
    if (connectionMode !== 'online' || !roomName) return;
    const records = readSavedGames().filter(record => record.room !== roomName);
    const me = room.players.find(player => player.id === myId);
    const name = sanitizeName(me?.name ?? onlineName);
    if (name && localStorage.getItem(sessionKey())) records.unshift({
      kind: 'online',
      room: roomName,
      name,
      phase: room.phase,
      playerNames: room.players.map(player => player.name),
      updatedAt: Date.now(),
    });
    writeSavedGames(records);
  }

  function renderSavedGames(): void {
    const local = roomName ? null : readLocalGame();
    const localSession = roomName ? null : readLocalSession();
    const records = roomName ? [] : readSavedGames();
    savedGameList.replaceChildren();
    savedGames.hidden = !local && !localSession && records.length === 0;
    if (local) {
      const item = document.createElement('div');
      item.className = 'saved-game';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'saved-game-open';
      open.dataset.savedKind = 'local';
      open.dataset.savedRole = 'host';
      const ownToken = localStorage.getItem('tiles-session:nearby');
      const me = local.players.find(player => player.resumeToken === ownToken);
      open.dataset.savedName = me?.name ?? local.players.find(player => player.id === local.hostId)?.name ?? '';
      const title = document.createElement('strong');
      title.textContent = `Local · ${local.players.map(player => player.name).join(', ')}`;
      const detail = document.createElement('span');
      detail.textContent = `On this device · ${local.phase === 'finished' ? 'Finished' : local.phase === 'playing' ? 'In progress' : 'In lobby'} · ${new Date(local.updatedAt).toLocaleString()}`;
      open.append(title, detail);
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'saved-game-forget';
      forget.dataset.forgetLocal = 'true';
      forget.setAttribute('aria-label', 'Forget local game');
      forget.textContent = '×';
      item.append(open, forget);
      savedGameList.append(item);
    }
    if (localSession) {
      const item = document.createElement('div');
      item.className = 'saved-game';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'saved-game-open';
      open.dataset.savedKind = 'local';
      open.dataset.savedRole = 'participant';
      open.dataset.savedName = localSession.name;
      const title = document.createElement('strong');
      title.textContent = `Local · ${localSession.playerNames.join(', ')}`;
      const detail = document.createElement('span');
      detail.textContent = `Rejoin ${localSession.hostName} · ${localSession.phase === 'finished' ? 'Finished' : localSession.phase === 'playing' ? 'In progress' : 'In lobby'} · ${new Date(localSession.updatedAt).toLocaleString()}`;
      open.append(title, detail);
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'saved-game-forget';
      forget.dataset.forgetLocal = 'true';
      forget.setAttribute('aria-label', 'Forget local game');
      forget.textContent = '×';
      item.append(open, forget);
      savedGameList.append(item);
    }
    for (const record of records) {
      const item = document.createElement('div');
      item.className = 'saved-game';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'saved-game-open';
      open.dataset.savedKind = 'online';
      open.dataset.savedRoom = record.room;
      open.dataset.savedName = record.name;
      const title = document.createElement('strong');
      title.textContent = record.playerNames.length ? record.playerNames.join(', ') : `Room ${record.room}`;
      const detail = document.createElement('span');
      detail.textContent = `Online · ${record.phase === 'finished' ? 'Winner called · finish your grid' : record.phase === 'review' ? 'Finishing' : record.phase === 'playing' ? 'In progress' : 'In lobby'} · ${new Date(record.updatedAt).toLocaleString()}`;
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

  const buttonLabels = new WeakMap<HTMLButtonElement, string>();
  function setButtonLoading(button: HTMLButtonElement, loading: boolean, label?: string): void {
    if (loading) {
      if (!buttonLabels.has(button)) buttonLabels.set(button, button.innerHTML);
      if (label) button.textContent = label;
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      return;
    }
    const original = buttonLabels.get(button);
    if (original != null) button.innerHTML = original;
    buttonLabels.delete(button);
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }

  function send(message: object): void {
    if (transportSend) transportSend(message);
    else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function selectedPlayerColor(): string {
    return sanitizePlayerColor(colorInputs.find(input => input.checked)?.value);
  }

  function selectPlayerColor(color: string): void {
    const selected = sanitizePlayerColor(color);
    colorInputs.forEach(input => { input.checked = input.value === selected; });
  }

  const storedNearbyDeviceId = localStorage.getItem('tiles-nearby-device-id');
  const nearbyDeviceId = storedNearbyDeviceId && /^[a-f0-9]{8}$/.test(storedNearbyDeviceId)
    ? storedNearbyDeviceId
    : crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  localStorage.setItem('tiles-nearby-device-id', nearbyDeviceId);

  const nearbyWireName = (name = nearbyName): string =>
    `tiles6|${selectedPlayerColor().slice(1)}|${nearbyDeviceId}|${sanitizeName(name)}`;

  function decodeNearbyEndpoint<T extends NearbyEndpoint>(endpoint: T): T {
    const match = /^tiles6\|([0-9a-f]{6})\|([0-9a-f]{8})\|(.+)$/i.exec(endpoint.name);
    if (!match) return endpoint;
    return {
      ...endpoint,
      name: sanitizeName(match[3]),
      color: sanitizePlayerColor(`#${match[1].toLowerCase()}`),
      deviceId: match[2].toLowerCase(),
    };
  }

  function colorForPlayer(player: PlayerSummary | undefined, index = 0): string {
    return sanitizePlayerColor(player?.color ?? PLAYER_COLORS[index % PLAYER_COLORS.length]);
  }

  function chatIsReadable(): boolean {
    return document.visibilityState === 'visible' && state?.phase === 'lobby' && !lobby.hidden;
  }

  function updateChatReceipt(messageId: string, status: 'sent' | 'received' | 'read' | 'not-delivered'): void {
    const receipt = Array.from(chatLog.querySelectorAll<HTMLElement>('[data-chat-receipt]'))
      .find(candidate => candidate.dataset.chatReceipt === messageId);
    if (!receipt) return;
    const rank = { 'not-delivered': -1, sent: 0, received: 1, read: 2 } as const;
    const current = receipt.dataset.status as keyof typeof rank | undefined;
    if (status === 'not-delivered' && current !== 'sent' && current !== 'not-delivered') return;
    if (status !== 'not-delivered' && current && rank[current] >= rank[status]) return;
    receipt.dataset.status = status;
    receipt.textContent = status === 'sent' ? '✓' : status === 'not-delivered' ? '!' : '✓✓';
    const label = status === 'not-delivered' ? 'Not delivered' : status === 'sent' ? 'Sent' : status === 'received' ? 'Delivered' : 'Read';
    receipt.setAttribute('aria-label', label);
    receipt.title = label;
  }

  function transmitPendingChat(messageId: string): void {
    const pending = pendingChatMessages.get(messageId);
    if (!pending || state?.phase !== 'lobby') return;
    send({ t: 'chat', id: messageId, text: pending.text });
    pending.attempts++;
    if (pending.timer != null) window.clearTimeout(pending.timer);
    const hasRecipient = state.players.some(player => player.id !== myId && player.connected !== false);
    if (!hasRecipient) {
      pending.timer = null;
      return;
    }
    const delay = Math.min(4_000, 1_200 * 2 ** Math.max(0, pending.attempts - 1));
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      if (!pendingChatMessages.has(messageId)) return;
      if (pending.attempts < 4) transmitPendingChat(messageId);
      else updateChatReceipt(messageId, 'not-delivered');
    }, delay);
  }

  function settlePendingChat(messageId: string): void {
    const pending = pendingChatMessages.get(messageId);
    if (pending?.timer != null) window.clearTimeout(pending.timer);
    pendingChatMessages.delete(messageId);
  }

  function emitChatReceipt(
    messageId: string,
    senderId: string,
    status: 'received' | 'read',
    retryDelays: number[],
  ): void {
    const receipt = { t: 'chat-receipt', messageId, senderId, status } as const;
    send(receipt);
    for (const delay of retryDelays) {
      window.setTimeout(() => {
        if (state?.phase === 'lobby') send(receipt);
      }, delay);
    }
  }

  function resumePendingChats(): void {
    for (const [messageId, pending] of pendingChatMessages) {
      if (pending.timer != null) continue;
      pending.attempts = 0;
      updateChatReceipt(messageId, 'sent');
      transmitPendingChat(messageId);
    }
  }

  function acknowledgeIncomingChat(messageId: string, senderId: string): void {
    unreadChatMessages.set(messageId, senderId);
    emitChatReceipt(messageId, senderId, 'received', [500]);
    window.setTimeout(() => sendChatRead(messageId, senderId), 250);
  }

  function sendChatRead(messageId: string, senderId: string): void {
    if (!chatIsReadable() || !unreadChatMessages.has(messageId)) return;
    unreadChatMessages.delete(messageId);
    emitChatReceipt(messageId, senderId, 'read', [700, 1_800]);
  }

  function flushChatReadReceipts(): void {
    if (!chatIsReadable()) return;
    for (const [messageId, senderId] of unreadChatMessages) sendChatRead(messageId, senderId);
  }

  function connectionRestored(): void {
    diagnose('connection-restored', { connectionMode });
    root.dataset.connection = 'online';
    connectionNotice.hidden = true;
    lobbyConnectionNotice.hidden = true;
    setButtonLoading(retryConnection, false);
    setButtonLoading(lobbyRetryConnection, false);
    resumePendingChats();
  }

  function connectionLost(message: string): void {
    if (!connectionMode || (!state && !nameGate.hidden)) {
      connectionRestored();
      return;
    }
    root.dataset.connection = 'offline';
    diagnose('connection-lost', { connectionMode, message });
    connectionMessage.textContent = message;
    lobbyConnectionMessage.textContent = message;
    const inLobby = !lobby.hidden;
    connectionNotice.hidden = inLobby;
    lobbyConnectionNotice.hidden = !inLobby;
    setButtonLoading(retryConnection, false);
    setButtonLoading(lobbyRetryConnection, false);
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

  function resetGameState(): void {
    setButtonLoading(newGame, false);
    cancelDrag();
    clearEditHistory();
    tiles = [];
    rackOrder = [];
    selectedId = null;
    selectedIds.clear();
    peelSent = -1;
  }

  function applyHand(nextTiles: Tile[], replace: boolean): void {
    setButtonLoading(dump, false);
    if (replace) {
      clearEditHistory();
      const previous = new Map(tiles.map(tile => [tile.id, tile]));
      const restored = new Map((state?.players.find(player => player.id === myId)?.board ?? []).map(tile => [tile.id, tile]));
      tiles = nextTiles.map(tile => {
        const placed = previous.get(tile.id) ?? restored.get(tile.id);
        return { ...tile, x: placed?.x ?? null, y: placed?.y ?? null };
      });
      syncRackOrder(tiles.map(tile => tile.id));
    } else {
      const additions = nextTiles.map(tile => ({ ...tile, x: null, y: null }));
      tiles.push(...additions);
      addRackTiles(additions.map(tile => tile.id));
    }
    const me = state?.players.find(player => player.id === myId);
    if (me) {
      me.tiles = tiles.map(({ id, letter }) => ({ id, letter }));
      me.tilesLeft = tiles.filter(tile => tile.x == null || tile.y == null).length;
      updateLooseCountChip(me.id, me.tilesLeft);
    }
    if (!dragging) {
      selectedId = null;
      selectedIds.clear();
      renderTiles();
    }
  }

  function handleServerMessage(message: ServerMessage): void {
    if (message.t === 'heartbeat') {
      send({ t: 'heartbeat-ack', id: message.id, sentAt: message.sentAt });
      return;
    }
    if (message.t === 'heartbeat-status') {
      for (const heartbeat of message.players) {
        playerHeartbeats.set(heartbeat.playerId, {
          status: heartbeat.status, latencyMs: heartbeat.latencyMs, at: heartbeat.at,
        });
        if (heartbeat.status === 'available' || heartbeat.status === 'unavailable') {
          const samples = heartbeatSamples.get(heartbeat.playerId) ?? [];
          samples.push(heartbeat.status === 'available' ? (heartbeat.latencyMs ?? 0) : -1);
          heartbeatSamples.set(heartbeat.playerId, samples.slice(-12));
        }
        if (state?.phase !== 'lobby' && state) {
          pulsePlayerHeartbeat(heartbeat.playerId, heartbeat.status === 'unavailable');
        }
      }
      if (state?.phase === 'lobby') renderLobbyRoster(state);
      return;
    }
    if (message.t === 'welcome') {
      nearbyAwaitingWelcome = false;
      clearNearbyHelloTimer();
      myId = message.id;
      viewingPlayerId ??= myId;
      if (message.resumeToken) localStorage.setItem(sessionKey(), message.resumeToken);
      if (connectionMode === 'nearby-join' && nearbyHostName) {
        setNearbyPeerState(nearbyHostName, 'synced', 'App handshake complete · lobby synced');
        if (nearbyHostId) updateNearbyChannelProgress(nearbyHostId);
      }
      connectionRestored();
      reconnectAttempt = 0;
      updateRoom(message.room);
    } else if (message.t === 'room') {
      if (message.reset) resetGameState();
      updateRoom(message.room);
      if (message.hand) applyHand(message.hand.tiles, message.hand.replace);
      if (message.toast) show(message.toast.text, message.toast.tone);
    }
    else if (message.t === 'chat') {
      const messageId = message.id || crypto.randomUUID();
      const duplicate = Array.from(chatLog.querySelectorAll<HTMLElement>('[data-message-id]'))
        .some(candidate => candidate.dataset.messageId === messageId);
      if (duplicate) {
        if (message.playerId !== myId) acknowledgeIncomingChat(messageId, message.playerId);
        return;
      }
      const empty = chatLog.querySelector('[data-chat-empty]');
      empty?.remove();
      const row = document.createElement('div');
      row.className = `chat-message${message.playerId === myId ? ' is-you' : ''}`;
      row.dataset.messageId = messageId;
      row.dataset.chatPlayer = message.playerId;
      const author = document.createElement('strong');
      author.textContent = message.playerId === myId ? 'You' : message.name;
      const chatPlayer = state?.players.find(player => player.id === message.playerId);
      author.style.color = colorForPlayer(chatPlayer, Math.max(0, state?.players.findIndex(player => player.id === message.playerId) ?? 0));
      const text = document.createElement('span');
      text.textContent = message.text;
      const time = document.createElement('time');
      time.dateTime = new Date(message.at).toISOString();
      time.textContent = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.append(author, text, time);
      if (message.playerId === myId) {
        const receipt = document.createElement('small');
        receipt.className = 'chat-receipt';
        receipt.dataset.chatReceipt = messageId;
        receipt.dataset.status = 'sent';
        receipt.textContent = '✓';
        receipt.setAttribute('aria-label', 'Sent');
        receipt.title = 'Sent';
        time.append(receipt);
      }
      chatLog.append(row);
      while (chatLog.children.length > 60) chatLog.firstElementChild?.remove();
      chatLog.scrollTop = chatLog.scrollHeight;
      if (message.playerId === myId) {
        setButtonLoading(chatSend, false);
        if (!state?.players.some(player => player.id !== myId && player.connected !== false)) settlePendingChat(messageId);
      }
      else acknowledgeIncomingChat(messageId, message.playerId);
    }
    else if (message.t === 'chat-receipt') {
      settlePendingChat(message.messageId);
      updateChatReceipt(message.messageId, message.status);
    }
    else if (message.t === 'new-game') {
      resetGameState();
      renderTiles();
    } else if (message.t === 'layout') {
      const player = state?.players.find(value => value.id === message.playerId);
      if (!player) return;
      player.board = message.board;
      const placed = new Set(message.board.map(tile => tile.id));
      player.tilesLeft = player.tiles.reduce((count, tile) => count + (placed.has(tile.id) ? 0 : 1), 0);
      updateLooseCountChip(player.id, player.tilesLeft);
      if (message.playerId === myId) {
        syncOwnBoard(state!);
        clearEditHistory();
      }
      if (!dragging && !gesture && !nativeGesture && !touchGesture) renderTiles();
    } else if (message.t === 'hand') {
      applyHand(message.tiles, message.replace);
    } else if (message.t === 'peel-result') {
      diagnose('peel-result', message);
      if (!message.accepted) {
        peelSent = -1;
        if (message.reason) show(message.reason, 'bad');
      }
    } else if (message.t === 'toast') show(message.text, message.tone);
    else if (message.t === 'error') {
      show(message.message, 'bad');
      if (!myId) setButtonLoading(enterLobby, false);
      setButtonLoading(start, false);
      setButtonLoading(newGame, false);
      setButtonLoading(nearbyStartButton, false);
      setButtonLoading(chatSend, false);
      peelSent = -1;
    }
  }

  async function connectOnline(name: string): Promise<void> {
    const wasNearby = connectionMode?.startsWith('nearby') ?? false;
    stopOnlineTransport();
    onlineName = name;
    connectionMode = 'online';
    onlineReconnectEnabled = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    transportSend = null;
    onlineInvite.hidden = false;
    void renderInviteCode();
    lobbyHelp.textContent = 'Share the private link to invite up to seven other players. The host chooses the dictionary for everyone.';
    if (wasNearby && isNativeNearby()) {
      // Nearby may own a Wi-Fi Aware data path. Let it release that network
      // before WebView resolves and opens the Cloudflare WebSocket.
      await NearbyConnections.stop().catch(() => undefined);
      await wait(350);
      if (connectionMode !== 'online' || !onlineReconnectEnabled || onlineName !== name) return;
    }
    const connection = new WebSocket(`${server}/rooms/${encodeURIComponent(roomName)}`);
    socket = connection;
    if (onlineConnectTimer != null) window.clearTimeout(onlineConnectTimer);
    onlineConnectTimer = window.setTimeout(() => {
      if (socket !== connection || connection.readyState !== WebSocket.CONNECTING) return;
      show('Online connection timed out. Retrying…', 'bad');
      roomNote.textContent = 'Online service unavailable · retrying…';
      connection.close();
    }, 12_000);
    connection.addEventListener('open', () => {
      if (onlineConnectTimer != null) window.clearTimeout(onlineConnectTimer);
      onlineConnectTimer = null;
      roomNote.textContent = `Private room ${roomName} · 2–8 players`;
      const resumeToken = localStorage.getItem(sessionKey()) ?? undefined;
      connection.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, color: selectedPlayerColor(), resumeToken } satisfies ClientMessage));
    });
    connection.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
      handleServerMessage(message);
    });
    connection.addEventListener('close', () => {
      if (onlineConnectTimer != null) window.clearTimeout(onlineConnectTimer);
      onlineConnectTimer = null;
      if (socket !== connection || !onlineReconnectEnabled) return;
      if (!state) {
        show('Could not reach the online game. Retrying…', 'bad');
        roomNote.textContent = 'Online service unavailable · retrying…';
      }
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
    if (onlineConnectTimer != null) window.clearTimeout(onlineConnectTimer);
    onlineConnectTimer = null;
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
  const nearbyEndpointLossTimers = new Map<string, number>();
  const localPeerId = `local-${crypto.randomUUID().slice(0, 8)}`;

  function clearNearbyReconnectTimer(): void {
    if (nearbyReconnectTimer != null) window.clearTimeout(nearbyReconnectTimer);
    nearbyReconnectTimer = null;
  }

  function clearNearbyConnectionAttemptTimer(): void {
    if (nearbyConnectionAttemptTimer != null) window.clearTimeout(nearbyConnectionAttemptTimer);
    nearbyConnectionAttemptTimer = null;
  }

  function clearNearbyHelloTimer(): void {
    if (nearbyHelloTimer != null) window.clearTimeout(nearbyHelloTimer);
    nearbyHelloTimer = null;
  }

  function clearNearbyHomeRefreshTimer(invalidate = true): void {
    if (nearbyHomeRefreshTimer != null) window.clearTimeout(nearbyHomeRefreshTimer);
    nearbyHomeRefreshTimer = null;
    if (invalidate) nearbyHomeGeneration += 1;
  }

  const wait = (milliseconds: number): Promise<void> => new Promise(resolve => {
    window.setTimeout(resolve, milliseconds);
  });

  function scheduleNearbyHomeRefresh(): void {
    if (nearbyHomeRefreshTimer != null || connectionMode !== 'nearby-home' || nearbyEndpointMap.size) return;
    const generation = nearbyHomeGeneration;
    nearbyHomeRefreshTimer = window.setTimeout(() => {
      nearbyHomeRefreshTimer = null;
      if (generation !== nearbyHomeGeneration || connectionMode !== 'nearby-home' || nearbyEndpointMap.size) return;
      void runNearbyHomeRadios(nearbyName, true, generation);
    }, 12_000);
  }

  async function runNearbyHomeRadios(name: string, refresh: boolean, generation: number): Promise<void> {
    const isCurrent = (): boolean => generation === nearbyHomeGeneration && connectionMode === 'nearby-home';
    if (!isCurrent()) return;
    if (refresh) {
      // Keep the advertised endpoint stable. Restarting advertising can leave
      // another phone holding an endpoint ID whose GATT server no longer exists.
      await NearbyConnections.stopDiscovery().catch(() => undefined);
      if (!isCurrent()) return;
      nearbyHomePhase = 'starting';
      nearbyStatus.textContent = 'Restarting nearby discovery…';
      renderNearbyEndpoints();
      await wait(350);
      if (!isCurrent()) return;
      await NearbyConnections.startDiscovery({ name: nearbyWireName(name) });
      nearbyHomePhase = 'searching';
      nearbyStatus.textContent = '';
      renderNearbyEndpoints();
      if (isCurrent()) scheduleNearbyHomeRefresh();
      return;
    }

    // Give each device an independent initial role so two nearby phones do not
    // repeatedly compete as GATT clients and servers in lockstep. Every device
    // follows the same protocol, regardless of its platform, and a refresh
    // chooses again if the first pairing did not produce an endpoint.
    const advertiseFirst = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
    if (advertiseFirst) {
      await NearbyConnections.startAdvertising({ name: nearbyWireName(name) });
      nearbyHomePhase = 'visible';
      nearbyStatus.textContent = 'Visible to nearby players · preparing search…';
    } else {
      await NearbyConnections.startDiscovery({ name: nearbyWireName(name) });
      nearbyHomePhase = 'searching';
      nearbyStatus.textContent = '';
    }
    renderNearbyEndpoints();
    if (!isCurrent()) return;
    await wait(5_500);
    if (!isCurrent()) return;
    if (advertiseFirst) {
      await NearbyConnections.startDiscovery({ name: nearbyWireName(name) });
      nearbyHomePhase = 'searching';
      nearbyStatus.textContent = '';
    } else await NearbyConnections.startAdvertising({ name: nearbyWireName(name) });
    renderNearbyEndpoints();
    if (isCurrent()) scheduleNearbyHomeRefresh();
  }

  function nearbyPacketKey(endpointId: string, sequence: number): string {
    return `${endpointId}:${sequence}`;
  }

  function nearbyEndpointName(endpointId: string): string {
    const name = nearbyEndpointMap.get(endpointId)?.name
      ?? state?.players.find(player => player.id === endpointId)?.name
      ?? (nearbyHostId === endpointId ? nearbyHostName : '');
    return name || 'Nearby player';
  }

  function sendNearbyRaw(endpointId: string, encoded: string): Promise<void> {
    return NearbyConnections.send({ endpointIds: [endpointId], payload: encoded });
  }

  function clearNearbyChannel(endpointId: string): void {
    for (const [key, pending] of pendingNearbyPackets) {
      if (pending.endpointId !== endpointId) continue;
      if (pending.timer != null) window.clearTimeout(pending.timer);
      pendingNearbyPackets.delete(key);
    }
    nearbySendSequences.delete(endpointId);
    nearbyReceiveSequences.delete(endpointId);
    nearbyReceiveBuffers.delete(endpointId);
  }

  function clearAllNearbyChannels(): void {
    for (const pending of pendingNearbyPackets.values()) {
      if (pending.timer != null) window.clearTimeout(pending.timer);
    }
    pendingNearbyPackets.clear();
    nearbySendSequences.clear();
    nearbyReceiveSequences.clear();
    nearbyReceiveBuffers.clear();
  }

  function updateNearbyChannelProgress(endpointId: string): void {
    const endpointName = nearbyEndpointName(endpointId);
    const current = nearbyPeerStates.get(nearbyPeerKey(endpointName));
    if (current?.phase !== 'synced') return;
    const pending = [...pendingNearbyPackets.values()].filter(packet => packet.endpointId === endpointId).length;
    setNearbyPeerState(
      endpointName,
      'synced',
      pending
        ? `Reliable channel · ${pending} ${pending === 1 ? 'packet' : 'packets'} awaiting acknowledgement`
        : 'Reliable channel synced · all packets acknowledged',
    );
  }

  function failNearbyPacket(pending: PendingNearbyPacket): void {
    const key = nearbyPacketKey(pending.endpointId, pending.sequence);
    if (!pendingNearbyPackets.has(key)) return;
    clearNearbyChannel(pending.endpointId);
    setNearbyPeerState(pending.endpointName, 'failed', `Transport stalled · packet ${pending.sequence} was not acknowledged`);
    void NearbyConnections.disconnect({ endpointId: pending.endpointId });
    if (connectionMode === 'nearby-join' && nearbyHostId === pending.endpointId) beginNearbyReconnect();
  }

  function transmitNearbyPacket(pending: PendingNearbyPacket): void {
    const key = nearbyPacketKey(pending.endpointId, pending.sequence);
    if (!pendingNearbyPackets.has(key)) return;
    if (pending.timer != null) window.clearTimeout(pending.timer);
    pending.attempts += 1;
    void sendNearbyRaw(pending.endpointId, pending.encoded).catch(() => undefined);
    if (pending.attempts >= 6) {
      pending.timer = window.setTimeout(() => failNearbyPacket(pending), 4_000);
      return;
    }
    const retryAfter = Math.min(4_000, 500 * 2 ** (pending.attempts - 1));
    pending.timer = window.setTimeout(() => transmitNearbyPacket(pending), retryAfter);
  }

  function sendNearby(endpointId: string, message: object): void {
    const sequence = (nearbySendSequences.get(endpointId) ?? 0) + 1;
    nearbySendSequences.set(endpointId, sequence);
    const packet: NearbyWirePacket = {
      w: 1,
      t: 'data',
      sequence,
      payload: message as ClientMessage | ServerMessage,
    };
    const pending: PendingNearbyPacket = {
      endpointId,
      endpointName: nearbyEndpointName(endpointId),
      sequence,
      encoded: JSON.stringify(packet),
      attempts: 0,
      timer: null,
    };
    pendingNearbyPackets.set(nearbyPacketKey(endpointId, sequence), pending);
    updateNearbyChannelProgress(endpointId);
    transmitNearbyPacket(pending);
  }

  function acknowledgeNearbyPacket(endpointId: string, sequence: number): void {
    const packet: NearbyWirePacket = { w: 1, t: 'ack', sequence };
    void sendNearbyRaw(endpointId, JSON.stringify(packet)).catch(() => undefined);
  }

  function deliverNearbyMessage(endpointId: string, endpointName: string, message: ClientMessage | ServerMessage): void {
    if (localHost) {
      if (message.t === 'hello') setNearbyPeerState(endpointName, 'synced', 'App handshake received · reliable channel synced');
      localHost.receive(endpointId, message as ClientMessage);
    } else handleServerMessage(message as ServerMessage);
  }

  function receiveNearbyPacket(event: NearbyPayload): void {
    let packet: NearbyWirePacket;
    try { packet = JSON.parse(event.payload) as NearbyWirePacket; } catch { return; }
    if (packet?.w !== 1 || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1) return;
    if (packet.t === 'ack') {
      const key = nearbyPacketKey(event.endpointId, packet.sequence);
      const pending = pendingNearbyPackets.get(key);
      if (!pending) return;
      if (pending.timer != null) window.clearTimeout(pending.timer);
      pendingNearbyPackets.delete(key);
      updateNearbyChannelProgress(event.endpointId);
      return;
    }
    if (packet.t !== 'data' || !packet.payload || typeof packet.payload !== 'object') return;

    acknowledgeNearbyPacket(event.endpointId, packet.sequence);
    const expected = nearbyReceiveSequences.get(event.endpointId) ?? 1;
    if (packet.sequence < expected) return;
    if (packet.sequence > expected) {
      const buffer = nearbyReceiveBuffers.get(event.endpointId) ?? new Map<number, ClientMessage | ServerMessage>();
      buffer.set(packet.sequence, packet.payload);
      nearbyReceiveBuffers.set(event.endpointId, buffer);
      return;
    }

    let sequence = expected;
    let payload: ClientMessage | ServerMessage | undefined = packet.payload;
    const buffer = nearbyReceiveBuffers.get(event.endpointId);
    while (payload) {
      deliverNearbyMessage(event.endpointId, event.name, payload);
      sequence += 1;
      payload = buffer?.get(sequence);
      if (payload) buffer?.delete(sequence);
    }
    nearbyReceiveSequences.set(event.endpointId, sequence);
    if (buffer?.size === 0) nearbyReceiveBuffers.delete(event.endpointId);
  }

  function beginNearbyReconnect(): void {
    if (connectionMode !== 'nearby-join') return;
    if (nearbyHostName) setNearbyPeerState(nearbyHostName, 'disconnected', 'Nearby link lost · restarting discovery');
    if (state) {
      const host = state.players.find(player => player.id === state?.hostId);
      if (host?.connected !== false) {
        updateRoom({
          ...state,
          players: state.players.map(player => player.id === state?.hostId ? { ...player, connected: false } : player),
        });
      }
    }
    clearNearbyHelloTimer();
    nearbyAwaitingWelcome = false;
    clearNearbyConnectionAttemptTimer();
    nearbyHostId = null;
    transportSend = null;
    nearbyAutoReconnect = true;
    nearbyConnectingId = null;
    connectionLost('Host disconnected. Game paused while reconnecting…');
    scheduleNearbyTransport(0);
  }

  function showNearbyLobbyLoading(hostName: string, message = 'Connecting securely…'): void {
    nameGate.hidden = true;
    game.hidden = true;
    lobby.hidden = false;
    lobbyTitle.textContent = `Joining ${hostName}'s game`;
    roomLabels.forEach(label => { label.textContent = 'Local'; });
    roster.innerHTML = `<li class="is-loading">${escapeHtml(message)}</li>`;
    onlineInvite.hidden = true;
    dictionarySelect.disabled = true;
    start.hidden = true;
    chatInput.disabled = true;
    chatSend.disabled = true;
    lobbyHelp.textContent = 'Keep this screen open while the nearby lobby connects.';
  }

  function sendNearbyHello(): void {
    if (connectionMode !== 'nearby-join' || !nearbyHostId || !nearbyAwaitingWelcome) return;
    if (nearbyHostName) setNearbyPeerState(nearbyHostName, 'syncing', 'Transport connected · sending app handshake');
    const resumeToken = localStorage.getItem(sessionKey()) ?? undefined;
    sendNearby(nearbyHostId, { t: 'hello', v: PROTOCOL_VERSION, name: nearbyName, color: selectedPlayerColor(), resumeToken });
    clearNearbyHelloTimer();
    nearbyHelloTimer = window.setTimeout(sendNearbyHello, 900);
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
        await NearbyConnections.stopAdvertising().catch(() => undefined);
        await wait(250);
        if (connectionMode !== 'nearby-host') return;
        await NearbyConnections.startAdvertising({ name: nearbyWireName() });
        nearbyReconnectAttempt = 0;
        return;
      }
      if (nearbyHostId) return;
      await NearbyConnections.stopDiscovery();
      await NearbyConnections.startDiscovery({ name: nearbyWireName() });
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

  function updateHomeReadiness(): void {
    const ready = !!sanitizeName(nameInput.value);
    homeOptions.classList.toggle('is-ready', ready);
    homeOptions.setAttribute('aria-hidden', String(!ready));
  }

  async function requestNearbyPermissions(): Promise<void> {
    if (Capacitor.getPlatform() === 'android') await NearbyConnections.ensurePermissions();
    else await NearbyConnections.requestPermissions(nearbyPermissionAliases?.length ? { permissions: nearbyPermissionAliases } : undefined);
  }

  function nearbyPeerKey(name: string): string {
    return name.trim().toLocaleLowerCase();
  }

  function nearbyErrorDetail(error: unknown): string {
    const raw = error instanceof Error ? error.message
      : typeof error === 'object' && error && 'message' in error ? String(error.message)
      : '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 120) || 'native connection failed';
  }

  function setNearbyPeerState(name: string, phase: NearbyPeerPhase, detail: string): void {
    const key = nearbyPeerKey(name);
    if (!key) return;
    nearbyPeerStates.set(key, { phase, detail });
    diagnose('nearby-peer-state', { name, phase, detail });
    if (state?.phase === 'lobby') renderLobbyRoster(state);
  }

  function heartbeatAvailability(player: PlayerSummary): {
    status: 'checking' | 'available' | 'unavailable' | 'disconnected';
    text: string;
  } {
    if (player.connected === false) return { status: 'disconnected', text: 'Disconnected · unavailable' };
    if (connectionMode === 'online') return { status: 'available', text: 'Connected · available' };
    const heartbeat = playerHeartbeats.get(player.id);
    if (!heartbeat || heartbeat.status === 'checking') return { status: 'checking', text: 'Connected · checking availability…' };
    if (heartbeat.status === 'unavailable') return { status: 'unavailable', text: 'Connected · not responding' };
    return { status: 'available', text: 'Connected · available' };
  }

  function heartbeatGraph(playerId: string, unavailable: boolean): string {
    const samples = heartbeatSamples.get(playerId) ?? [];
    const visible = samples.slice(-12);
    const points = visible.map((sample, index) => {
      const x = visible.length < 2 ? 72 : 34 + index * (82 / (visible.length - 1));
      const y = sample < 0 ? 39 : 38 - Math.min(sample, 600) / 600 * 34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="heartbeat-monitor${unavailable ? ' is-unavailable' : ''}" viewBox="0 0 120 44" role="img" aria-label="Recent round-trip ping times from zero to 600 milliseconds"><text x="0" y="8">600 ms</text><text x="0" y="41">0 ms</text><polyline points="${points}"></polyline></svg>`;
  }

  function pulsePlayerHeartbeat(playerId: string, unavailable: boolean): void {
    const chip = Array.from(players.querySelectorAll<HTMLElement>('[data-view-player]'))
      .find(candidate => candidate.dataset.viewPlayer === playerId);
    const dot = chip?.querySelector<HTMLElement>('i');
    if (!dot) return;
    dot.classList.toggle('is-unavailable', unavailable);
    if (unavailable) return;
    dot.classList.remove('heartbeat-pulse');
    void dot.offsetWidth;
    dot.classList.add('heartbeat-pulse');
  }

  function renderLobbyRoster(room: RoomSnapshot): void {
    const playerNames = new Set(room.players.map(player => player.name.trim().toLocaleLowerCase()));
    const playerRows = room.players.map((player, index) => {
      const status = player.id === room.hostId ? 'Host' : '';
      const availability = heartbeatAvailability(player);
      const color = colorForPlayer(player, index);
      const graph = player.id === room.hostId ? '' : heartbeatGraph(player.id, availability.status === 'unavailable' || availability.status === 'disconnected');
      return `<li style="--owner-color:${color}"><span class="presence ${player.connected === false ? 'is-offline' : ''}" aria-hidden="true"></span><span class="roster-player"><strong style="color:${color}">${escapeHtml(player.name)}</strong><small class="player-availability ${availability.status}">${escapeHtml(availability.text)}</small></span>${graph}${status ? `<em class="invite-state ${status.toLowerCase()}">${status}</em>` : ''}</li>`;
    });
    const inviteRows = connectionMode === 'nearby-host'
      ? [...nearbyInviteStates.values()]
        .filter(invite => !playerNames.has(invite.name.trim().toLocaleLowerCase()))
        .map(invite => {
          const detail = invite.status === 'accepted' ? 'Connected · joining lobby…'
            : invite.status === 'received' ? 'Connection received · waiting for acceptance'
            : 'Not connected · request sent';
          return `<li><span class="presence invite-pending" aria-hidden="true"></span><span class="roster-player"><strong>${escapeHtml(invite.name)}</strong><small class="player-availability checking">${detail}</small></span><em class="invite-state ${invite.status}">${invite.status}</em></li>`;
        })
      : [];
    roster.innerHTML = [...playerRows, ...inviteRows].join('');
  }

  function endpointForPlayer(name: string): NearbyEndpoint | undefined {
    const normalized = name.trim().toLocaleLowerCase();
    const endpoints = [...nearbyEndpointMap.values()];
    const exact = endpoints.find(endpoint => endpoint.name.trim().toLocaleLowerCase() === normalized);
    if (exact) return exact;
    const unsuffixed = normalized.replace(/\s+\d+$/, '');
    const available = endpoints.filter(endpoint => !outgoingNearbyInvites.has(endpoint.endpointId));
    const loose = available.filter(endpoint => endpoint.name.trim().toLocaleLowerCase() === unsuffixed);
    if (loose.length === 1) return loose[0];
    const disconnected = state?.players.filter(player => player.connected === false && player.id !== state?.hostId) ?? [];
    return disconnected.length === 1 && available.length === 1 ? available[0] : undefined;
  }

  function renderPlayerDisconnect(room: RoomSnapshot): void {
    const disconnected = room.players.filter(player => player.connected === false && !player.eliminated);
    playerDisconnect.hidden = room.phase === 'lobby' || disconnected.length === 0;
    playerDisconnect.replaceChildren();
    if (playerDisconnect.hidden) return;
    const message = document.createElement('span');
    const hostDisconnected = connectionMode === 'nearby-join'
      && disconnected.some(player => player.id === room.hostId);
    message.textContent = hostDisconnected
      ? `${disconnected.find(player => player.id === room.hostId)?.name ?? 'Host'} disconnected — game paused while reconnecting.`
      : `${disconnected.map(player => player.name).join(', ')} disconnected.`;
    playerDisconnect.append(message);
  }

  async function sendNearbyReinvite(endpoint: NearbyEndpoint, playerName: string): Promise<void> {
    if (outgoingNearbyInvites.has(endpoint.endpointId)) return;
    pendingReinviteNames.delete(playerName.trim().toLocaleLowerCase());
    approvedNearbyNames.add(playerName.trim().toLocaleLowerCase());
    outgoingNearbyInvites.add(endpoint.endpointId);
    nearbyInviteStates.set(endpoint.endpointId, { name: playerName, status: 'requested' });
    setNearbyPeerState(playerName, 'requesting', 'Found endpoint · requesting Nearby connection');
    if (state) {
      renderLobbyRoster(state);
      renderPlayerDisconnect(state);
    }
    try {
      await NearbyConnections.stopDiscovery().catch(() => undefined);
      await NearbyConnections.stopAdvertising().catch(() => undefined);
      await NearbyConnections.requestConnection({ endpointId: endpoint.endpointId, name: nearbyWireName() });
      setNearbyPeerState(playerName, 'requested', 'Request queued · waiting for secure handshake');
    } catch (error) {
      outgoingNearbyInvites.delete(endpoint.endpointId);
      nearbyInviteStates.delete(endpoint.endpointId);
      if (state) {
        renderLobbyRoster(state);
        renderPlayerDisconnect(state);
      }
      setNearbyPeerState(playerName, 'failed', `Connection request failed · ${nearbyErrorDetail(error)}`);
      if (outgoingNearbyInvites.size === 0) scheduleNearbyTransport(0);
      show(`${endpoint.name} could not be invited.`, 'bad');
    }
  }

  async function reinviteNearbyPlayer(playerName: string): Promise<void> {
    const normalized = playerName.trim().toLocaleLowerCase();
    if (!normalized || pendingReinviteNames.has(normalized)) return;
    const endpoint = endpointForPlayer(playerName);
    if (endpoint) {
      await sendNearbyReinvite(endpoint, playerName);
      return;
    }
    pendingReinviteNames.add(normalized);
    setNearbyPeerState(playerName, 'searching', 'Discovery active · scanning Bluetooth/Wi-Fi through Nearby');
    if (state) {
      renderLobbyRoster(state);
      renderPlayerDisconnect(state);
    }
    try {
      await NearbyConnections.startDiscovery({ name: nearbyWireName() });
    } catch {
      pendingReinviteNames.delete(normalized);
      if (state) {
        renderLobbyRoster(state);
        renderPlayerDisconnect(state);
      }
      show(`Could not search for ${playerName}.`, 'bad');
    }
  }

  function dispatchPendingReinvites(): void {
    for (const normalized of [...pendingReinviteNames]) {
      const player = state?.players.find(candidate => candidate.connected === false
        && candidate.name.trim().toLocaleLowerCase() === normalized);
      if (!player) {
        pendingReinviteNames.delete(normalized);
        continue;
      }
      const endpoint = endpointForPlayer(player.name);
      if (endpoint) void sendNearbyReinvite(endpoint, player.name);
    }
  }

  function renderNearbyEndpoints(): void {
    nearbyEndpoints.replaceChildren();
    const renderedNames = new Set<string>();
    for (const endpoint of nearbyEndpointMap.values()) {
      const normalizedName = endpoint.name.trim().toLocaleLowerCase();
      if (renderedNames.has(normalizedName)) continue;
      renderedNames.add(normalizedName);
      const label = document.createElement('label');
      label.className = 'nearby-player';
      if (endpoint.color) label.style.setProperty('--player-color', endpoint.color);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedNearbyIds.has(endpoint.endpointId);
      const text = document.createElement('span');
      text.textContent = endpoint.name;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedNearbyIds.add(endpoint.endpointId);
        else selectedNearbyIds.delete(endpoint.endpointId);
        renderNearbyEndpoints();
      });
      label.append(checkbox, text);
      nearbyEndpoints.append(label);
    }
    const searchActive = nearbyHomePhase === 'starting' || nearbyHomePhase === 'visible' || nearbyHomePhase === 'searching';
    if (!nearbyEndpointMap.size || searchActive) {
      const searching = document.createElement('div');
      searching.className = `nearby-search${nearbyEndpointMap.size ? ' is-inline' : ''}`;
      const message = nearbyEndpointMap.size && searchActive ? 'Still searching for more players…'
        : nearbyHomePhase === 'permission' ? 'Nearby permission required · accept access to continue'
        : nearbyHomePhase === 'permission-required' ? 'Nearby permission required'
        : nearbyHomePhase === 'starting' ? 'Starting nearby radios…'
        : nearbyHomePhase === 'visible' ? 'Visible nearby · preparing search…'
        : nearbyHomePhase === 'searching' ? 'Searching nearby…'
        : nearbyHomePhase === 'failed' ? 'Nearby search could not start'
        : 'Nearby search has not started';
      searching.innerHTML = `${searchActive ? '<span aria-hidden="true">…</span>' : ''}<p>${message}</p>`;
      if (nearbyHomePhase === 'permission-required') {
        searching.querySelector('span')?.remove();
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.textContent = 'Allow nearby access';
        allow.addEventListener('click', () => { void startNearbyHome(); });
        searching.append(allow);
      }
      nearbyEndpoints.append(searching);
    }
    nearbyStartButton.hidden = selectedNearbyIds.size === 0;
    if (nearbyStartButton.getAttribute('aria-busy') !== 'true') {
      nearbyStartButton.disabled = selectedNearbyIds.size === 0 || nearbyHomeStarting;
      nearbyStartButton.textContent = selectedNearbyIds.size
        ? `Request game · ${selectedNearbyIds.size} ${selectedNearbyIds.size === 1 ? 'player' : 'players'}`
        : 'Request game';
    }
  }

  function showNearbyInvitation(invitation: NearbyVerification): void {
    if (pendingNearbyInvite) {
      void NearbyConnections.acceptVerification({ endpointId: invitation.endpointId, accept: false });
      return;
    }
    pendingNearbyInvite = invitation;
    inviteName.textContent = invitation.name;
    inviteDialog.showModal();
    requestAnimationFrame(() => inviteAccept.focus());
  }

  async function answerNearbyInvitation(accept: boolean): Promise<void> {
    const invitation = pendingNearbyInvite;
    if (!invitation) return;
    setButtonLoading(accept ? inviteAccept : inviteDecline, true, accept ? 'Joining…' : 'Declining…');
    try {
      if (accept) {
        setNearbyPeerState(invitation.name, 'authenticating', 'Invite accepted · completing secure handshake');
        connectionMode = 'nearby-join';
        nearbyHostName = invitation.name;
        nearbyConnectingId = invitation.endpointId;
        nearbyAutoReconnect = true;
        showNearbyLobbyLoading(invitation.name);
        await NearbyConnections.stopDiscovery().catch(() => undefined);
      }
      await NearbyConnections.acceptVerification({ endpointId: invitation.endpointId, accept });
      nearbyStatus.textContent = accept ? `Joining ${invitation.name}'s game…` : `Declined ${invitation.name}'s game.`;
    } catch {
      if (accept) {
        connectionMode = 'nearby-home';
        nearbyConnectingId = null;
        nearbyAutoReconnect = false;
        nameGate.hidden = false;
        lobby.hidden = true;
      }
      show('Could not respond to the local game invitation.', 'bad');
    } finally {
      pendingNearbyInvite = null;
      if (inviteDialog.open) inviteDialog.close();
      setButtonLoading(inviteAccept, false);
      setButtonLoading(inviteDecline, false);
    }
  }

  async function startNearbyHome(): Promise<void> {
    if (!isNativeNearby() || connectionMode && connectionMode !== 'nearby-home') return;
    const name = sanitizeName(nameInput.value);
    if (!name || nearbyHomeStarting) return;
    nearbyHomeStarting = true;
    nearbyName = name;
    connectionMode = 'nearby-home';
    clearNearbyHomeRefreshTimer();
    const generation = nearbyHomeGeneration;
    nearbyHomePhase = 'permission';
    nearbyStatus.textContent = 'Nearby permission is required before searching can begin.';
    renderNearbyEndpoints();
    try {
      await requestNearbyPermissions();
    } catch {
      connectionMode = null;
      nearbyHomePhase = 'permission-required';
      nearbyStatus.textContent = 'Allow nearby-device access to find local players.';
      nearbyHomeStarting = false;
      renderNearbyEndpoints();
      return;
    }
    void NearbyConnections.requestNotificationPermission().catch(() => undefined);
    nearbyHomePhase = 'starting';
    nearbyStatus.textContent = 'Starting nearby radios…';
    renderNearbyEndpoints();
    try {
      await runNearbyHomeRadios(name, false, generation);
    } catch {
      connectionMode = null;
      nearbyHomePhase = 'failed';
      nearbyStatus.textContent = 'Nearby discovery could not start. Check Bluetooth and Wi-Fi.';
    } finally {
      nearbyHomeStarting = false;
      renderNearbyEndpoints();
    }
  }

  function restartNearbyHome(): Promise<void> {
    if (nearbyHomeRestart) return nearbyHomeRestart;
    nearbyHomeRestart = (async () => {
      nearbyHomeStarting = true;
      nearbyHomePhase = 'starting';
      clearNearbyHomeRefreshTimer();
      connectionMode = null;
      nearbyStatus.textContent = 'Restarting nearby radios…';
      renderNearbyEndpoints();
      await NearbyConnections.stop().catch(error => diagnose('nearby-home-stop-failed', nearbyErrorDetail(error)));
      // Google Play Services tears its Nearby client down asynchronously after
      // stop() resolves. Do not expose stale endpoint IDs during that window.
      await wait(350);
      nearbyEndpointMap.clear();
      selectedNearbyIds.clear();
      nearbyHomeStarting = false;
      await startNearbyHome();
    })().finally(() => {
      nearbyHomeRestart = null;
      nearbyHomeStarting = false;
      renderNearbyEndpoints();
    });
    return nearbyHomeRestart;
  }

  function enterNearbyGuest(endpoint: NearbyEndpoint): void {
    clearNearbyHomeRefreshTimer();
    connectionMode = 'nearby-join';
    clearNearbyReconnectTimer();
    clearNearbyConnectionAttemptTimer();
    nearbyReconnectAttempt = 0;
    nearbyAutoReconnect = false;
    nearbyConnectingId = null;
    nearbyHostId = endpoint.endpointId;
    nearbyHostName = endpoint.name;
    nearbyAwaitingWelcome = true;
    roomName = 'nearby';
    roomLabels.forEach(label => { label.textContent = 'Local'; });
    onlineInvite.hidden = true;
    lobbyHelp.textContent = 'This is a local game connected directly to the nearby starter—no internet or invite link needed.';
    transportSend = message => sendNearby(endpoint.endpointId, message);
    void NearbyConnections.setKeepAwake({ enabled: true });
    showNearbyLobbyLoading(endpoint.name, 'Loading lobby…');
    sendNearbyHello();
  }

  function restoreNearbyHostForRejoin(restored: StoredLocalRoom, hostName: string): void {
    clearNearbyHomeRefreshTimer();
    clearNearbyReconnectTimer();
    clearNearbyConnectionAttemptTimer();
    clearNearbyHelloTimer();
    clearAllNearbyChannels();
    connectionMode = 'nearby-host';
    nearbyName = hostName;
    nearbyAutoReconnect = false;
    nearbyConnectingId = null;
    nearbyReconnectAttempt = 0;
    nearbyHostId = null;
    nearbyHostName = '';
    nearbyAwaitingWelcome = false;
    connectionRestored();
    stopOnlineTransport();
    void NearbyConnections.setKeepAwake({ enabled: true });
    roomName = 'nearby';
    roomLabels.forEach(label => { label.textContent = 'Local'; });
    onlineInvite.hidden = true;
    lobbyHelp.textContent = 'This is a local, device-to-device game. Friends can rejoin from nearby play.';
    localHost = new LocalRoomHost((peerId, message) => {
      if (peerId === localPeerId) handleServerMessage(message);
      else sendNearby(peerId, message);
    }, saveLocalGame, restored);
    transportSend = message => localHost?.receive(localPeerId, message as ClientMessage);
    outgoingNearbyInvites.clear();
    nearbyInviteStates.clear();
    pendingReinviteNames.clear();
    approvedNearbyNames.clear();
    for (const player of restored.players) {
      if (player.id !== restored.hostId) approvedNearbyNames.add(player.name.trim().toLocaleLowerCase());
    }
    const resumeToken = localStorage.getItem(sessionKey()) ?? undefined;
    localHost.receive(localPeerId, {
      t: 'hello', v: PROTOCOL_VERSION, name: hostName, color: selectedPlayerColor(), resumeToken,
    });
    show('Local lobby restored. Reconnecting players…', 'good');
  }

  async function initializeNearby(): Promise<void> {
    if (!isNativeNearby()) return;
    const availability = await NearbyConnections.isAvailable().catch(() => ({ available: false }));
    if (!availability.available) return;
    nearbyPermissionAliases = 'permissionAliases' in availability ? availability.permissionAliases : undefined;
    nearbyEntry.hidden = false;

    await NearbyConnections.addListener('endpointFound', rawEndpoint => {
      const endpoint = decodeNearbyEndpoint(rawEndpoint);
      const lossTimer = nearbyEndpointLossTimers.get(endpoint.endpointId);
      if (lossTimer != null) window.clearTimeout(lossTimer);
      nearbyEndpointLossTimers.delete(endpoint.endpointId);
      const previousTransport = nearbyPeerStates.get(nearbyPeerKey(endpoint.name));
      if (!previousTransport || ['searching', 'disconnected', 'failed'].includes(previousTransport.phase)) {
        setNearbyPeerState(endpoint.name, 'found', 'Nearby advertisement found · endpoint is reachable');
      }
      for (const [knownId, known] of nearbyEndpointMap) {
        const sameDevice = endpoint.deviceId && known.deviceId === endpoint.deviceId;
        const sameName = known.name.trim().toLocaleLowerCase() === endpoint.name.trim().toLocaleLowerCase();
        if (knownId !== endpoint.endpointId && (sameDevice || sameName)) {
          nearbyEndpointMap.delete(knownId);
          selectedNearbyIds.delete(knownId);
        }
      }
      const isNew = !nearbyEndpointMap.has(endpoint.endpointId);
      nearbyEndpointMap.set(endpoint.endpointId, endpoint);
      if (connectionMode === 'nearby-home' && isNew) selectedNearbyIds.add(endpoint.endpointId);
      renderNearbyEndpoints();
      dispatchPendingReinvites();
      if (state && connectionMode === 'nearby-host') {
        renderLobbyRoster(state);
        renderPlayerDisconnect(state);
      }
      if (connectionMode === 'nearby-join' && nearbyAutoReconnect && !nearbyHostId && !nearbyConnectingId
        && (!nearbyHostName || endpoint.name === nearbyHostName)) {
        // The periodic discovery refresh must not interrupt a connection that
        // has already found the saved host and started its handshake.
        clearNearbyReconnectTimer();
        nearbyConnectingId = endpoint.endpointId;
        setNearbyPeerState(endpoint.name, 'requesting', 'Endpoint found · requesting Nearby reconnection');
        nearbyStatus.textContent = `Reconnecting to ${endpoint.name}…`;
        clearNearbyConnectionAttemptTimer();
        nearbyConnectionAttemptTimer = window.setTimeout(() => {
          if (nearbyConnectingId !== endpoint.endpointId || nearbyHostId) return;
          setNearbyPeerState(endpoint.name, 'failed', 'Connection timed out · restarting discovery');
          nearbyConnectingId = null;
          void NearbyConnections.disconnect({ endpointId: endpoint.endpointId }).catch(() => undefined);
          scheduleNearbyTransport(0);
        }, 12_000);
        void Promise.all([
          NearbyConnections.stopDiscovery().catch(() => undefined),
          NearbyConnections.stopAdvertising().catch(() => undefined),
        ]).then(() => NearbyConnections.requestConnection({ endpointId: endpoint.endpointId, name: nearbyWireName() }))
          .then(() => setNearbyPeerState(endpoint.name, 'requested', 'Reconnect queued · waiting for secure handshake'))
          .catch(error => {
            clearNearbyConnectionAttemptTimer();
            setNearbyPeerState(endpoint.name, 'failed', `Reconnect failed · ${nearbyErrorDetail(error)}`);
            nearbyConnectingId = null;
            scheduleNearbyTransport();
          });
      }
    });
    await NearbyConnections.addListener('endpointLost', rawEndpoint => {
      const endpoint = decodeNearbyEndpoint(rawEndpoint);
      const connectionPending = outgoingNearbyInvites.has(endpoint.endpointId)
        || nearbyConnectingId === endpoint.endpointId;
      const previousTimer = nearbyEndpointLossTimers.get(endpoint.endpointId);
      if (previousTimer != null) window.clearTimeout(previousTimer);
      // Wi-Fi LAN advertisements can briefly vanish while Nearby changes radio
      // medium. Keep the player stable long enough for the same endpoint to be
      // rediscovered instead of making the home list flicker and lose selection.
      const timer = window.setTimeout(() => {
        nearbyEndpointLossTimers.delete(endpoint.endpointId);
        nearbyEndpointMap.delete(endpoint.endpointId);
        selectedNearbyIds.delete(endpoint.endpointId);
        // Discovery loss does not mean connection loss. Nearby often removes an
        // advertisement while the connection handshake is still progressing.
        if (!connectionPending) nearbyInviteStates.delete(endpoint.endpointId);
        renderNearbyEndpoints();
        if (connectionMode === 'nearby-home' && nearbyEndpointMap.size === 0) scheduleNearbyHomeRefresh();
        if (state && connectionMode === 'nearby-host') {
          renderLobbyRoster(state);
          renderPlayerDisconnect(state);
        }
      }, 12_000);
      nearbyEndpointLossTimers.set(endpoint.endpointId, timer);
    });
    await NearbyConnections.addListener('verificationRequired', rawVerification => {
      const verification = decodeNearbyEndpoint(rawVerification);
      setNearbyPeerState(verification.name, 'authenticating', 'Secure Nearby handshake · authenticating devices');
      if (connectionMode === 'nearby-home') {
        const restored = readLocalGame();
        const ownToken = localStorage.getItem('tiles-session:nearby');
        const savedHost = restored?.players.find(player => player.id === restored.hostId
          && (!ownToken || player.resumeToken === ownToken));
        const knownParticipant = restored?.players.some(player => player.id !== restored.hostId
          && player.name.trim().toLocaleLowerCase() === verification.name.trim().toLocaleLowerCase());
        if (restored && savedHost && knownParticipant) {
          restoreNearbyHostForRejoin(restored, savedHost.name);
          void NearbyConnections.acceptVerification({ endpointId: verification.endpointId, accept: true });
          return;
        }
      }
      const returningPlayer = connectionMode === 'nearby-host'
        && state?.players.some(player => player.connected === false
          && player.name.trim().toLocaleLowerCase() === verification.name.trim().toLocaleLowerCase());
      const approvedPlayer = approvedNearbyNames.has(verification.name.trim().toLocaleLowerCase());
      if (connectionMode === 'nearby-host' && (outgoingNearbyInvites.has(verification.endpointId) || returningPlayer || approvedPlayer)) {
        const invite = nearbyInviteStates.get(verification.endpointId);
        if (invite) invite.status = 'received';
        if (state) {
          renderLobbyRoster(state);
          renderPlayerDisconnect(state);
        }
        void NearbyConnections.acceptVerification({ endpointId: verification.endpointId, accept: true });
        return;
      }
      if (connectionMode === 'nearby-join') {
        void NearbyConnections.acceptVerification({ endpointId: verification.endpointId, accept: true });
        return;
      }
      if (connectionMode === 'nearby-home') showNearbyInvitation(verification);
      else void NearbyConnections.acceptVerification({ endpointId: verification.endpointId, accept: false });
    });
    await NearbyConnections.addListener('connected', rawEndpoint => {
      const endpoint = decodeNearbyEndpoint(rawEndpoint);
      clearNearbyConnectionAttemptTimer();
      clearNearbyChannel(endpoint.endpointId);
      connectionRestored();
      setNearbyPeerState(endpoint.name, 'transport', 'Nearby transport connected · waiting for app handshake');
      if (localHost) {
        const invite = nearbyInviteStates.get(endpoint.endpointId);
        if (invite) invite.status = 'accepted';
        outgoingNearbyInvites.delete(endpoint.endpointId);
        if (state) {
          renderLobbyRoster(state);
          renderPlayerDisconnect(state);
        }
        if (outgoingNearbyInvites.size === 0) {
          void NearbyConnections.stopDiscovery();
          void NearbyConnections.startAdvertising({ name: nearbyWireName() });
        }
        nearbyReconnectAttempt = 0;
        nearbyStatus.textContent = `${endpoint.name} connected.`;
        return;
      }
      if (connectionMode === 'nearby-home') {
        enterNearbyGuest(endpoint);
        return;
      }
      if (connectionMode !== 'nearby-join') {
        void NearbyConnections.disconnect({ endpointId: endpoint.endpointId });
        return;
      }
      clearNearbyReconnectTimer();
      nearbyReconnectAttempt = 0;
      nearbyAutoReconnect = false;
      nearbyConnectingId = null;
      nearbyHostId = endpoint.endpointId;
      nearbyHostName = endpoint.name;
      void NearbyConnections.stopAdvertising();
      void NearbyConnections.stopDiscovery();
      enterNearbyGuest(endpoint);
    });
    await NearbyConnections.addListener('disconnected', rawEndpoint => {
      const endpoint = decodeNearbyEndpoint(rawEndpoint);
      if (nearbyConnectingId === endpoint.endpointId || nearbyHostId === endpoint.endpointId) {
        clearNearbyConnectionAttemptTimer();
      }
      clearNearbyChannel(endpoint.endpointId);
      setNearbyPeerState(endpoint.name, 'disconnected', 'Nearby transport disconnected · retry required');
      if (connectionMode === 'nearby-host' && localHost) {
        const pendingInvite = outgoingNearbyInvites.has(endpoint.endpointId);
        nearbyEndpointMap.delete(endpoint.endpointId);
        outgoingNearbyInvites.delete(endpoint.endpointId);
        nearbyInviteStates.delete(endpoint.endpointId);
        selectedNearbyIds.delete(endpoint.endpointId);
        if (pendingInvite) {
          if (state) {
            renderLobbyRoster(state);
            renderPlayerDisconnect(state);
          }
          show(`${endpoint.name} could not be invited.`, 'bad');
          if (outgoingNearbyInvites.size === 0) scheduleNearbyTransport(0);
          return;
        }
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
    await NearbyConnections.addListener('payloadReceived', rawEvent => {
      const event = decodeNearbyEndpoint(rawEvent);
      receiveNearbyPacket(event);
    });
    if (sanitizeName(nameInput.value)) void startNearbyHome();
    else nearbyStatus.textContent = 'Enter your player name to appear for nearby players.';
  }

  async function startNearbyHost(name: string, restored?: StoredLocalRoom, inviteIds: string[] = []): Promise<void> {
    const invitedEndpointNames = new Map(inviteIds.map(endpointId => [
      endpointId,
      nearbyEndpointMap.get(endpointId)?.name ?? 'Nearby player',
    ]));
    // Claim the transport synchronously, before the first await. Otherwise a
    // queued home/profile refresh can call stop() while invitations are being
    // sent and invalidate every selected endpoint.
    clearNearbyHomeRefreshTimer();
    connectionMode = 'nearby-host';
    nearbyName = name;
    try {
      await requestNearbyPermissions();
      clearAllNearbyChannels();
      nearbyAutoReconnect = false;
      nearbyConnectingId = null;
      nearbyReconnectAttempt = 0;
      clearNearbyReconnectTimer();
      connectionRestored();
      stopOnlineTransport();
      await NearbyConnections.setKeepAwake({ enabled: true });
      if (inviteIds.length) {
        // The selected endpoints are already known. Stop local scanning and
        // advertising so the radio can concentrate on outgoing handshakes.
        await NearbyConnections.stopDiscovery().catch(() => undefined);
        await NearbyConnections.stopAdvertising().catch(() => undefined);
        await wait(300);
      } else {
        await NearbyConnections.startAdvertising({ name: nearbyWireName(name) });
      }
      if (restored) {
        // Endpoint IDs are ephemeral. A saved player must be freshly discovered
        // before we offer an invitation for the restored game. Discovery may
        // already be active on the home screen, so force a real restart rather
        // than relying on startDiscovery(), which is intentionally idempotent
        // in the native plugins and would not emit already-found endpoints.
        await NearbyConnections.stopDiscovery().catch(() => undefined);
        nearbyEndpointMap.clear();
        selectedNearbyIds.clear();
        outgoingNearbyInvites.clear();
        pendingReinviteNames.clear();
        nearbyInviteStates.clear();
        await wait(350);
        diagnose('nearby-resume-discovery-restart', { playerCount: restored.players.length });
        await NearbyConnections.startDiscovery({ name: nearbyWireName(name) });
      }
      roomName = 'nearby';
      if (!restored) {
        localStorage.removeItem(LOCAL_GAME_KEY);
        localStorage.removeItem(LOCAL_SESSION_KEY);
        localStorage.removeItem('tiles-session:nearby');
      }
      roomLabels.forEach(label => { label.textContent = 'Local'; });
      onlineInvite.hidden = true;
      lobbyHelp.textContent = 'This is a local, device-to-device game. Friends can join from nearby play. Keep Bluetooth and Wi-Fi enabled.';
      localHost = new LocalRoomHost((peerId, message) => {
        if (peerId === localPeerId) handleServerMessage(message);
        else sendNearby(peerId, message);
      }, saveLocalGame, restored);
      transportSend = message => localHost?.receive(localPeerId, message as ClientMessage);
      outgoingNearbyInvites.clear();
      approvedNearbyNames.clear();
      nearbyInviteStates.clear();
      for (const endpointId of inviteIds) {
        const endpointName = invitedEndpointNames.get(endpointId) ?? 'Nearby player';
        outgoingNearbyInvites.add(endpointId);
        approvedNearbyNames.add(endpointName.trim().toLocaleLowerCase());
        nearbyInviteStates.set(endpointId, {
          name: endpointName,
          status: 'requested',
        });
        setNearbyPeerState(endpointName, 'requesting', 'Endpoint selected · requesting Nearby connection');
      }
      const resumeToken = restored ? localStorage.getItem(sessionKey()) ?? undefined : undefined;
      localHost.receive(localPeerId, { t: 'hello', v: PROTOCOL_VERSION, name, color: selectedPlayerColor(), resumeToken });
      for (const [index, endpointId] of inviteIds.entries()) {
        const endpointName = invitedEndpointNames.get(endpointId) ?? 'Nearby player';
        try {
          await NearbyConnections.requestConnection({ endpointId, name: nearbyWireName(name) });
          setNearbyPeerState(endpointName, 'requested', 'Request queued · waiting for secure handshake');
        } catch (error) {
          nearbyInviteStates.delete(endpointId);
          outgoingNearbyInvites.delete(endpointId);
          setNearbyPeerState(endpointName, 'failed', `Connection request failed · ${nearbyErrorDetail(error)}`);
          if (outgoingNearbyInvites.size === 0) scheduleNearbyTransport(0);
          if (state) renderLobbyRoster(state);
          show(`${endpointName} could not be invited.`, 'bad');
        }
        // Avoid asking the BLE/Wi-Fi stack to establish several secure links
        // in the same event-loop turn on larger local games.
        if (index < inviteIds.length - 1) await wait(300);
      }
      show(restored ? 'Local game restored. Friends can rejoin now.' : 'Local lobby ready. Friends can discover you now.', 'good');
    } catch {
      setButtonLoading(nearbyStartButton, false);
      show('Nearby play needs Bluetooth, Wi-Fi and permission to find devices.', 'bad');
    }
  }

  async function startSelectedLocalGame(): Promise<void> {
    if (nearbyHomeStarting || nearbyHomeRestart) return;
    const name = requireNearbyName();
    if (!name) return;
    const inviteIds = [...selectedNearbyIds];
    if (!inviteIds.length) return;
    setButtonLoading(nearbyStartButton, true, 'Requesting…');
    await startNearbyHost(name, undefined, inviteIds);
  }

  async function continueLocalGame(name: string, role: 'host' | 'participant'): Promise<void> {
    if (role === 'participant') {
      const session = readLocalSession();
      if (!session) {
        renderSavedGames();
        show('That local game is no longer stored on this device.', 'bad');
        return;
      }
      try {
        await requestNearbyPermissions();
        clearAllNearbyChannels();
        connectionMode = 'nearby-join';
        nearbyName = name;
        nearbyHostName = session.hostName;
        nearbyHostId = null;
        nearbyAutoReconnect = true;
        nearbyConnectingId = null;
        nearbyReconnectAttempt = 0;
        roomName = 'nearby';
        nameInput.value = name;
        localStorage.setItem('tiles-name', name);
        stopOnlineTransport();
        showNearbyLobbyLoading(session.hostName, `Finding ${session.hostName} nearby…`);
        await NearbyConnections.stop().catch(() => undefined);
        await resumeNearbyTransport();
      } catch {
        show('Nearby play needs Bluetooth, Wi-Fi and permission to rejoin.', 'bad');
        renderSavedGames();
      }
      return;
    }
    const restored = readLocalGame();
    if (!restored) {
      renderSavedGames();
      show('That local game is no longer stored on this device.', 'bad');
      return;
    }
    nearbyName = name;
    nameInput.value = name;
    localStorage.setItem('tiles-name', name);
    await startNearbyHost(name, restored);
  }

  function updateRoom(next: RoomSnapshot): void {
    if (dragging && next.phase !== 'playing') cancelDrag();
    const previousPhase = state?.phase;
    const previousPeel = state?.peel;
    const dictionary = next.dictionary ?? 'scowl-gb';
    clearNearbyHelloTimer();
    if (connectionMode === 'nearby-join') {
      void NearbyConnections.stopAdvertising();
      void NearbyConnections.stopDiscovery();
    } else if (connectionMode === 'nearby-host' && next.phase !== 'lobby') {
      // The host no longer needs to scan once play begins. Leaving discovery active
      // competes with the high-bandwidth peer connection on some devices.
      void NearbyConnections.stopDiscovery();
    }
    state = next;
    state.dictionary = dictionary;
    const currentPlayer = next.players.find(player => player.id === myId);
    if (currentPlayer?.color) {
      selectPlayerColor(currentPlayer.color);
      localStorage.setItem('tiles-color', sanitizePlayerColor(currentPlayer.color));
    }
    for (const row of chatLog.querySelectorAll<HTMLElement>('[data-chat-player]')) {
      const playerIndex = next.players.findIndex(player => player.id === row.dataset.chatPlayer);
      if (playerIndex < 0) continue;
      const author = row.querySelector<HTMLElement>('strong');
      if (author) author.style.color = colorForPlayer(next.players[playerIndex], playerIndex);
    }
    for (const player of next.players) {
      if (player.connected !== false) pendingReinviteNames.delete(player.name.trim().toLocaleLowerCase());
    }
    rememberGame(next);
    bunch.textContent = String(next.bunch);
    peel.textContent = String(next.peel);
    dumps.textContent = String(next.dumps ?? 0);
    renderLobbyRoster(next);
    const orderedPlayers = next.players
      .map((player, index) => ({ player, index }))
      .sort((a, b) => Number(b.player.id === myId) - Number(a.player.id === myId));
    players.innerHTML = orderedPlayers.map(({ player, index }) => {
      const heartbeat = heartbeatAvailability(player);
      const unavailable = heartbeat.status === 'unavailable' || heartbeat.status === 'disconnected';
      return `<li><button type="button" data-view-player="${escapeHtml(player.id)}" class="player-chip ${player.id === myId ? 'is-you' : ''} ${viewingPlayerId === player.id ? 'is-viewing' : ''} ${player.eliminated ? 'is-out' : ''} ${player.connected === false ? 'is-offline' : ''}" style="--owner-color:${colorForPlayer(player, index)}"><i class="${unavailable ? 'is-unavailable' : ''}"></i><span>${escapeHtml(player.name)}</span><b>${player.connected === false ? 'OFFLINE' : player.eliminated ? 'OUT' : `${player.tilesLeft} loose`}</b></button></li>`;
    }
    ).join('');
    requestAnimationFrame(updatePlayerScrollFades);
    renderPlayerDisconnect(next);
    const connectedPlayers = next.players.filter(player => player.connected !== false).length;
    start.hidden = myId !== next.hostId;
    start.disabled = connectedPlayers < 2;
    start.textContent = connectedPlayers < 2
      ? 'Waiting for an opponent…'
      : next.resumeAvailable ? `Resume with ${connectedPlayers} players` : `Start with ${connectedPlayers} players`;
    if (connectionMode === 'nearby-host' && next.resumeAvailable) {
      lobbyHelp.textContent = myId === next.hostId
        ? 'Returning players will wait here. Resume the saved game when everyone is ready.'
        : 'Waiting for the game creator to resume the saved game.';
    } else if (connectionMode === 'nearby-join' && next.resumeAvailable) {
      lobbyHelp.textContent = 'Waiting for the game creator to resume the saved game.';
    }
    dictionarySelect.value = dictionary;
    dictionarySelect.disabled = myId !== next.hostId || next.phase !== 'lobby';
    newGame.disabled = myId !== next.hostId || next.players.length < 2;
    newGame.hidden = myId !== next.hostId;
    newGame.title = myId === next.hostId ? '' : 'Only the host can start a new game.';
    void loadDictionary(dictionary);

    nameGate.hidden = true;
    lobbyTitle.textContent = connectionMode === 'nearby-host' || connectionMode === 'nearby-join' ? 'Local room' : 'Online room';
    lobby.hidden = next.phase !== 'lobby';
    game.hidden = next.phase === 'lobby';
    flushChatReadReceipts();
    chatInput.disabled = next.phase !== 'lobby';
    if (chatSend.getAttribute('aria-busy') !== 'true') chatSend.disabled = next.phase !== 'lobby';
    setButtonLoading(enterLobby, false);
    setButtonLoading(nearbyStartButton, false);
    if (next.phase !== 'lobby') setButtonLoading(start, false);

    if ((next.phase === 'playing' && previousPhase === 'lobby') || (previousPhase == null && next.phase !== 'lobby')) {
      peelSent = -1;
      const myIndex = next.players.findIndex(player => player.id === myId);
      const myArea = areaFor(next.players[myIndex], myIndex, next.players.length);
      camera = { x: 0, y: 0, scale: .5, rotation: -(myArea?.rotation ?? 0) };
      viewingPlayerId = myId;
      requestAnimationFrame(() => focusPlayer(myId, false));
    }
    if (next.phase === 'finished' && next.winnerId && previousPhase !== 'finished') {
      const winner = next.players.find(player => player.id === next.winnerId);
      show(winner?.id === myId ? 'You are Top Banana!' : `${winner?.name ?? 'A player'} wins — you can finish your grid.`, 'good');
    }
    if (previousPeel != null && next.peel > previousPeel) {
      peelAnimation.classList.remove('is-playing');
      void peelAnimation.offsetWidth;
      peelAnimation.classList.add('is-playing');
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
    boardLayer.querySelectorAll('.autofill-arrow').forEach(node => node.remove());
    rack.innerHTML = '';

    for (const [playerIndex, player] of (state?.players ?? []).entries()) {
      const color = colorForPlayer(player, playerIndex);
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

    const selected = selectedId ? tiles.find(tile => tile.id === selectedId && tile.x != null && tile.y != null) : undefined;
    if (selected?.x != null && selected.y != null && canEditTiles()) {
      const [dx, dy] = autoFillVector();
      const myIndex = state?.players.findIndex(player => player.id === myId) ?? -1;
      const areaRotation = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 0)?.rotation ?? 0;
      const arrow = document.createElement('span');
      arrow.className = 'autofill-arrow';
      arrow.textContent = autoFillDirection === 'right' ? '→' : '↓';
      arrow.style.left = `calc(50% + ${(selected.x + dx * .82) * TILE}px)`;
      arrow.style.top = `calc(50% + ${(selected.y + dy * .82) * TILE}px)`;
      arrow.style.transform = `rotate(${areaRotation}rad)`;
      boardLayer.append(arrow);
    }

    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const me = state?.players.find(player => player.id === myId);
    for (const [slotIndex, tileId] of rackOrder.entries()) {
      const slot = document.createElement('div');
      slot.className = 'rack-slot';
      slot.dataset.rackIndex = String(slotIndex);
      if (tileId) slot.dataset.rackId = tileId;
      const tile = tileId ? tiles.find(value => value.id === tileId) : undefined;
      if (tile && (tile.x == null || tile.y == null)) slot.append(makeTile(tile, me, colorForPlayer(me, Math.max(0, myIndex)), canEditTiles(), 0));
      rack.append(slot);
    }
    dump.disabled = !selectedId || (state?.bunch ?? 0) < 3 || state?.phase !== 'playing';
    randomiseButton.disabled = !canEditTiles() || tiles.filter(tile => tile.x == null || tile.y == null).length < 2;
    updateHistoryButtons();
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
    validity?: 'valid' | 'partial' | 'invalid',
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
    element.classList.toggle('is-partial-word', validity === 'partial');
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
    if (touchGesture || pointers.size > 1 || gesture?.distance) {
      cancelDrag();
      return;
    }
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
    const before = editSnapshot();
    const rect = board.getBoundingClientRect();
    let layoutChanged = false;
    let historyChanged = false;
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
      } else if (occupied && moving.length === 1 && insertTileAt(tile, x, y, movingSet)) {
        selectedIds.clear();
        selectedIds.add(tile.id);
        selectedId = tile.id;
        layoutChanged = true;
        historyChanged = true;
      } else if (occupied) {
        show(occupied.ownerId === myId ? 'That row cannot be shifted further.' : `${occupied.ownerName}'s tile is already there.`, 'bad');
      } else {
        for (const destination of destinations) {
          destination.value.x = destination.x;
          destination.value.y = destination.y;
        }
        selectedIds.clear();
        moving.forEach(id => selectedIds.add(id));
        selectedId = tile.id;
        layoutChanged = true;
        historyChanged = true;
      }
    } else if (tile && !interaction.wasPlaced && pointInRect(event.clientX, event.clientY, rack.getBoundingClientRect())) {
      historyChanged = reorderRack(tile.id, event.clientX, event.clientY);
    } else if (tile && interaction.dragIds.length) {
      for (const id of interaction.dragIds) {
        const value = tiles.find(candidate => candidate.id === id);
        if (value) { value.x = null; value.y = null; }
      }
      if (pointInRect(event.clientX, event.clientY, rackWrap.getBoundingClientRect())) {
        historyChanged = reorderRack(tile.id, event.clientX, event.clientY) || historyChanged;
      }
      selectedIds.clear();
      selectedId = null;
      layoutChanged = interaction.wasPlaced;
      historyChanged = historyChanged || interaction.wasPlaced;
    }
    finishDrag(interaction);
    if (historyChanged) recordEdit(before);
    if (layoutChanged) sendOwnLayout();
    renderTiles();
  }

  function placeFirstTile(tile: LocalTile): void {
    const before = editSnapshot();
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
    recordEdit(before);
    sendOwnLayout();
  }

  function autoFillVector(): readonly [number, number] {
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const area = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1);
    const rotation = area?.rotation ?? 0;
    const rightX = Math.round(Math.cos(rotation));
    const rightY = Math.round(Math.sin(rotation));
    return autoFillDirection === 'right' ? [rightX, rightY] : [-rightY, rightX];
  }

  function addTappedTile(tile: LocalTile, anchorId: string): void {
    const anchor = tiles.find(value => value.id === anchorId && value.x != null && value.y != null);
    if (!anchor || anchor.x == null || anchor.y == null) return;

    const placed = boardPayload();
    const at = new Map(placed.map(value => [`${value.x},${value.y}`, value]));
    const [stepX, stepY] = autoFillVector();
    const run = axisRun(anchor.x, anchor.y, stepX, stepY, at);
    const end = run.at(-1);
    const targetX = (end?.x ?? anchor.x) + stepX;
    const targetY = (end?.y ?? anchor.y) + stepY;
    const occupied = allPlaced().find(value => value.tile.x === targetX && value.tile.y === targetY);
    if (occupied) {
      show(`${occupied.ownerName}'s tile is already there.`, 'bad');
      return;
    }

    const before = editSnapshot();
    tile.x = targetX;
    tile.y = targetY;
    selectedIds.clear();
    selectedIds.add(tile.id);
    selectedId = tile.id;
    recordEdit(before);
    sendOwnLayout();
  }

  function insertTileAt(tile: LocalTile, x: number, y: number, movingSet: Set<string>): boolean {
    const [stepX, stepY] = autoFillVector();
    const occupied = new Map(allPlaced()
      .filter(value => !movingSet.has(value.tile.id))
      .map(value => [`${value.tile.x},${value.tile.y}`, value]));
    const chain: LocalTile[] = [];
    let cursorX = x;
    let cursorY = y;
    while (occupied.has(`${cursorX},${cursorY}`)) {
      const occupant = occupied.get(`${cursorX},${cursorY}`)!;
      if (occupant.ownerId !== myId) return false;
      const ownTile = tiles.find(value => value.id === occupant.tile.id);
      if (!ownTile) return false;
      chain.push(ownTile);
      cursorX += stepX;
      cursorY += stepY;
      if (Math.abs(cursorX) > 100 || Math.abs(cursorY) > 100) return false;
    }
    for (const shifted of chain.reverse()) {
      shifted.x = (shifted.x ?? 0) + stepX;
      shifted.y = (shifted.y ?? 0) + stepY;
    }
    tile.x = x;
    tile.y = y;
    return true;
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

  function flipSelectedWord(): void {
    const anchor = tiles.find(tile => tile.id === selectedId && tile.x != null && tile.y != null);
    if (!anchor || anchor.x == null || anchor.y == null) {
      autoFillDirection = autoFillDirection === 'right' ? 'down' : 'right';
      updateFillDirectionButton();
      renderTiles();
      return;
    }
    const at = new Map(boardPayload().map(tile => [`${tile.x},${tile.y}`, tile]));
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const rotation = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1)?.rotation ?? 0;
    const right: readonly [number, number] = [Math.round(Math.cos(rotation)), Math.round(Math.sin(rotation))];
    const down: readonly [number, number] = [-right[1], right[0]];
    const horizontal = axisRun(anchor.x, anchor.y, right[0], right[1], at);
    const vertical = axisRun(anchor.x, anchor.y, down[0], down[1], at);
    const run = horizontal.length >= vertical.length ? horizontal : vertical;
    if (run.length < 2) {
      autoFillDirection = autoFillDirection === 'right' ? 'down' : 'right';
      updateFillDirectionButton();
      renderTiles();
      return;
    }
    const from = run === horizontal ? right : down;
    const to = run === horizontal ? down : right;
    const pivot = run[0];
    const moving = new Set(run.map(tile => tile.id));
    const destinations = run.map((tile, index) => ({ tile, x: pivot.x + to[0] * index, y: pivot.y + to[1] * index }));
    const occupied = new Set(allPlaced().filter(value => !moving.has(value.tile.id)).map(value => `${value.tile.x},${value.tile.y}`));
    if (destinations.some(value => occupied.has(`${value.x},${value.y}`))) {
      show('That word cannot flip into occupied spaces.', 'bad');
      return;
    }
    const before = editSnapshot();
    for (const destination of destinations) {
      const tile = tiles.find(value => value.id === destination.tile.id);
      if (tile) { tile.x = destination.x; tile.y = destination.y; }
    }
    selectedIds.clear();
    run.forEach(tile => selectedIds.add(tile.id));
    selectedId = anchor.id;
    autoFillDirection = from === right ? 'down' : 'right';
    updateFillDirectionButton();
    recordEdit(before);
    sendOwnLayout();
    renderTiles();
  }

  function randomiseRack(): void {
    const loose = rackOrder
      .map((id, index) => ({ id, index, tile: id ? tiles.find(tile => tile.id === id) : undefined }))
      .filter(value => value.id && value.tile && (value.tile.x == null || value.tile.y == null));
    if (loose.length < 2) return;
    const before = editSnapshot();
    const ids = loose.map(value => value.id!);
    for (let index = ids.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [ids[index], ids[other]] = [ids[other], ids[index]];
    }
    loose.forEach((value, index) => { rackOrder[value.index] = ids[index]; });
    recordEdit(before);
    renderTiles();
  }

  function updateFillDirectionButton(): void {
    const arrow = autoFillDirection === 'right' ? '→' : '↓';
    fillDirection.textContent = `Fill ${arrow}`;
    fillDirection.setAttribute('aria-label', `Autofill ${autoFillDirection}`);
  }

  function sendOwnLayout(): void {
    const board = boardPayload();
    const player = state?.players.find(value => value.id === myId);
    if (player) {
      player.board = board;
      player.tilesLeft = tiles.filter(tile => tile.x == null || tile.y == null).length;
      updateLooseCountChip(player.id, player.tilesLeft);
    }
    send({ t: 'layout', board });
  }

  function updateLooseCountChip(playerId: string, count: number): void {
    const label = players.querySelector<HTMLElement>(`[data-view-player="${CSS.escape(playerId)}"] b`);
    if (label) label.textContent = `${count} loose`;
  }

  function editSnapshot(): EditSnapshot {
    return {
      positions: tiles.map(tile => ({ id: tile.id, x: tile.x, y: tile.y })),
      rackOrder: [...rackOrder],
      selectedId,
      selectedIds: [...selectedIds],
    };
  }

  function snapshotsMatch(a: EditSnapshot, b: EditSnapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function updateHistoryButtons(): void {
    const editable = canEditTiles();
    undoButton.disabled = !editable || undoStack.length === 0;
    redoButton.disabled = !editable || redoStack.length === 0;
  }

  function recordEdit(before: EditSnapshot): void {
    if (snapshotsMatch(before, editSnapshot())) return;
    undoStack.push(before);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function restoreEdit(snapshot: EditSnapshot): void {
    const positions = new Map(snapshot.positions.map(position => [position.id, position]));
    for (const tile of tiles) {
      const position = positions.get(tile.id);
      if (!position) continue;
      tile.x = position.x;
      tile.y = position.y;
    }
    const validIds = tiles.map(tile => tile.id);
    const valid = new Set(validIds);
    rackOrder = snapshot.rackOrder.map(id => id && valid.has(id) ? id : null);
    addRackTiles(validIds.filter(id => !rackOrder.includes(id)));
    selectedIds.clear();
    snapshot.selectedIds.filter(id => valid.has(id)).forEach(id => selectedIds.add(id));
    selectedId = snapshot.selectedId && valid.has(snapshot.selectedId) ? snapshot.selectedId : null;
    sendOwnLayout();
    renderTiles();
  }

  function clearEditHistory(): void {
    undoStack.length = 0;
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function addRackTiles(ids: string[]): void {
    for (const id of ids) {
      if (rackOrder.includes(id)) continue;
      const empty = rackOrder.findIndex(value => value == null || tiles.find(tile => tile.id === value)?.x != null);
      if (empty < 0) rackOrder.push(id);
      else rackOrder[empty] = id;
    }
  }

  function syncRackOrder(validIds: string[]): void {
    const valid = new Set(validIds);
    rackOrder = rackOrder.map(id => id && valid.has(id) ? id : null);
    addRackTiles(validIds.filter(id => !rackOrder.includes(id)));
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

  function reorderRack(tileId: string, clientX: number, clientY: number): boolean {
    const tile = tiles.find(value => value.id === tileId);
    if (!tile) return false;
    let sourceIndex = rackOrder.indexOf(tileId);
    if (sourceIndex < 0) {
      addRackTiles([tileId]);
      sourceIndex = rackOrder.indexOf(tileId);
    }
    const slots = [...rack.querySelectorAll<HTMLElement>('[data-rack-index]')];
    const targetSlot = slots.reduce<HTMLElement | null>((closest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      if (pointInRect(clientX, clientY, rect)) return candidate;
      if (!closest) return candidate;
      const closestRect = closest.getBoundingClientRect();
      const distance = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
      const closestDistance = Math.hypot(clientX - (closestRect.left + closestRect.width / 2), clientY - (closestRect.top + closestRect.height / 2));
      return distance < closestDistance ? candidate : closest;
    }, null);
    const targetIndex = Number(targetSlot?.dataset.rackIndex ?? -1);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;
    const targetId = rackOrder[targetIndex];
    const targetTile = targetId ? tiles.find(value => value.id === targetId) : undefined;
    if (!targetId || (targetTile && targetTile.x != null && targetTile.y != null)) {
      [rackOrder[sourceIndex], rackOrder[targetIndex]] = [rackOrder[targetIndex], rackOrder[sourceIndex]];
      return true;
    }
    const emptyIndex = rackOrder.findIndex(value => value == null || tiles.find(candidate => candidate.id === value)?.x != null);
    if (emptyIndex >= 0) rackOrder[emptyIndex] = null;
    rackOrder.splice(sourceIndex, 1);
    rackOrder.splice(targetIndex, 0, tileId);
    return true;
  }

  function clearSelection(): void {
    selectedIds.clear();
    selectedId = null;
    root.querySelectorAll('.letter-tile.is-selected').forEach(element => element.classList.remove('is-selected'));
    boardLayer.querySelectorAll('.autofill-arrow').forEach(element => element.remove());
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

  function wordValidity(values: PlacedTile[], rotation = 0): Map<string, 'valid' | 'partial' | 'invalid'> {
    const result = new Map<string, 'valid' | 'partial' | 'invalid'>();
    if (!state || loadedDictionary !== state.dictionary) return result;
    const scores = new Map<string, { valid: number; invalid: number }>();
    for (const word of findWords(values, rotation)) {
      for (const id of word.tileIds) {
        const score = scores.get(id) ?? { valid: 0, invalid: 0 };
        if (dictionaryWords.has(word.text)) score.valid++;
        else score.invalid++;
        scores.set(id, score);
      }
    }
    for (const tile of values) {
      const score = scores.get(tile.id);
      result.set(tile.id, !score || score.valid === 0 ? 'invalid' : score.invalid === 0 ? 'valid' : 'partial');
    }
    return result;
  }

  function allWordsValid(values: PlacedTile[]): boolean {
    if (!state || loadedDictionary !== state.dictionary) return false;
    const myIndex = state.players.findIndex(player => player.id === myId);
    const rotation = areaFor(state.players[myIndex], myIndex, state.players.length)?.rotation ?? 0;
    const validity = wordValidity(values, rotation);
    return validity.size === values.length && [...validity.values()].every(status => status === 'valid');
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

  function applyCamera(animate = false): void {
    if (cameraAnimationTimer != null) window.clearTimeout(cameraAnimationTimer);
    cameraAnimationTimer = null;
    boardLayer.classList.toggle('is-camera-animating', animate);
    if (animate) void boardLayer.offsetWidth;
    boardLayer.style.transform = `translate(${camera.x}px, ${camera.y}px) rotate(${camera.rotation}rad) scale(${camera.scale})`;
    if (animate) cameraAnimationTimer = window.setTimeout(() => {
      boardLayer.classList.remove('is-camera-animating');
      cameraAnimationTimer = null;
    }, 450);
  }

  function updatePlayerScrollFades(): void {
    const overflow = players.scrollWidth - players.clientWidth;
    playerScroll.classList.toggle('can-scroll-left', players.scrollLeft > 2);
    playerScroll.classList.toggle('can-scroll-right', overflow > 2 && players.scrollLeft < overflow - 2);
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

  function focusPlayer(playerId: string, animate = true): void {
    if (!state) return;
    const playerIndex = state.players.findIndex(player => player.id === playerId);
    if (playerIndex < 0) return;
    const player = state.players[playerIndex];
    const area = areaFor(player, playerIndex, state.players.length);
    const rotation = -(area?.rotation ?? 0);
    const placed = player.id === myId ? boardPayload() : player.board;
    const validTileIds = new Set(findWords(placed, area?.rotation ?? 0)
      .filter(word => dictionaryWords.has(word.text))
      .flatMap(word => word.tileIds));
    const validTiles = placed.filter(tile => validTileIds.has(tile.id));
    const framing = validTiles.length ? validTiles : placed;
    const rect = board.getBoundingClientRect();

    if (!framing.length) {
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const centerX = (area?.x ?? 0) * TILE;
      const centerY = (area?.y ?? 0) * TILE;
      const scale = clamp(Math.min(rect.width / (PLAYER_AREA_WIDTH * TILE), rect.height / (PLAYER_AREA_HEIGHT * TILE)) * .88, MIN_SCALE, 1);
      camera = {
        rotation,
        scale,
        x: -(centerX * cosine - centerY * sine) * scale,
        y: -(centerX * sine + centerY * cosine) * scale,
      };
    } else {
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const points = framing.map(tile => {
        const x = tile.x * TILE;
        const y = tile.y * TILE;
        return { x: x * cosine - y * sine, y: x * sine + y * cosine };
      });
      const minX = Math.min(...points.map(point => point.x)) - TILE * .7;
      const maxX = Math.max(...points.map(point => point.x)) + TILE * .7;
      const minY = Math.min(...points.map(point => point.y)) - TILE * .7;
      const maxY = Math.max(...points.map(point => point.y)) + TILE * .7;
      const scale = clamp(Math.min((rect.width - 48) / (maxX - minX), (rect.height - 48) / (maxY - minY)), MIN_SCALE, 1.8);
      camera = {
        rotation,
        scale,
        x: -((minX + maxX) / 2) * scale,
        y: -((minY + maxY) / 2) * scale,
      };
    }
    viewingPlayerId = playerId;
    players.querySelectorAll<HTMLElement>('[data-view-player]').forEach(chip => {
      chip.classList.toggle('is-viewing', chip.dataset.viewPlayer === playerId);
    });
    applyCamera(animate);
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

  function gestureFromTouches(touches: TouchList, ids?: [number, number]): { ids: [number, number]; center: Point; distance: number; angle: number } | null {
    const values = Array.from(touches);
    const pair = ids
      ? ids.map(id => values.find(touch => touch.identifier === id))
      : values.slice(0, 2);
    const [a, b] = pair;
    if (!a || !b) return null;
    return {
      ids: [a.identifier, b.identifier],
      center: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      distance: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
      angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX),
    };
  }

  function applyTouchGesture(current: { center: Point; distance: number; angle: number }): void {
    if (!touchGesture) return;
    const rect = board.getBoundingClientRect();
    const scale = clamp(touchGesture.camera.scale * current.distance / touchGesture.distance, MIN_SCALE, MAX_SCALE);
    const rotation = touchGesture.camera.rotation + current.angle - touchGesture.angle;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    camera.scale = scale;
    camera.rotation = rotation;
    camera.x = current.center.x - rect.left - rect.width / 2
      - (touchGesture.world.x * cosine - touchGesture.world.y * sine) * scale;
    camera.y = current.center.y - rect.top - rect.height / 2
      - (touchGesture.world.x * sine + touchGesture.world.y * cosine) * scale;
    applyCamera();
  }

  function resetPointerGesture(): void {
    for (const pointerId of pointers.keys()) {
      try {
        if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
      } catch {}
    }
    pointers.clear();
    gesture = null;
    canvasPress = null;
    lastCanvasTap = null;
    board.classList.remove('is-panning');
  }

  function finishMarquee(clear = false): void {
    if (!marquee) return;
    try {
      if (board.hasPointerCapture(marquee.pointerId)) board.releasePointerCapture(marquee.pointerId);
    } catch {}
    marquee.element.remove();
    marquee = null;
    board.classList.remove('is-selecting');
    if (clear) clearSelection();
    else {
      selectedId = [...selectedIds].at(-1) ?? null;
      dump.disabled = !selectedId || (state?.bunch ?? 0) < 3 || state?.phase !== 'playing';
    }
  }

  function beginMarquee(event: PointerEvent): void {
    clearSelection();
    const element = document.createElement('div');
    element.className = 'selection-marquee';
    board.append(element);
    marquee = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
      element,
    };
    board.setPointerCapture(event.pointerId);
    board.classList.add('is-selecting');
  }

  function updateMarquee(event: PointerEvent): void {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    marquee.current = { x: event.clientX, y: event.clientY };
    const boardRect = board.getBoundingClientRect();
    const left = Math.max(boardRect.left, Math.min(marquee.start.x, marquee.current.x));
    const right = Math.min(boardRect.right, Math.max(marquee.start.x, marquee.current.x));
    const top = Math.max(boardRect.top, Math.min(marquee.start.y, marquee.current.y));
    const bottom = Math.min(boardRect.bottom, Math.max(marquee.start.y, marquee.current.y));
    marquee.element.style.left = `${left - boardRect.left}px`;
    marquee.element.style.top = `${top - boardRect.top}px`;
    marquee.element.style.width = `${Math.max(0, right - left)}px`;
    marquee.element.style.height = `${Math.max(0, bottom - top)}px`;
    selectedIds.clear();
    boardLayer.querySelectorAll<HTMLElement>(':scope > .letter-tile').forEach(element => {
      const id = element.dataset.id;
      const tile = id ? tiles.find(candidate => candidate.id === id && candidate.x != null && candidate.y != null) : undefined;
      const rect = element.getBoundingClientRect();
      const selected = !!tile && rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      element.classList.toggle('is-selected', selected);
      if (selected && id) selectedIds.add(id);
    });
    selectedId = [...selectedIds].at(-1) ?? null;
    dump.disabled = !selectedId || (state?.bunch ?? 0) < 3 || state?.phase !== 'playing';
  }

  function resetAllGestures(): void {
    cancelDrag();
    finishMarquee(true);
    resetPointerGesture();
    nativeGesture = null;
    touchGesture = null;
  }

  nameForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = sanitizeName(nameInput.value);
    if (!name) return nameInput.focus();
    const creating = !roomName;
    if (!roomName) {
      roomName = createRoomName();
      const url = new URL(location.href);
      url.searchParams.set('room', roomName);
      history.replaceState(null, '', url);
      roomLabels.forEach(label => { label.textContent = roomName; });
      roomNote.textContent = `Private room ${roomName} · 2–8 players`;
    }
    localStorage.setItem('tiles-name', name);
    setButtonLoading(enterLobby, true, creating ? 'Creating…' : 'Joining…');
    connectOnline(name);
  });
  savedGameList.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const open = target.closest<HTMLButtonElement>('[data-saved-kind]');
    if (open?.dataset.savedKind === 'local' && open.dataset.savedName) {
      open.setAttribute('aria-busy', 'true');
      savedGameList.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
      const title = open.querySelector('strong');
      if (title) title.textContent = 'Loading local game…';
      void continueLocalGame(sanitizeName(open.dataset.savedName), open.dataset.savedRole === 'participant' ? 'participant' : 'host');
      return;
    }
    if (open?.dataset.savedRoom && open.dataset.savedName) {
      open.setAttribute('aria-busy', 'true');
      const savedRoom = sanitizeRoom(open.dataset.savedRoom);
      const savedName = sanitizeName(open.dataset.savedName);
      if (!savedRoom || !savedName) return;
      roomName = savedRoom;
      nameInput.value = savedName;
      localStorage.setItem('tiles-name', savedName);
      const url = new URL(location.href);
      url.searchParams.set('room', savedRoom);
      history.replaceState(null, '', url);
      roomLabels.forEach(label => { label.textContent = savedRoom; });
      roomNote.textContent = `Private room ${savedRoom} · reconnecting…`;
      savedGameList.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
      const title = open.querySelector('strong');
      if (title) title.textContent = 'Loading saved game…';
      enterLobby.disabled = true;
      connectOnline(savedName);
      return;
    }
    const forgetLocal = target.closest<HTMLButtonElement>('[data-forget-local]');
    if (forgetLocal) {
      localStorage.removeItem(LOCAL_GAME_KEY);
      localStorage.removeItem(LOCAL_SESSION_KEY);
      localStorage.removeItem('tiles-session:nearby');
      renderSavedGames();
      return;
    }
    const forget = target.closest<HTMLButtonElement>('[data-forget-room]');
    if (!forget?.dataset.forgetRoom) return;
    const forgottenRoom = forget.dataset.forgetRoom;
    writeSavedGames(readSavedGames().filter(record => record.room !== forgottenRoom));
    localStorage.removeItem(`tiles-session:${forgottenRoom}`);
    renderSavedGames();
  });
  nearbyStartButton.addEventListener('click', () => { void startSelectedLocalGame(); });
  const handleReinviteClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-reinvite-player]');
    if (button?.dataset.reinvitePlayer) void reinviteNearbyPlayer(button.dataset.reinvitePlayer);
  };
  roster.addEventListener('click', handleReinviteClick);
  playerDisconnect.addEventListener('click', handleReinviteClick);
  inviteAccept.addEventListener('click', () => { void answerNearbyInvitation(true); });
  inviteDecline.addEventListener('click', () => { void answerNearbyInvitation(false); });
  inviteDialog.addEventListener('cancel', event => {
    event.preventDefault();
    void answerNearbyInvitation(false);
  });
  async function commitNameChange(): Promise<void> {
    const name = sanitizeName(nameInput.value);
    if (!name) return;
    const previousName = sanitizeName(localStorage.getItem('tiles-name'));
    localStorage.setItem('tiles-name', name);
    if (name === previousName || state || !isNativeNearby()) return;
    if (connectionMode === 'nearby-home' || nearbyHomeRestart) await restartNearbyHome();
    else void startNearbyHome();
  }
  nameInput.addEventListener('input', () => {
    updateHomeReadiness();
    if (nameChangeTimer != null) window.clearTimeout(nameChangeTimer);
    nameChangeTimer = window.setTimeout(() => {
      nameChangeTimer = null;
      void commitNameChange();
    }, 500);
  });
  dictionarySelect.addEventListener('change', () => {
    const dictionary = dictionarySelect.value as DictionaryId;
    if (isDictionaryId(dictionary)) send({ t: 'dictionary', dictionary });
  });
  start.addEventListener('click', () => {
    setButtonLoading(start, true, 'Starting…');
    send({ t: 'start' });
  });
  chatForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = chatInput.value.replace(/\s+/g, ' ').trim();
    if (!text || state?.phase !== 'lobby') return;
    setButtonLoading(chatSend, true, 'Sending…');
    chatInput.value = '';
    const messageId = crypto.randomUUID();
    pendingChatMessages.set(messageId, { text, attempts: 0, timer: null });
    transmitPendingChat(messageId);
    window.setTimeout(() => setButtonLoading(chatSend, false), 3_000);
  });
  copyLink.addEventListener('click', async () => {
    setButtonLoading(copyLink, true, 'Copying…');
    await copyGameLink();
    setButtonLoading(copyLink, false);
  });
  share.addEventListener('click', async () => {
    setButtonLoading(share, true, 'Sharing…');
    const data = {
      title: 'Join my Tiles game',
      text: 'Join my private Tiles lobby.',
      url: location.href,
    };
    try {
      if (navigator.share) await navigator.share(data);
      else await copyGameLink();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) await copyGameLink();
    } finally {
      setButtonLoading(share, false);
    }
  });

  board.addEventListener('pointerdown', event => {
    if (touchGesture) return;
    if ((event.target as HTMLElement).closest('.letter-tile, [data-board-controls]')) return;
    if (marquee && marquee.pointerId !== event.pointerId) {
      const first = marquee;
      finishMarquee(true);
      pointers.clear();
      pointers.set(first.pointerId, first.current);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { board.setPointerCapture(first.pointerId); } catch {}
      board.setPointerCapture(event.pointerId);
      board.classList.add('is-panning');
      const current = gestureFromPointers();
      if (current) gesture = { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) };
      lastCanvasTap = null;
      event.preventDefault();
      return;
    }
    if (pointers.has(event.pointerId)) return;
    const doubleTap = !pointers.size && !!lastCanvasTap && performance.now() - lastCanvasTap.at < 420
      && Math.hypot(event.clientX - lastCanvasTap.x, event.clientY - lastCanvasTap.y) < 36;
    if (doubleTap && canEditTiles()) {
      lastCanvasTap = null;
      canvasPress = null;
      beginMarquee(event);
      event.preventDefault();
      return;
    }
    if (!pointers.size) {
      nativeGesture = null;
      canvasPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    board.setPointerCapture(event.pointerId);
    board.classList.add('is-panning');
    const current = gestureFromPointers();
    if (current) {
      canvasPress = null;
      lastCanvasTap = null;
    }
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
    if (current) {
      canvasPress = null;
      lastCanvasTap = null;
      gesture = { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) };
    }
    event.preventDefault();
  }, { capture: true });
  board.addEventListener('pointermove', event => {
    if (touchGesture) return;
    if (marquee?.pointerId === event.pointerId) {
      updateMarquee(event);
      event.preventDefault();
      return;
    }
    if (!pointers.has(event.pointerId) || !gesture) return;
    if (canvasPress?.pointerId === event.pointerId
      && Math.hypot(event.clientX - canvasPress.x, event.clientY - canvasPress.y) > 8) canvasPress.moved = true;
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
    if (marquee?.pointerId === event.pointerId) {
      finishMarquee(event.type === 'pointercancel');
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    if (canvasPress?.pointerId === event.pointerId) {
      if (!canvasPress.moved && event.type !== 'pointercancel') {
        lastCanvasTap = { x: event.clientX, y: event.clientY, at: performance.now() };
        clearSelection();
      } else lastCanvasTap = null;
      canvasPress = null;
    }
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
    if (touchGesture) return;
    cancelDrag();
    finishMarquee(true);
    resetPointerGesture();
    const rect = board.getBoundingClientRect();
    nativeGesture = {
      camera: { ...camera },
      x: event.clientX || rect.left + rect.width / 2,
      y: event.clientY || rect.top + rect.height / 2,
    };
  }, { passive: false });
  root.addEventListener('touchstart', event => {
    if (event.touches.length < 2) return;
    if (touchGesture) {
      event.preventDefault();
      return;
    }
    const initial = gestureFromTouches(event.touches);
    if (!initial) return;
    const rect = board.getBoundingClientRect();
    const touchesBoard = Array.from(event.touches).some(touch => pointInRect(touch.clientX, touch.clientY, rect));
    if (!touchesBoard && !dragging?.wasPlaced && !gesture && !marquee) return;
    event.preventDefault();
    cancelDrag();
    finishMarquee(false);
    resetPointerGesture();
    nativeGesture = null;
    const gestureCamera = { ...camera };
    touchGesture = {
      ...initial,
      camera: gestureCamera,
      world: screenToWorldFor(initial.center.x, initial.center.y, gestureCamera),
    };
    board.classList.add('is-panning');
  }, { capture: true, passive: false });
  root.addEventListener('touchmove', event => {
    if (!touchGesture) return;
    const current = gestureFromTouches(event.touches, touchGesture.ids);
    if (!current) return;
    event.preventDefault();
    applyTouchGesture(current);
  }, { capture: true, passive: false });
  const endTouchGesture = (event: TouchEvent) => {
    if (!touchGesture) return;
    const current = gestureFromTouches(event.touches, touchGesture.ids);
    if (current) return;
    event.preventDefault();
    touchGesture = null;
    resetPointerGesture();
  };
  root.addEventListener('touchend', endTouchGesture, { capture: true, passive: false });
  root.addEventListener('touchcancel', endTouchGesture, { capture: true, passive: false });
  board.addEventListener('gesturechange', raw => {
    const event = raw as Event & { scale?: number; rotation?: number };
    if (touchGesture) {
      event.preventDefault();
      return;
    }
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
    if (touchGesture) return;
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
  players.addEventListener('click', event => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-view-player]');
    if (chip?.dataset.viewPlayer) focusPlayer(chip.dataset.viewPlayer);
  });
  players.addEventListener('scroll', updatePlayerScrollFades, { passive: true });
  fillDirection.addEventListener('click', () => {
    autoFillDirection = autoFillDirection === 'right' ? 'down' : 'right';
    updateFillDirectionButton();
    renderTiles();
  });
  flipWordButton.addEventListener('click', flipSelectedWord);
  randomiseButton.addEventListener('click', randomiseRack);
  undoButton.addEventListener('click', () => {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(editSnapshot());
    restoreEdit(previous);
  });
  redoButton.addEventListener('click', () => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(editSnapshot());
    restoreEdit(next);
  });
  dump.addEventListener('click', () => {
    if (selectedId) {
      setButtonLoading(dump, true, 'Dumping…');
      send({ t: 'dump', tileId: selectedId });
    }
  });
  gameMenuOpen.addEventListener('click', () => gameMenu.showModal());
  gameMenuClose.addEventListener('click', () => gameMenu.close());
  bugReport.addEventListener('click', () => { void saveBugReport(); });
  newGame.addEventListener('click', () => {
    if (!state || myId !== state.hostId || state.players.length < 2) return;
    setButtonLoading(newGame, true, 'Starting new game…');
    send({ t: 'new-game' });
    gameMenu.close();
  });
  async function leaveToHome(forgetLobby: boolean): Promise<void> {
    const leavingRoom = roomName;
    connectionMode = null;
    stopOnlineTransport();
    clearNearbyReconnectTimer();
    clearNearbyConnectionAttemptTimer();
    clearNearbyHelloTimer();
    clearNearbyHomeRefreshTimer();
    clearAllNearbyChannels();
    transportSend = null;
    localHost = null;
    nearbyInviteStates.clear();
    outgoingNearbyInvites.clear();
    approvedNearbyNames.clear();
    pendingReinviteNames.clear();
    nearbyHostId = null;
    nearbyHostName = '';
    nearbyAutoReconnect = false;
    nearbyConnectingId = null;
    state = null;
    connectionRestored();
    if (isNativeNearby()) await NearbyConnections.stop().catch(() => undefined);
    if (forgetLobby && leavingRoom) {
      localStorage.removeItem(`tiles-session:${leavingRoom}`);
      writeSavedGames(readSavedGames().filter(record => record.room !== leavingRoom));
      if (leavingRoom === 'nearby') {
        localStorage.removeItem(LOCAL_GAME_KEY);
        localStorage.removeItem(LOCAL_SESSION_KEY);
      }
    }
    location.assign(import.meta.env.BASE_URL);
  }
  lobbyBack.addEventListener('click', () => {
    setButtonLoading(lobbyBack, true, 'Leaving…');
    void leaveToHome(false);
  });
  goHome.addEventListener('click', () => {
    setButtonLoading(goHome, true, 'Leaving…');
    void leaveToHome(false);
  });
  (window as typeof window & { tilesHandleNativeBack?: () => boolean }).tilesHandleNativeBack = () => {
    if (inviteDialog.open) {
      inviteDialog.close();
      return true;
    }
    if (gameMenu.open) {
      gameMenu.close();
      return true;
    }
    if (!lobby.hidden || !game.hidden) {
      void leaveToHome(false);
      return true;
    }
    return false;
  };
  async function retryCurrentConnection(button: HTMLButtonElement): Promise<void> {
    setButtonLoading(button, true, 'Retrying…');
    if (connectionMode === 'online' && onlineName) {
      connectionMessage.textContent = 'Reconnecting…';
      lobbyConnectionMessage.textContent = 'Reconnecting…';
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connectOnline(onlineName);
      return;
    }
    if (connectionMode === 'nearby-join') {
      connectionMessage.textContent = 'Reconnecting to the nearby host…';
      lobbyConnectionMessage.textContent = 'Reconnecting to the nearby host…';
      nearbyAutoReconnect = true;
      nearbyConnectingId = null;
      clearNearbyReconnectTimer();
      await resumeNearbyTransport();
      button.disabled = false;
    }
  }
  retryConnection.addEventListener('click', () => { void retryCurrentConnection(retryConnection); });
  lobbyRetryConnection.addEventListener('click', () => { void retryCurrentConnection(lobbyRetryConnection); });
  window.addEventListener('resize', () => {
    applyCamera();
    updatePlayerScrollFades();
  });
  window.setInterval(() => {
    if (connectionMode === 'online') send({ t: 'ping' });
  }, 25_000);
  window.setInterval(() => {
    if (localHost && state) localHost.heartbeat();
  }, 4_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isNativeNearby() && (connectionMode === 'nearby-host' || connectionMode === 'nearby-join')) {
        nearbySuspended = true;
        diagnose('app-backgrounded', { connectionMode });
        void NearbyConnections.stop().catch(error => diagnose('background-stop-failed', nearbyErrorDetail(error)));
      }
      return;
    }
    flushChatReadReceipts();
    if (nearbySuspended) {
      nearbySuspended = false;
      diagnose('app-foregrounded', { connectionMode });
      void resumeNearbyTransport();
      return;
    }
    if (connectionMode === 'nearby-home') {
      void startNearbyHome();
    } else if ((connectionMode === 'nearby-host' && state?.players.some(player => player.connected === false))
      || (connectionMode === 'nearby-join' && !nearbyHostId)) {
      clearNearbyReconnectTimer();
      void resumeNearbyTransport();
    }
  });
  const storedPlayerColor = localStorage.getItem('tiles-color');
  const initialPlayerColor = storedPlayerColor && (PLAYER_COLORS as readonly string[]).includes(storedPlayerColor)
    ? storedPlayerColor
    : PLAYER_COLORS[crypto.getRandomValues(new Uint8Array(1))[0] % PLAYER_COLORS.length];
  localStorage.setItem('tiles-color', initialPlayerColor);
  selectPlayerColor(initialPlayerColor);
  colorInputs.forEach(input => input.addEventListener('change', () => {
    if (!input.checked) return;
    const color = sanitizePlayerColor(input.value);
    selectPlayerColor(color);
    localStorage.setItem('tiles-color', color);
    if (state?.phase === 'lobby') send({ t: 'color', color });
    else if (connectionMode === 'nearby-home' || nearbyHomeRestart) void restartNearbyHome();
  }));
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
    if (Capacitor.isNativePlatform()) {
      // Native releases are updated through the installed app bundle. A PWA
      // worker can activate later and reload the WebView mid-game, which tears
      // down every Nearby endpoint on the host.
      void navigator.serviceWorker.getRegistrations()
        .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
        .catch(() => undefined);
      return;
    }
    const scopeUrl = new URL(import.meta.env.BASE_URL, location.origin);
    if (!scopeUrl.pathname.endsWith('/')) scopeUrl.pathname += '/';
    const workerUrl = new URL('sw.js', scopeUrl);
    let registration: ServiceWorkerRegistration | null = null;
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    updateNow.addEventListener('click', () => {
      updateNow.disabled = true;
      updateNow.textContent = 'Updating…';
      location.reload();
    });

    void navigator.serviceWorker.register(workerUrl, {
      scope: scopeUrl.pathname,
      updateViaCache: 'none',
    }).then(nextRegistration => {
      registration = nextRegistration;
      void nextRegistration.update();
      window.setInterval(() => void nextRegistration.update(), 60_000);
    }).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration?.update();
    });
    window.addEventListener('focus', () => void registration?.update());
  }
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
