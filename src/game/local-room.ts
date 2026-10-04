import {
  MAX_PLAYERS,
  createPlayerAreas,
  isDictionaryId,
  sanitizeBoard,
  sanitizeChatId,
  sanitizeChatText,
  sanitizeLayout,
  sanitizeName,
  sanitizePlayerColor,
  type ClientMessage,
  type DictionaryId,
  type PlacedTile,
  type PlayerStats,
  type PlayerSummary,
  type RoomSnapshot,
  type ServerMessage,
  type Tile,
} from './protocol';

interface LocalPlayer {
  id: string;
  name: string;
  color?: string;
  resumeToken: string;
  deviceId?: string;
  connected: boolean;
  connectionStatus?: PlayerSummary['connectionStatus'];
  hand: Tile[];
  board: PlacedTile[];
  eliminated: boolean;
  voted: boolean;
  stats: PlayerStats;
}

export interface StoredLocalRoom {
  version: 1;
  phase: RoomSnapshot['phase'];
  resumePhase?: Exclude<RoomSnapshot['phase'], 'lobby'>;
  hostId: string;
  players: LocalPlayer[];
  bag: Tile[];
  peel: number;
  dumps: number;
  dictionary: DictionaryId;
  winnerId?: string;
  claimantId?: string;
  reviewBoard?: PlacedTile[];
  reviewEndsAt?: number;
  rottenCalled: boolean;
  lastPeelerId?: string;
  currentPeelStreak?: number;
  updatedAt: number;
}

const DISTRIBUTION: Record<string, number> = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2,
  L: 5, M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3,
  W: 3, X: 2, Y: 3, Z: 2,
};

export class LocalRoomHost {
  private phase: RoomSnapshot['phase'] = 'lobby';
  private resumePhase?: Exclude<RoomSnapshot['phase'], 'lobby'>;
  private hostId = '';
  private players: LocalPlayer[] = [];
  private bag: Tile[] = [];
  private peel = 0;
  private dumps = 0;
  private dictionary: DictionaryId = 'scowl-gb';
  private winnerId?: string;
  private claimantId?: string;
  private reviewBoard?: PlacedTile[];
  private reviewEndsAt?: number;
  private rottenCalled = false;
  private lastPeelerId?: string;
  private currentPeelStreak = 0;
  private heartbeatPending = new Map<string, { id: string; sentAt: number }>();
  private heartbeatStatus = new Map<string, {
    status: 'checking' | 'available' | 'unavailable';
    latencyMs?: number;
    at: number;
  }>();

  constructor(
    private readonly deliver: (peerId: string, message: ServerMessage) => void,
    private readonly onChange?: (state: StoredLocalRoom) => void,
    restored?: StoredLocalRoom,
  ) {
    if (!restored) return;
    this.resumePhase = restored.resumePhase ?? (restored.phase === 'lobby' ? undefined : restored.phase);
    this.phase = this.resumePhase ? 'lobby' : restored.phase;
    this.hostId = restored.hostId;
    this.players = restored.players.map(player => ({
      ...player, connected: false, connectionStatus: 'disconnected', hand: [...player.hand], board: [...player.board],
      stats: player.stats ?? { dumps: 0, peels: 0, bestPeelStreak: 0 },
    }));
    this.bag = [...restored.bag];
    this.peel = restored.peel;
    this.dumps = restored.dumps ?? 0;
    this.dictionary = restored.dictionary;
    this.winnerId = restored.winnerId;
    this.claimantId = restored.claimantId;
    this.reviewBoard = restored.reviewBoard ? [...restored.reviewBoard] : undefined;
    this.reviewEndsAt = restored.reviewEndsAt;
    this.rottenCalled = restored.rottenCalled;
    this.lastPeelerId = restored.lastPeelerId;
    this.currentPeelStreak = restored.currentPeelStreak ?? 0;
  }

