import {
  MAX_PLAYERS,
  createPlayerAreas,
  isDictionaryId,
  sanitizeBoard,
  sanitizeLayout,
  sanitizeName,
  type ClientMessage,
  type DictionaryId,
  type PlacedTile,
  type PlayerSummary,
  type RoomSnapshot,
  type ServerMessage,
  type Tile,
} from './protocol';

interface LocalPlayer {
  id: string;
  name: string;
  resumeToken: string;
  connected: boolean;
  hand: Tile[];
  board: PlacedTile[];
  eliminated: boolean;
  voted: boolean;
}

export interface StoredLocalRoom {
  version: 1;
  phase: RoomSnapshot['phase'];
  hostId: string;
  players: LocalPlayer[];
  bag: Tile[];
  peel: number;
  dictionary: DictionaryId;
  winnerId?: string;
  claimantId?: string;
  reviewBoard?: PlacedTile[];
  reviewEndsAt?: number;
  rottenCalled: boolean;
  updatedAt: number;
}

const DISTRIBUTION: Record<string, number> = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2,
  L: 5, M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3,
  W: 3, X: 2, Y: 3, Z: 2,
};

export class LocalRoomHost {
  private phase: RoomSnapshot['phase'] = 'lobby';
  private hostId = '';
  private players: LocalPlayer[] = [];
  private bag: Tile[] = [];
  private peel = 0;
  private dictionary: DictionaryId = 'scowl-gb';
  private winnerId?: string;
  private claimantId?: string;
  private reviewBoard?: PlacedTile[];
  private reviewEndsAt?: number;
  private rottenCalled = false;

  constructor(
    private readonly deliver: (peerId: string, message: ServerMessage) => void,
    private readonly onChange?: (state: StoredLocalRoom) => void,
    restored?: StoredLocalRoom,
  ) {
    if (!restored) return;
    this.phase = restored.phase;
    this.hostId = restored.hostId;
    this.players = restored.players.map(player => ({ ...player, connected: false, hand: [...player.hand], board: [...player.board] }));
    this.bag = [...restored.bag];
    this.peel = restored.peel;
    this.dictionary = restored.dictionary;
    this.winnerId = restored.winnerId;
    this.claimantId = restored.claimantId;
    this.reviewBoard = restored.reviewBoard ? [...restored.reviewBoard] : undefined;
    this.reviewEndsAt = restored.reviewEndsAt;
    this.rottenCalled = restored.rottenCalled;
  }

  receive(peerId: string, message: ClientMessage): void {
    if (message.t === 'hello') {
      this.join(peerId, message.name, message.resumeToken);
      this.changed();
      return;
    }
    const player = this.players.find(value => value.id === peerId);
    if (!player) return;
    if (message.t === 'dictionary') this.setDictionary(peerId, message.dictionary);
    else if (message.t === 'start') this.start(peerId);
    else if (message.t === 'new-game') this.newGame(peerId);
    else if (message.t === 'layout') this.layout(player, message.board);
    else if (message.t === 'peel') this.doPeel(player, message.peel, message.board);
    else if (message.t === 'dump') this.dump(player, message.tileId);
    else if (message.t === 'review') this.review(player, message.rotten);
    else if (message.t === 'ping') this.deliver(peerId, { t: 'pong' });
    if (message.t !== 'ping') this.changed();
  }

  disconnect(peerId: string): void {
    const index = this.players.findIndex(value => value.id === peerId);
    if (index < 0) return;
    this.players[index].connected = false;
    this.broadcastRoom();
    this.changed();
  }

  exportState(): StoredLocalRoom {
    return {
      version: 1,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map(player => ({ ...player, hand: [...player.hand], board: [...player.board] })),
      bag: [...this.bag],
      peel: this.peel,
      dictionary: this.dictionary,
      winnerId: this.winnerId,
      claimantId: this.claimantId,
      reviewBoard: this.reviewBoard ? [...this.reviewBoard] : undefined,
      reviewEndsAt: this.reviewEndsAt,
      rottenCalled: this.rottenCalled,
      updatedAt: Date.now(),
    };
  }

  private changed(): void {
    this.onChange?.(this.exportState());
  }

