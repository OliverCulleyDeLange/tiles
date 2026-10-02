import {
  PLAYER_AREA_HEIGHT,
  PLAYER_AREA_WIDTH,
  PROTOCOL_VERSION,
  createPlayerAreas,
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
import { NearbyConnections, isNativeNearby, type NearbyEndpoint, type NearbyVerification } from './nearby';
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

const DICTIONARY_FILES: Record<DictionaryId, string> = {
  'scowl-us': `${DICTIONARY_BASE}/scowl-us-60.txt${ANDROID_NATIVE ? '' : '.gz'}`,
  'scowl-gb': `${DICTIONARY_BASE}/scowl-gb-60.txt${ANDROID_NATIVE ? '' : '.gz'}`,
};

export function createTiles(root: HTMLElement): void {
  const nameGate = root.querySelector<HTMLElement>('[data-view="name"]')!;
  const lobby = root.querySelector<HTMLElement>('[data-view="lobby"]')!;
  const game = root.querySelector<HTMLElement>('[data-view="game"]')!;
  const nameForm = root.querySelector<HTMLFormElement>('[data-name-form]')!;
  const nameInput = root.querySelector<HTMLInputElement>('[data-name-input]')!;
  const enterLobby = root.querySelector<HTMLButtonElement>('[data-enter-lobby]')!;
  const roomNote = root.querySelector<HTMLElement>('[data-room-note]')!;
  const roster = root.querySelector<HTMLElement>('[data-roster]')!;
  const dictionarySelect = root.querySelector<HTMLSelectElement>('[data-dictionary]')!;
  const roomLabels = root.querySelectorAll<HTMLElement>('[data-room-label]');
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
  const bunch = root.querySelector<HTMLElement>('[data-bunch]')!;
  const peel = root.querySelector<HTMLElement>('[data-peel]')!;
  const players = root.querySelector<HTMLElement>('[data-players]')!;
  const rotateLeft = root.querySelector<HTMLButtonElement>('[data-rotate-left]')!;
  const rotateRight = root.querySelector<HTMLButtonElement>('[data-rotate-right]')!;
  const resetView = root.querySelector<HTMLButtonElement>('[data-reset-view]')!;
  const toast = root.querySelector<HTMLElement>('[data-toast]')!;
  const review = root.querySelector<HTMLDialogElement>('[data-review]')!;
  const reviewTitle = review.querySelector<HTMLElement>('[data-review-title]')!;
  const reviewBoard = review.querySelector<HTMLElement>('[data-review-board]')!;
  const reviewAccept = review.querySelector<HTMLButtonElement>('[data-review-accept]')!;
  const reviewRotten = review.querySelector<HTMLButtonElement>('[data-review-rotten]')!;
  const nearbyEntry = root.querySelector<HTMLElement>('[data-nearby-entry]')!;
  const nearbyHostButton = root.querySelector<HTMLButtonElement>('[data-nearby-host]')!;
  const nearbyJoinButton = root.querySelector<HTMLButtonElement>('[data-nearby-join]')!;
  const nearbyDialog = root.querySelector<HTMLDialogElement>('[data-nearby-dialog]')!;
  const nearbyTitle = root.querySelector<HTMLElement>('[data-nearby-title]')!;
  const nearbyStatus = root.querySelector<HTMLElement>('[data-nearby-status]')!;
  const nearbyEndpoints = root.querySelector<HTMLElement>('[data-nearby-endpoints]')!;
  const nearbyVerification = root.querySelector<HTMLElement>('[data-nearby-verification]')!;
  const nearbyCode = root.querySelector<HTMLElement>('[data-nearby-code]')!;
  const nearbyAccept = root.querySelector<HTMLButtonElement>('[data-nearby-accept]')!;
  const nearbyReject = root.querySelector<HTMLButtonElement>('[data-nearby-reject]')!;
  const nearbyClose = root.querySelector<HTMLButtonElement>('[data-nearby-close]')!;
  const updateNotice = root.querySelector<HTMLElement>('[data-update-notice]')!;
  const updateNow = root.querySelector<HTMLButtonElement>('[data-update-now]')!;

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

  let socket: WebSocket | null = null;
  let onlineName = '';
  let onlineReconnectEnabled = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let localHost: LocalRoomHost | null = null;
  let nearbyHostId: string | null = null;
  let pendingVerification: NearbyVerification | null = null;
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
    moved: boolean;
    wasPlaced: boolean;
    previousSelected: string | null;
    dragIds: string[];
    ghosts: Array<{ element: HTMLElement; dx: number; dy: number }>;
  } | null = null;
  let camera: Camera = { x: 0, y: 0, scale: 1, rotation: 0 };
  const pointers = new Map<number, Point>();
  let gesture: Gesture | null = null;
  let nativeGesture: { camera: Camera; x: number; y: number } | null = null;
  let toastTimer: number | null = null;

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

  async function loadDictionary(dictionary: DictionaryId): Promise<void> {
    if (loadedDictionary === dictionary || loadingDictionary === dictionary) return;
    loadingDictionary = dictionary;
    dictionaryWords = new Set();
    renderTiles();
    try {
      const response = await fetch(DICTIONARY_FILES[dictionary]);
      if (!response.ok) throw new Error(`Dictionary request failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const words = new TextDecoder().decode(ANDROID_NATIVE ? bytes : gunzipSync(bytes))
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
      root.dataset.connection = 'online';
      reconnectAttempt = 0;
      updateRoom(message.room);
    } else if (message.t === 'room') updateRoom(message.room);
    else if (message.t === 'hand') {
      if (message.replace) {
        const previous = new Map(tiles.map(tile => [tile.id, tile]));
        const restored = new Map((state?.players.find(player => player.id === myId)?.board ?? []).map(tile => [tile.id, tile]));
        tiles = message.tiles.map(tile => {
          const placed = previous.get(tile.id) ?? restored.get(tile.id);
          return { ...tile, x: placed?.x ?? null, y: placed?.y ?? null };
        });
      } else tiles.push(...message.tiles.map(tile => ({ ...tile, x: null, y: null })));
      selectedId = null;
      selectedIds.clear();
      renderTiles();
    } else if (message.t === 'toast') show(message.text, message.tone);
    else if (message.t === 'error') {
      show(message.message, 'bad');
      if (!myId) enterLobby.disabled = false;
    }
  }

  function connectOnline(name: string): void {
    onlineName = name;
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
      root.dataset.connection = 'offline';
      scheduleReconnect();
    });
  }

  function sessionKey(): string {
    return `tiles-session:${roomName}`;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer != null || !onlineReconnectEnabled || !onlineName) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt++, 5));
    show('Connection lost. Reconnecting…', 'plain');
    reconnectTimer = window.setTimeout(() => connectOnline(onlineName), delay);
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
    });
    await NearbyConnections.addListener('endpointLost', endpoint => {
      nearbyEndpointMap.delete(endpoint.endpointId);
      renderNearbyEndpoints();
    });
    await NearbyConnections.addListener('verificationRequired', verification => {
      pendingVerification = verification;
      nearbyTitle.textContent = `Connect with ${verification.name}?`;
      nearbyCode.textContent = verification.code;
      nearbyVerification.hidden = false;
      if (!nearbyDialog.open) nearbyDialog.showModal();
    });
    await NearbyConnections.addListener('connected', endpoint => {
      nearbyVerification.hidden = true;
      pendingVerification = null;
      if (localHost) {
        nearbyStatus.textContent = `${endpoint.name} connected.`;
        if (nearbyDialog.open) nearbyDialog.close();
        return;
      }
      nearbyHostId = endpoint.endpointId;
      transportSend = message => {
        void NearbyConnections.send({ endpointIds: [endpoint.endpointId], payload: JSON.stringify(message) });
      };
      if (nearbyDialog.open) nearbyDialog.close();
      send({ t: 'hello', v: PROTOCOL_VERSION, name: nearbyName });
    });
    await NearbyConnections.addListener('disconnected', endpoint => {
      if (localHost) localHost.disconnect(endpoint.endpointId);
      else if (nearbyHostId === endpoint.endpointId) {
        show('The nearby host disconnected.', 'bad');
        root.dataset.connection = 'offline';
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
      await NearbyConnections.startAdvertising({ name });
      onlineReconnectEnabled = false;
      socket?.close();
      roomName = 'nearby';
      roomLabels.forEach(label => { label.textContent = 'Nearby'; });
      onlineInvite.hidden = true;
      lobbyHelp.textContent = 'Friends can join from the nearby-play option. Keep Bluetooth and Wi-Fi enabled.';
      localHost = new LocalRoomHost((peerId, message) => {
        if (peerId === localPeerId) handleServerMessage(message);
        else void NearbyConnections.send({ endpointIds: [peerId], payload: JSON.stringify(message) });
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
      await NearbyConnections.startDiscovery({ name });
      onlineReconnectEnabled = false;
      socket?.close();
      localHost = null;
      nearbyHostId = null;
      onlineInvite.hidden = true;
      lobbyHelp.textContent = 'This game is connected directly to the nearby host—no internet or invite link needed.';
      nearbyEndpointMap.clear();
      nearbyTitle.textContent = 'Finding nearby games…';
      nearbyStatus.textContent = 'Keep Bluetooth and Wi-Fi enabled.';
      nearbyVerification.hidden = true;
      renderNearbyEndpoints();
      nearbyDialog.showModal();
    } catch {
      show('Nearby play needs Bluetooth, Wi-Fi and permission to find devices.', 'bad');
    }
  }

  function updateRoom(next: RoomSnapshot): void {
    const previousPhase = state?.phase;
    const dictionary = next.dictionary ?? 'scowl-us';
    state = next;
    state.dictionary = dictionary;
    bunch.textContent = String(next.bunch);
    peel.textContent = String(next.peel);
    roster.innerHTML = next.players.map(player =>
      `<li><span class="presence ${player.connected === false ? 'is-offline' : ''}" aria-hidden="true"></span><strong>${escapeHtml(player.name)}</strong>${player.connected === false ? '<em>Reconnecting</em>' : player.id === next.hostId ? '<em>Host</em>' : ''}</li>`
    ).join('');
    players.innerHTML = next.players.map((player, index) =>
      `<li><span class="player-chip ${player.id === myId ? 'is-you' : ''} ${player.eliminated ? 'is-out' : ''}" style="--owner-color:${ownerColor(index)}"><i></i><span>${escapeHtml(player.name)}</span><b>${player.eliminated ? 'OUT' : `${player.tilesLeft} loose`}</b></span></li>`
    ).join('');
    start.hidden = myId !== next.hostId;
    start.disabled = next.players.length < 2;
    start.textContent = next.players.length < 2 ? 'Waiting for an opponent…' : `Start with ${next.players.length} players`;
    dictionarySelect.value = dictionary;
    dictionarySelect.disabled = myId !== next.hostId || next.phase !== 'lobby';
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
      review.close?.();
    }
    if (!dragging) syncOwnBoard(next);
    if (next.phase === 'review' && next.reviewBoard && next.claimantId) openReview(next);
    if (next.phase === 'finished' && next.winnerId) {
      const winner = next.players.find(player => player.id === next.winnerId);
      show(winner?.id === myId ? 'You are Top Banana!' : `${winner?.name ?? 'A player'} wins!`, 'good');
      if (review.open) review.close();
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
        const element = makeTile(tile, player, color, isMine, area?.rotation ?? 0, validity.get(tile.id));
        positionTile(element, position.x, position.y);
        boardLayer.append(element);
      }
    }

    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const me = state?.players.find(player => player.id === myId);
    for (const tile of tiles.filter(value => value.x == null || value.y == null)) {
      rack.append(makeTile(tile, me, ownerColor(Math.max(0, myIndex)), true, 0));
    }
    dump.disabled = !selectedId || (state?.bunch ?? 0) < 3 || state?.phase !== 'playing';
    maybePeel();
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
    if (state?.phase !== 'playing') return;
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const wasPlaced = tile.x != null && tile.y != null;
    const previousSelected = selectedId;
    const rect = target.getBoundingClientRect();
    dragging = {
      id: tile.id,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      wasPlaced,
      previousSelected,
      dragIds: [],
      ghosts: [],
    };
    target.setPointerCapture(event.pointerId);
    target.addEventListener('pointermove', moveDrag);
    target.addEventListener('pointerup', endDrag, { once: true });
    target.addEventListener('pointercancel', endDrag, { once: true });
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragging) return;
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
      dragging = null;
      if (tile && interaction.wasPlaced) toggleSelection(tile.id);
      else if (tile) addTappedTile(tile, interaction.previousSelected);
      renderTiles();
      return;
    }
    const rect = board.getBoundingClientRect();
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
      }
    } else if (tile && interaction.dragIds.length) {
      for (const id of interaction.dragIds) {
        const value = tiles.find(candidate => candidate.id === id);
        if (value) { value.x = null; value.y = null; }
      }
      selectedIds.clear();
      selectedId = null;
    }
    dragging = null;
    interaction.ghosts.forEach(ghost => ghost.element.remove());
    send({ t: 'layout', board: boardPayload() });
    renderTiles();
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

  function addTappedTile(tile: LocalTile, anchorId: string | null): void {
    const myIndex = state?.players.findIndex(player => player.id === myId) ?? 0;
    const area = areaFor(state?.players[myIndex], myIndex, state?.players.length ?? 1);
    const placed = boardPayload();
    if (!placed.length) {
      tile.x = Math.round(area?.x ?? 0);
      tile.y = Math.round(area?.y ?? 0);
      selectedIds.clear();
      selectedIds.add(tile.id);
      selectedId = tile.id;
      send({ t: 'layout', board: boardPayload() });
      return;
    }

    const anchor = tiles.find(value => value.id === anchorId && value.x != null && value.y != null);
    if (!anchor || anchor.x == null || anchor.y == null) {
      show('Select a tile on the board first.', 'plain');
      return;
    }
    const anchorX = anchor.x;
    const anchorY = anchor.y;

    const at = new Map(placed.map(value => [`${value.x},${value.y}`, value]));
    const rotation = area?.rotation ?? 0;
    const rightX = Math.round(Math.cos(rotation));
    const rightY = Math.round(Math.sin(rotation));
    const downX = -rightY;
    const downY = rightX;
    const verticalRun = axisRun(anchorX, anchorY, downX, downY, at);
    const followDown = verticalRun.length >= 2;
    const stepX = followDown ? downX : rightX;
    const stepY = followDown ? downY : rightY;
    const run = followDown ? verticalRun : axisRun(anchorX, anchorY, rightX, rightY, at);
    const end = run.at(-1);
    const targetX = (end?.x ?? anchorX) + stepX;
    const targetY = (end?.y ?? anchorY) + stepY;
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
    send({ t: 'layout', board: boardPayload() });
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

  function openReview(room: RoomSnapshot): void {
    const claimant = room.players.find(player => player.id === room.claimantId);
    reviewTitle.textContent = room.claimantId === myId ? 'Your grid is under review' : `${claimant?.name ?? 'A player'} called BANANAS!`;
    reviewBoard.innerHTML = '';
    const values = room.reviewBoard ?? [];
    if (values.length) {
      const minX = Math.min(...values.map(tile => tile.x));
      const minY = Math.min(...values.map(tile => tile.y));
      for (const tile of values) {
        const element = document.createElement('span');
        element.textContent = tile.letter;
        element.style.gridColumn = String(tile.x - minX + 1);
        element.style.gridRow = String(tile.y - minY + 1);
        reviewBoard.append(element);
      }
    }
    const canVote = room.claimantId !== myId;
    reviewAccept.hidden = !canVote;
    reviewRotten.hidden = !canVote;
    if (!review.open) review.showModal();
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
  nearbyHostButton.addEventListener('click', () => { void hostNearby(); });
  nearbyJoinButton.addEventListener('click', () => { void joinNearby(); });
  nearbyAccept.addEventListener('click', () => {
    if (pendingVerification) void NearbyConnections.acceptVerification({ endpointId: pendingVerification.endpointId, accept: true });
  });
  nearbyReject.addEventListener('click', () => {
    if (pendingVerification) void NearbyConnections.acceptVerification({ endpointId: pendingVerification.endpointId, accept: false });
    pendingVerification = null;
    nearbyVerification.hidden = true;
  });
  nearbyClose.addEventListener('click', () => nearbyDialog.close());
  dictionarySelect.addEventListener('change', () => {
    const dictionary = dictionarySelect.value as DictionaryId;
    if (dictionary === 'scowl-us' || dictionary === 'scowl-gb') send({ t: 'dictionary', dictionary });
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
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    board.setPointerCapture(event.pointerId);
    board.classList.add('is-panning');
    const current = gestureFromPointers();
    gesture = current ? { ...current, camera: { ...camera }, world: screenToWorld(current.center.x, current.center.y) } : {
      center: { x: event.clientX, y: event.clientY }, distance: 0, angle: 0, camera: { ...camera }, rotate: event.shiftKey || event.altKey,
    };
  });
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
  board.addEventListener('pointerup', endGesture);
  board.addEventListener('pointercancel', endGesture);
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
  board.addEventListener('gestureend', () => { nativeGesture = null; });
  board.addEventListener('dblclick', () => {
    camera = { x: 0, y: 0, scale: 1, rotation: 0 };
    applyCamera();
  });
  rotateLeft.addEventListener('click', () => {
    const rect = board.getBoundingClientRect();
    transformAt(camera.scale, camera.rotation - Math.PI / 12, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  rotateRight.addEventListener('click', () => {
    const rect = board.getBoundingClientRect();
    transformAt(camera.scale, camera.rotation + Math.PI / 12, rect.left + rect.width / 2, rect.top + rect.height / 2);
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
  reviewAccept.addEventListener('click', () => send({ t: 'review', rotten: false }));
  reviewRotten.addEventListener('click', () => send({ t: 'review', rotten: true }));
  window.addEventListener('resize', applyCamera);
  window.setInterval(() => send({ t: 'ping' }), 25_000);
  initializeUpdates();
  void initializeNearby();
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