  receive(peerId: string, message: ClientMessage): void {
    if (message.t === 'hello') {
      this.join(peerId, message.name, message.color, message.resumeToken, message.deviceId);
      this.changed();
      return;
    }
    const player = this.players.find(value => value.id === peerId);
    if (!player) return;
    if (message.t === 'color') this.setColor(player, message.color);
    else if (message.t === 'dictionary') this.setDictionary(peerId, message.dictionary);
    else if (message.t === 'chat') this.chat(player, message.id, message.text);
    else if (message.t === 'chat-receipt') this.chatReceipt(player, message);
    else if (message.t === 'start') this.start(peerId);
    else if (message.t === 'new-game') this.newGame(peerId);
    else if (message.t === 'layout') this.layout(player, message.board);
    else if (message.t === 'peel') this.doPeel(player, message.peel, message.board);
    else if (message.t === 'dump') this.dump(player, message.tileId);
    else if (message.t === 'review') this.review(player, message.rotten);
    else if (message.t === 'heartbeat-ack') this.heartbeatAck(player, message.id, message.sentAt);
    else if (message.t === 'ping') this.deliver(peerId, { t: 'pong' });
    if (message.t !== 'ping' && message.t !== 'chat' && message.t !== 'heartbeat-ack') this.changed();
  }

  private setColor(player: LocalPlayer, rawColor: string): void {
    if (this.phase !== 'lobby') return;
    player.color = sanitizePlayerColor(rawColor);
    this.broadcastRoom();
  }

  heartbeat(): void {
    const now = Date.now();
    const host = this.players.find(player => player.id === this.hostId && player.connected);
    if (host) this.heartbeatStatus.set(host.id, { status: 'available', latencyMs: 0, at: now });
    for (const player of this.players) {
      if (!player.connected || player.id === this.hostId) continue;
      const pending = this.heartbeatPending.get(player.id);
      if (pending && now - pending.sentAt < 7_000) continue;
      if (pending) {
        this.heartbeatPending.delete(player.id);
        this.heartbeatStatus.set(player.id, { status: 'unavailable', at: now });
      }
      const id = crypto.randomUUID();
      this.heartbeatPending.set(player.id, { id, sentAt: now });
      if (!this.heartbeatStatus.has(player.id)) {
        this.heartbeatStatus.set(player.id, { status: 'checking', at: now });
      }
      this.deliver(player.id, { t: 'heartbeat', id, sentAt: now });
    }
    const players = this.players.map(player => {
      const heartbeat = this.heartbeatStatus.get(player.id)
        ?? { status: player.connected ? 'checking' as const : 'unavailable' as const, at: now };
      return { playerId: player.id, ...heartbeat };
    });
    this.broadcast({ t: 'heartbeat-status', players });
  }

  private heartbeatAck(player: LocalPlayer, id: string, sentAt: number): void {
    const pending = this.heartbeatPending.get(player.id);
    if (!pending || pending.id !== id || pending.sentAt !== sentAt) return;
    this.heartbeatPending.delete(player.id);
    const now = Date.now();
    this.heartbeatStatus.set(player.id, {
      status: 'available', latencyMs: Math.max(0, Math.min(9_999, now - sentAt)), at: now,
    });
  }

  disconnect(peerId: string): void {
    const index = this.players.findIndex(value => value.id === peerId);
    if (index < 0) return;
    this.players[index].connected = false;
    this.players[index].connectionStatus = 'disconnected';
    this.heartbeatPending.delete(peerId);
    this.heartbeatStatus.set(peerId, { status: 'unavailable', at: Date.now() });
    this.broadcastRoom();
    this.changed();
  }