  private join(peerId: string, rawName: string, resumeToken?: string): void {
    const existingPeer = this.players.find(player => player.id === peerId);
    if (existingPeer) {
      existingPeer.connected = true;
      this.deliver(peerId, { t: 'welcome', id: peerId, resumeToken: existingPeer.resumeToken, room: this.snapshot() });
      this.deliver(peerId, { t: 'hand', tiles: existingPeer.hand, replace: true });
      return;
    }
    const name = sanitizeName(rawName);
    if (!name) return this.deliver(peerId, { t: 'error', message: 'Enter a player name.' });
    const resuming = (resumeToken
      ? this.players.find(player => player.resumeToken === resumeToken && !player.connected)
      : undefined)
      ?? this.players.find(player => !player.connected && player.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (resuming) {
      const previousId = resuming.id;
      resuming.id = peerId;
      resuming.connected = true;
      if (this.hostId === previousId) this.hostId = peerId;
      if (this.claimantId === previousId) this.claimantId = peerId;
      if (this.winnerId === previousId) this.winnerId = peerId;
      this.deliver(peerId, { t: 'welcome', id: peerId, resumeToken: resuming.resumeToken, room: this.snapshot() });
      this.deliver(peerId, { t: 'hand', tiles: resuming.hand, replace: true });
      this.broadcastRoom(peerId);
      return;
    }
    if (this.phase !== 'lobby') return this.deliver(peerId, { t: 'error', message: 'A game is already in progress.' });
    if (this.players.length >= MAX_PLAYERS) return this.deliver(peerId, { t: 'error', message: 'This nearby game is full.' });
    const existing = new Set(this.players.map(player => player.name.toLowerCase()));
    let unique = name;
    let suffix = 2;
    while (existing.has(unique.toLowerCase())) unique = `${name.slice(0, 15)} ${suffix++}`;
    const token = crypto.randomUUID();
    this.players.push({ id: peerId, name: unique, resumeToken: token, connected: true, hand: [], board: [], eliminated: false, voted: false });
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

  private start(peerId: string): void {
    if (this.phase !== 'lobby' || peerId !== this.hostId || this.players.filter(player => player.connected).length < 2) return;
    this.deal(false);
  }

  private newGame(peerId: string): void {
    if (peerId !== this.hostId || this.players.length < 2) return;
    this.deal(true);
  }

  private deal(restarting: boolean): void {
    this.phase = 'playing';
    this.peel = 0;
    this.bag = shuffledBag();
    this.winnerId = undefined;
    this.claimantId = undefined;
    this.reviewBoard = undefined;
    this.reviewEndsAt = undefined;
    this.rottenCalled = false;
    if (restarting) this.broadcast({ t: 'new-game' });
    const starting = this.players.length <= 4 ? 21 : this.players.length <= 6 ? 15 : 11;
    for (const player of this.players) {
      player.hand = this.bag.splice(-starting);
      player.board = [];
      player.eliminated = false;
      player.voted = false;
      if (player.connected) this.deliver(player.id, { t: 'hand', tiles: player.hand, replace: true });
    }
    this.broadcast({ t: 'toast', text: restarting ? 'NEW GAME! Fresh tiles for everyone.' : 'SPLIT! Build your grid.', tone: 'good' });
    this.broadcastRoom();
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
    if (this.phase !== 'playing' || player.eliminated || peel !== this.peel) return;
    const board = sanitizeBoard(raw, new Set(player.hand.map(tile => tile.id)));
    if (!board || this.overlapsAnother(player.id, board)) return;
    player.board = board;
    const active = this.players.filter(value => !value.eliminated);
    if (this.bag.length < active.length) {
      this.phase = 'finished';
      this.winnerId = player.id;
      this.claimantId = undefined;
      this.reviewBoard = undefined;
      this.reviewEndsAt = undefined;
      this.broadcast({ t: 'toast', text: `${player.name} is Top Banana!`, tone: 'good' });
      this.broadcastRoom();
      return;
    }
    this.peel++;
    for (const candidate of active) {
      const drawn = this.bag.pop();
      if (!drawn) continue;
      candidate.hand.push(drawn);
      if (candidate.connected) this.deliver(candidate.id, { t: 'hand', tiles: [drawn], replace: false });
    }
    this.broadcast({ t: 'toast', text: `${player.name} peeled!`, tone: 'plain' });
    this.broadcastRoom();
  }

  private dump(player: LocalPlayer, tileId: string): void {
    if (this.phase !== 'playing' || player.eliminated || this.bag.length < 3) return;
    const index = player.hand.findIndex(tile => tile.id === tileId);
    if (index < 0) return;
    const [returned] = player.hand.splice(index, 1);
    player.board = player.board.filter(tile => tile.id !== returned.id);
    this.bag.push(returned);
    shuffle(this.bag);
    player.hand.push(...this.bag.splice(-3));
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

  private snapshot(): RoomSnapshot {
    const areas = createPlayerAreas(this.players.length);
    const players: PlayerSummary[] = this.players.map((player, index) => ({
      id: player.id, name: player.name, tilesLeft: player.hand.length - player.board.length,
      tiles: player.hand, board: player.board, area: areas[index], connected: player.connected ? undefined : false,
      eliminated: player.eliminated || undefined,
    }));
    return {
      phase: this.phase, hostId: this.hostId, players, bunch: this.bag.length, peel: this.peel,
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