  reserve(peerId: string, rawName: string, rawColor?: string, rawDeviceId?: string): void {
    if (this.phase !== 'lobby' || this.players.length >= MAX_PLAYERS) return;
    const deviceId = typeof rawDeviceId === 'string' && /^[a-f0-9]{8}$/.test(rawDeviceId)
      ? rawDeviceId
      : undefined;
    if (this.players.some(player => player.id === peerId || (deviceId && player.deviceId === deviceId))) return;
    const name = sanitizeName(rawName);
    if (!name) return;
    const existing = new Set(this.players.map(player => player.name.toLocaleLowerCase()));
    let unique = name;
    let suffix = 2;
    while (existing.has(unique.toLocaleLowerCase())) unique = `${name.slice(0, 15)} ${suffix++}`;
    this.players.push({
      id: peerId,
      name: unique,
      color: sanitizePlayerColor(rawColor),
      resumeToken: crypto.randomUUID(),
      deviceId,
      connected: false,
      connectionStatus: 'requested',
      hand: [],
      board: [],
      eliminated: false,
      voted: false,
      stats: { dumps: 0, peels: 0, bestPeelStreak: 0 },
    });
    this.heartbeatStatus.set(peerId, { status: 'unavailable', at: Date.now() });
    this.broadcastRoom();
    this.changed();
  }

  setConnectionStatus(peerId: string, status: 'received' | 'accepted'): void {
    const player = this.players.find(value => value.id === peerId);
    if (!player || player.connected) return;
    player.connectionStatus = status;
    this.broadcastRoom();
    this.changed();
  }

  exportState(): StoredLocalRoom {
    return {
      version: 1,
      phase: this.phase,
      resumePhase: this.resumePhase,
      hostId: this.hostId,
      players: this.players.map(player => ({ ...player, hand: [...player.hand], board: [...player.board] })),
      bag: [...this.bag],
      peel: this.peel,
      dumps: this.dumps,
      dictionary: this.dictionary,
      winnerId: this.winnerId,
      claimantId: this.claimantId,
      reviewBoard: this.reviewBoard ? [...this.reviewBoard] : undefined,
      reviewEndsAt: this.reviewEndsAt,
      rottenCalled: this.rottenCalled,
      lastPeelerId: this.lastPeelerId,
      currentPeelStreak: this.currentPeelStreak,
      updatedAt: Date.now(),
    };
  }

  private changed(): void {
    this.onChange?.(this.exportState());
  }

  private join(peerId: string, rawName: string, rawColor?: string, resumeToken?: string, rawDeviceId?: string): void {
    const color = sanitizePlayerColor(rawColor);
    const deviceId = typeof rawDeviceId === 'string' && /^[a-f0-9]{8}$/.test(rawDeviceId)
      ? rawDeviceId
      : undefined;
    const existingPeer = this.players.find(player => player.id === peerId);
    if (existingPeer) {
      existingPeer.connected = true;
      existingPeer.connectionStatus = undefined;
      existingPeer.color = color;
      this.heartbeatStatus.set(peerId, { status: 'checking', at: Date.now() });
      this.deliver(peerId, { t: 'welcome', id: peerId, resumeToken: existingPeer.resumeToken, room: this.snapshot() });
      this.deliver(peerId, { t: 'hand', tiles: existingPeer.hand, replace: true });
      // The returning peer receives its fresh snapshot above, but every other
      // client (including the host UI) must also clear the stale offline flag.
      this.broadcastRoom(peerId);
      return;
    }
    const name = sanitizeName(rawName);
    if (!name) return this.deliver(peerId, { t: 'error', message: 'Enter a player name.' });
    const resuming = (resumeToken
      ? this.players.find(player => player.resumeToken === resumeToken)
      : undefined)
      ?? (deviceId ? this.players.find(player => player.deviceId === deviceId) : undefined)
      ?? this.players.find(player => !player.connected && player.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (resuming) {
      const previousId = resuming.id;
      resuming.id = peerId;
      resuming.connected = true;
      resuming.connectionStatus = undefined;
      resuming.color = color;
      if (deviceId) resuming.deviceId = deviceId;
      this.heartbeatPending.delete(previousId);
      this.heartbeatStatus.delete(previousId);
      this.heartbeatStatus.set(peerId, { status: 'checking', at: Date.now() });
      if (this.hostId === previousId) this.hostId = peerId;
      if (this.claimantId === previousId) this.claimantId = peerId;
      if (this.winnerId === previousId) this.winnerId = peerId;
      if (this.lastPeelerId === previousId) this.lastPeelerId = peerId;
      this.deliver(peerId, { t: 'welcome', id: peerId, resumeToken: resuming.resumeToken, room: this.snapshot() });
      this.deliver(peerId, { t: 'hand', tiles: resuming.hand, replace: true });
      this.broadcastRoom(peerId);
      return;
    }
    if (this.phase !== 'lobby') return this.deliver(peerId, { t: 'error', message: 'A game is already in progress.' });
    if (this.resumePhase) return this.deliver(peerId, { t: 'error', message: 'Only players from this saved game can rejoin.' });
    if (this.players.length >= MAX_PLAYERS) return this.deliver(peerId, { t: 'error', message: 'This nearby game is full.' });
    const existing = new Set(this.players.map(player => player.name.toLowerCase()));
    let unique = name;
    let suffix = 2;
    while (existing.has(unique.toLowerCase())) unique = `${name.slice(0, 15)} ${suffix++}`;
    const token = crypto.randomUUID();
    this.players.push({ id: peerId, name: unique, color, resumeToken: token, deviceId, connected: true, hand: [], board: [], eliminated: false, voted: false, stats: { dumps: 0, peels: 0, bestPeelStreak: 0 } });
    this.heartbeatStatus.set(peerId, { status: 'checking', at: Date.now() });
    if (!this.hostId) this.hostId = peerId;
    this.deliver(peerId, { t: 'welcome', id: peerId, resumeToken: token, room: this.snapshot() });
    this.broadcastRoom(peerId);
  }

  private setDictionary(peerId: string, dictionary: DictionaryId): void {
    if (this.phase !== 'lobby' || peerId !== this.hostId) return;
    if (!isDictionaryId(dictionary)) return;
    this.dictionary = dictionary;
    this.broadcastRoom();
  }

  private chat(player: LocalPlayer, rawId: string, raw: string): void {
    if (this.phase !== 'lobby') return;
    const id = sanitizeChatId(rawId) || crypto.randomUUID();
    const text = sanitizeChatText(raw);
    if (!text) return;
    this.broadcast({ t: 'chat', id, playerId: player.id, name: player.name, text, at: Date.now() });
  }

  private chatReceipt(
    player: LocalPlayer,
    message: Extract<ClientMessage, { t: 'chat-receipt' }>,
  ): void {
    if (this.phase !== 'lobby' || player.id === message.senderId || !sanitizeChatId(message.messageId)) return;
    if (message.status !== 'received' && message.status !== 'read') return;
    if (!this.players.some(candidate => candidate.id === message.senderId)) return;
    this.deliver(message.senderId, {
      t: 'chat-receipt', messageId: message.messageId, playerId: player.id, status: message.status,
    });
  }

  private start(peerId: string): void {
    if (this.phase !== 'lobby' || peerId !== this.hostId || this.players.filter(player => player.connected).length < 2) return;
    if (this.resumePhase) {
      this.phase = this.resumePhase;
      this.resumePhase = undefined;
      this.broadcastSync(
        player => ({ tiles: player.hand, replace: true }),
        { text: 'GAME RESUMED! Pick up where you left off.', tone: 'good' },
      );
      return;
    }
    this.deal(false);
  }

  private newGame(peerId: string): void {
    if (peerId !== this.hostId || this.players.length < 2) return;
    this.deal(true);
  }

  private deal(restarting: boolean): void {
    this.phase = 'playing';
    this.peel = 0;
    this.dumps = 0;
    this.bag = shuffledBag();
    this.winnerId = undefined;
    this.claimantId = undefined;
    this.reviewBoard = undefined;
    this.reviewEndsAt = undefined;
    this.rottenCalled = false;
    this.lastPeelerId = undefined;
    this.currentPeelStreak = 0;
    const starting = this.players.length <= 4 ? 21 : this.players.length <= 6 ? 15 : 11;
    for (const player of this.players) {
      player.hand = this.bag.splice(-starting);
      player.board = [];
      player.eliminated = false;
      player.voted = false;
      player.stats = { dumps: 0, peels: 0, bestPeelStreak: 0 };
    }
    this.broadcastSync(
      player => ({ tiles: player.hand, replace: true }),
      { text: restarting ? 'NEW GAME! Fresh tiles for everyone.' : 'SPLIT! Build your grid.', tone: 'good' },
      restarting,
    );
  }

  private layout(player: LocalPlayer, raw: PlacedTile[]): void {
    if ((this.phase !== 'playing' && !(this.phase === 'finished' && player.id !== this.winnerId)) || player.eliminated) return;
    const board = sanitizeLayout(raw, new Set(player.hand.map(tile => tile.id)));
    if (!board || this.overlapsAnother(player.id, board)) {
      this.deliver(player.id, { t: 'layout', playerId: player.id, board: player.board });
      return;
    }
    player.board = board;
    this.broadcastExcept(player.id, { t: 'layout', playerId: player.id, board });
  }

  private doPeel(player: LocalPlayer, peel: number, raw: PlacedTile[]): void {
    if (this.phase !== 'playing' || player.eliminated || peel !== this.peel) {
      this.deliver(player.id, { t: 'peel-result', peel, accepted: false, reason: 'The game changed before that peel arrived.' });
      return;
    }
    const board = sanitizeBoard(raw, new Set(player.hand.map(tile => tile.id)));
    if (!board || this.overlapsAnother(player.id, board)) {
      this.deliver(player.id, { t: 'peel-result', peel, accepted: false, reason: 'Your tiles must form one connected, non-overlapping grid.' });
      return;
    }
    player.board = board;
    this.recordPeel(player);
    const active = this.players.filter(value => !value.eliminated);
    if (this.bag.length < active.length) {
      this.phase = 'finished';
      this.winnerId = player.id;
      this.claimantId = undefined;
      this.reviewBoard = undefined;
      this.reviewEndsAt = undefined;
      this.broadcast({ t: 'toast', text: `${player.name} is Top Banana!`, tone: 'good' });
      this.deliver(player.id, { t: 'peel-result', peel, accepted: true });
      this.broadcastRoom();
      return;
    }
    this.peel++;
    this.deliver(player.id, { t: 'peel-result', peel, accepted: true });
    const additions = new Map<string, Tile>();
    for (const candidate of active) {
      const drawn = this.bag.pop();
      if (!drawn) continue;
      candidate.hand.push(drawn);
      additions.set(candidate.id, drawn);
    }
    this.broadcastSync(
      candidate => ({ tiles: additions.has(candidate.id) ? [additions.get(candidate.id)!] : [], replace: false }),
      { text: `${player.name} peeled!`, tone: 'plain' },
    );
  }

  private dump(player: LocalPlayer, tileId: string): void {
    if (this.phase !== 'playing' || player.eliminated || this.bag.length < 3) return;
    const index = player.hand.findIndex(tile => tile.id === tileId);
    if (index < 0) return;
    const [returned] = player.hand.splice(index, 1);
    player.board = player.board.filter(tile => tile.id !== returned.id);
    shuffle(this.bag);
    player.hand.push(...this.bag.splice(-3));
    this.bag.push(returned);
    shuffle(this.bag);
    this.dumps++;
    player.stats.dumps++;
    this.deliver(player.id, { t: 'hand', tiles: player.hand, replace: true });
    this.deliver(player.id, { t: 'toast', text: `Dumped ${returned.letter}. Three new tiles.`, tone: 'plain' });
    this.broadcastRoom();
  }

  private review(player: LocalPlayer, rotten: boolean): void {
    if (this.phase !== 'review' || player.id === this.claimantId || player.voted) return;
    player.voted = true;
    if (rotten) this.rottenCalled = true;
    if (rotten || this.players.filter(value => !value.eliminated).every(value => value.voted)) this.finishReview();
    else this.broadcastRoom();
  }

  private finishReview(): void {
    if (this.phase !== 'review') return;
    const claimant = this.players.find(value => value.id === this.claimantId);
    if (!claimant) return;
    if (this.rottenCalled) {
      claimant.eliminated = true;
      this.bag.push(...claimant.hand);
      claimant.hand = [];
      claimant.board = [];
      shuffle(this.bag);
      const active = this.players.filter(value => !value.eliminated);
      if (active.length === 1) { this.phase = 'finished'; this.winnerId = active[0].id; }
      else this.phase = 'playing';
    } else { this.phase = 'finished'; this.winnerId = claimant.id; }
    this.broadcastRoom();
  }

  private overlapsAnother(playerId: string, board: PlacedTile[]): boolean {
    const occupied = new Set(this.players.filter(player => player.id !== playerId).flatMap(player => player.board).map(tile => `${tile.x},${tile.y}`));
    return board.some(tile => occupied.has(`${tile.x},${tile.y}`));
  }

  private recordPeel(player: LocalPlayer): void {
    this.currentPeelStreak = this.lastPeelerId === player.id ? this.currentPeelStreak + 1 : 1;
    this.lastPeelerId = player.id;
    player.stats.peels++;
    player.stats.bestPeelStreak = Math.max(player.stats.bestPeelStreak, this.currentPeelStreak);
  }

  private snapshot(): RoomSnapshot {
    const areas = createPlayerAreas(this.players.length);
    const players: PlayerSummary[] = this.players.map((player, index) => ({
      id: player.id, name: player.name, color: sanitizePlayerColor(player.color), tilesLeft: looseTileCount(player.hand, player.board),
      tiles: player.hand, board: player.board, area: areas[index], connected: player.connected ? undefined : false,
      connectionStatus: player.connectionStatus,
      eliminated: player.eliminated || undefined,
      stats: player.stats,
    }));
    return {
      phase: this.phase, resumeAvailable: !!this.resumePhase, hostId: this.hostId, players, bunch: this.bag.length, peel: this.peel, dumps: this.dumps,
      dictionary: this.dictionary, winnerId: this.winnerId, claimantId: this.claimantId,
      reviewBoard: this.reviewBoard, reviewEndsAt: this.reviewEndsAt,
    };
  }

  private broadcast(message: ServerMessage): void {
    this.players.forEach(player => { if (player.connected) this.deliver(player.id, message); });
  }
  private broadcastExcept(playerId: string, message: ServerMessage): void {
    this.players.forEach(player => { if (player.connected && player.id !== playerId) this.deliver(player.id, message); });
  }
  private broadcastRoom(except?: string): void {
    const message: ServerMessage = { t: 'room', room: this.snapshot() };
    this.players.forEach(player => { if (player.connected && player.id !== except) this.deliver(player.id, message); });
  }

  private broadcastSync(
    handFor: (player: LocalPlayer) => { tiles: Tile[]; replace: boolean },
    toast: { text: string; tone?: 'good' | 'bad' | 'plain' },
    reset = false,
  ): void {
    const room = this.snapshot();
    this.players.forEach(player => {
      if (player.connected) this.deliver(player.id, { t: 'room', room, hand: handFor(player), reset, toast });
    });
  }
}

function looseTileCount(hand: Tile[], board: PlacedTile[]): number {
  const placed = new Set(board.map(tile => tile.id));
  return hand.reduce((count, tile) => count + (placed.has(tile.id) ? 0 : 1), 0);
}

function shuffledBag(): Tile[] {
  const tiles = Object.entries(DISTRIBUTION).flatMap(([letter, count]) =>
    Array.from({ length: count }, (_, index) => ({ id: `${letter}-${index}-${crypto.randomUUID().slice(0, 6)}`, letter }))
  );
  shuffle(tiles);
  return tiles;
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index--) {
    const next = Math.floor(Math.random() * (index + 1));
    [values[index], values[next]] = [values[next], values[index]];
  }
}
