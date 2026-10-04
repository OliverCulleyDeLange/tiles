import { DurableObject } from 'cloudflare:workers';
import {
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  createPlayerAreas,
  isDictionaryId,
  PROTOCOL_VERSION,
  sanitizeBoard,
  sanitizeChatId,
  sanitizeChatText,
  sanitizeLayout,
  sanitizeName,
  sanitizePlayerColor,
  sanitizeRoom,
  type ClientMessage,
  type DictionaryId,
  type PlacedTile,
  type PlayerSummary,
  type PlayerStats,
  type PlayerArea,
  type RoomSnapshot,
  type ServerMessage,
  type Tile,
} from '../../src/game/protocol';

export interface Env {
  ROOMS: DurableObjectNamespace<TilesRoom>;
}

const ALLOWED_ORIGINS = new Set(['https://oliverdelange.co.uk', 'https://www.oliverdelange.co.uk']);
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ROOM_PATH = /^\/rooms\/([^/]+)\/?$/;

function originAllowed(origin: string | null): boolean {
  return !!origin && (ALLOWED_ORIGINS.has(origin) || DEV_ORIGIN.test(origin));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, service: 'tiles-realtime' });
    }
    const match = ROOM_PATH.exec(url.pathname);
    if (!match) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    if (!originAllowed(request.headers.get('Origin'))) return new Response('Forbidden', { status: 403 });
    const room = sanitizeRoom(decodeURIComponent(match[1]));
    if (!room) return new Response('Invalid room', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(`https://room/${room}`, request));
  },
} satisfies ExportedHandler<Env>;

interface Session {
  id: string;
  name: string;
  joined: boolean;
}

interface PlayerState {
  id: string;
  name: string;
  color?: string;
  resumeToken?: string;
  connected?: boolean;
  hand: Tile[];
  board: PlacedTile[];
  area?: PlayerArea;
  eliminated: boolean;
  voted: boolean;
  stats?: PlayerStats;
}

interface GameState {
  phase: 'lobby' | 'playing' | 'review' | 'finished';
  hostId: string;
  players: PlayerState[];
  bag: Tile[];
  peel: number;
  dumps: number;
  dictionary: DictionaryId;
  winnerId?: string;
  claimantId?: string;
  reviewBoard?: PlacedTile[];
  reviewEndsAt?: number;
  rottenCalled?: boolean;
  lastPeelerId?: string;
  currentPeelStreak?: number;
}

const DISTRIBUTION: Record<string, number> = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2,
  L: 5, M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3,
  W: 3, X: 2, Y: 3, Z: 2,
};

const REVIEW_MS = 15_000;

function looseTileCount(hand: Tile[], board: PlacedTile[]): number {
  const placed = new Set(board.map(tile => tile.id));
  return hand.reduce((count, tile) => count + (placed.has(tile.id) ? 0 : 1), 0);
}

export class TilesRoom extends DurableObject<Env> {
  private readonly budgets = new Map<WebSocket, { at: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response('Room full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session: Session = { id: crypto.randomUUID().slice(0, 8), name: '', joined: false };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES || !this.withinBudget(ws)) return;
    let message: ClientMessage;
    try { message = JSON.parse(raw) as ClientMessage; } catch { return; }
    const session = this.session(ws);
    if (!session || !message || typeof message !== 'object') return;

    if (message.t === 'hello') await this.hello(ws, session, message);
    else if (!session.joined) return;
    else if (message.t === 'color') await this.setColor(session, message.color);
    else if (message.t === 'dictionary') await this.setDictionary(session, message.dictionary);
    else if (message.t === 'chat') await this.chat(session, message.id, message.text);
    else if (message.t === 'chat-receipt') await this.chatReceipt(session, message);
    else if (message.t === 'start') await this.start(session);
    else if (message.t === 'new-game') await this.newGame(session);
    else if (message.t === 'layout') await this.layout(session, message.board);
    else if (message.t === 'peel') await this.peel(session, message);
    else if (message.t === 'dump') await this.dump(session, message.tileId);
    else if (message.t === 'review') await this.review(session, message.rotten);
    else if (message.t === 'ping') this.send(ws, { t: 'pong' });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.drop(ws);
    try { ws.close(code, reason); } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  async alarm(): Promise<void> {
    const game = await this.load();
    if (game.phase === 'review' && (game.reviewEndsAt ?? 0) <= Date.now()) {
      await this.finishReview(game);
    }
  }

  private async hello(ws: WebSocket, session: Session, message: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    if (session.joined) return;
    if (message.v !== PROTOCOL_VERSION) return this.send(ws, { t: 'error', message: 'This app version is out of date. Update Tiles to reconnect.' });
    const name = sanitizeName(message.name);
    if (!name) return this.send(ws, { t: 'error', message: 'Enter a player name.' });
    const game = await this.load();
    let resumeToken = validResumeToken(message.resumeToken) ? message.resumeToken : '';
    const returning = resumeToken
      ? game.players.find(player => player.resumeToken === resumeToken)
      : game.players.find(player => player.connected === false && player.name.toLowerCase() === name.toLowerCase());
    if (returning) {
      if (!resumeToken) {
        resumeToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
        returning.resumeToken = resumeToken;
      }
      session.id = returning.id;
      session.name = returning.name;
      session.joined = true;
      returning.connected = true;
      returning.color = sanitizePlayerColor(message.color);
      // Close an older connection before attaching this player identity to the
      // new socket. Durable Object WebSocket wrappers are not guaranteed to be
      // reference-identical across getWebSockets() calls, so comparing them
      // after serialization can accidentally close the newly resumed socket.
      for (const candidate of this.ctx.getWebSockets()) {
        const existing = this.session(candidate);
        if (existing?.joined && existing.id === returning.id) {
          try { candidate.close(1000, 'Session resumed elsewhere'); } catch {}
        }
      }
      ws.serializeAttachment(session);
      await this.save(game);
      this.send(ws, { t: 'welcome', id: returning.id, resumeToken, room: this.snapshot(game) });
      this.send(ws, { t: 'hand', tiles: returning.hand, replace: true });
      this.broadcastRoom(game, ws);
      return;
    }
    if (game.phase !== 'lobby') return this.send(ws, { t: 'error', message: 'A game is already in progress.' });
    if (game.players.length >= MAX_PLAYERS) return this.send(ws, { t: 'error', message: 'This room is full.' });
    session.name = this.uniqueName(name, game);
    session.joined = true;
    ws.serializeAttachment(session);
    const newResumeToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    game.players.push({ id: session.id, name: session.name, color: sanitizePlayerColor(message.color), resumeToken: newResumeToken, connected: true, hand: [], board: [], eliminated: false, voted: false, stats: { dumps: 0, peels: 0, bestPeelStreak: 0 } });
    if (!game.hostId) game.hostId = session.id;
    await this.save(game);
    this.send(ws, { t: 'welcome', id: session.id, resumeToken: newResumeToken, room: this.snapshot(game) });
    this.broadcastRoom(game, ws);
  }

  private async start(session: Session): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby' || session.id !== game.hostId || game.players.length < 2) return;
    await this.deal(game, false);
  }

  private async setColor(session: Session, rawColor: string): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby') return;
    const player = game.players.find(value => value.id === session.id);
    if (!player) return;
    player.color = sanitizePlayerColor(rawColor);
    await this.save(game);
    this.broadcastRoom(game);
  }

  private async chat(session: Session, rawId: string, raw: string): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby') return;
    const player = game.players.find(value => value.id === session.id);
    const id = sanitizeChatId(rawId) || crypto.randomUUID();
    const text = sanitizeChatText(raw);
    if (!player || !text) return;
    this.broadcast({ t: 'chat', id, playerId: player.id, name: player.name, text, at: Date.now() });
  }

  private async chatReceipt(
    session: Session,
    message: Extract<ClientMessage, { t: 'chat-receipt' }>,
  ): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby' || session.id === message.senderId || !sanitizeChatId(message.messageId)) return;
    if (message.status !== 'received' && message.status !== 'read') return;
    if (!game.players.some(player => player.id === message.senderId)) return;
    this.sendTo(message.senderId, {
      t: 'chat-receipt', messageId: message.messageId, playerId: session.id, status: message.status,
    });
  }

  private async newGame(session: Session): Promise<void> {
    const game = await this.load();
    if (session.id !== game.hostId || game.players.length < 2) return;
    await this.deal(game, true);
  }

  private async deal(game: GameState, restarting: boolean): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    game.phase = 'playing';
    game.bag = shuffledBag();
    game.peel = 0;
    game.dumps = 0;
    game.winnerId = undefined;
    game.claimantId = undefined;
    game.reviewBoard = undefined;
    game.reviewEndsAt = undefined;
    game.rottenCalled = false;
    game.lastPeelerId = undefined;
    game.currentPeelStreak = 0;
    if (restarting) this.broadcast({ t: 'new-game' });
    const starting = game.players.length <= 4 ? 21 : game.players.length <= 6 ? 15 : 11;
    const areas = createPlayerAreas(game.players.length);
    for (const [index, player] of game.players.entries()) {
      player.hand = game.bag.splice(-starting);
      player.board = [];
      player.area = areas[index];
      player.eliminated = false;
      player.voted = false;
      player.stats = { dumps: 0, peels: 0, bestPeelStreak: 0 };
      this.sendTo(player.id, { t: 'hand', tiles: player.hand, replace: true });
    }
    await this.save(game);
    this.broadcast({ t: 'toast', text: restarting ? 'NEW GAME! Fresh tiles for everyone.' : 'SPLIT! Build your grid.', tone: 'good' });
    this.broadcastRoom(game);
  }

  private async setDictionary(session: Session, dictionary: DictionaryId): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby' || session.id !== game.hostId) return;
    if (!isDictionaryId(dictionary)) return;
    game.dictionary = dictionary;
    await this.save(game);
    this.broadcastRoom(game);
  }

  private async layout(session: Session, raw: PlacedTile[]): Promise<void> {
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player || player.eliminated || (game.phase !== 'playing' && !(game.phase === 'finished' && player.id !== game.winnerId))) return;
    const board = sanitizeLayout(raw, new Set(player.hand.map(tile => tile.id)));
    if (!board) return this.sendTo(session.id, { t: 'layout', playerId: player.id, board: player.board ?? [] });
    const occupied = new Set(game.players
      .filter(value => value.id !== player.id)
      .flatMap(value => value.board ?? [])
      .map(tile => `${tile.x},${tile.y}`));
    if (board.some(tile => occupied.has(`${tile.x},${tile.y}`))) {
      this.sendTo(session.id, { t: 'layout', playerId: player.id, board: player.board ?? [] });
      return this.sendTo(session.id, { t: 'toast', text: 'That space belongs to another player.', tone: 'bad' });
    }
    player.board = board;
    await this.save(game);
    this.broadcastExceptPlayer(player.id, { t: 'layout', playerId: player.id, board });
  }

  private async peel(session: Session, message: Extract<ClientMessage, { t: 'peel' }>): Promise<void> {
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player || player.eliminated || game.phase !== 'playing' || message.peel !== game.peel) {
      return this.sendTo(session.id, { t: 'peel-result', peel: message.peel, accepted: false, reason: 'The game changed before that peel arrived.' });
    }
    const board = sanitizeBoard(message.board, new Set(player.hand.map(tile => tile.id)));
    if (!board) return this.sendTo(session.id, { t: 'peel-result', peel: message.peel, accepted: false, reason: 'Your tiles must form one connected grid.' });
    const occupied = new Set(game.players
      .filter(value => value.id !== player.id)
      .flatMap(value => value.board ?? [])
      .map(tile => `${tile.x},${tile.y}`));
    if (board.some(tile => occupied.has(`${tile.x},${tile.y}`))) {
      return this.sendTo(session.id, { t: 'peel-result', peel: message.peel, accepted: false, reason: 'Your grid overlaps another player.' });
    }
    player.board = board;
    this.recordPeel(game, player);
    const active = game.players.filter(value => !value.eliminated);
    if (game.bag.length < active.length) {
      game.phase = 'finished';
      game.winnerId = player.id;
      game.claimantId = undefined;
      game.reviewBoard = undefined;
      game.reviewEndsAt = undefined;
      await this.save(game);
      this.sendTo(session.id, { t: 'peel-result', peel: message.peel, accepted: true });
      this.broadcast({ t: 'toast', text: `${player.name} is Top Banana!`, tone: 'good' });
      this.broadcastRoom(game);
      return;
    }
    game.peel++;
    this.sendTo(session.id, { t: 'peel-result', peel: message.peel, accepted: true });
    for (const candidate of active) {
      const drawn = game.bag.pop();
      if (!drawn) continue;
      candidate.hand.push(drawn);
      this.sendTo(candidate.id, { t: 'hand', tiles: [drawn], replace: false });
    }
    await this.save(game);
    this.broadcast({ t: 'toast', text: `${player.name} peeled!`, tone: 'plain' });
    this.broadcastRoom(game);
  }

  private async dump(session: Session, tileId: string): Promise<void> {
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player || player.eliminated || game.phase !== 'playing') return;
    const index = player.hand.findIndex(tile => tile.id === tileId);
    if (index < 0) return;
    if (game.bag.length < 3) return this.sendTo(session.id, { t: 'toast', text: 'Fewer than three tiles remain. You cannot dump.', tone: 'bad' });
    const [returned] = player.hand.splice(index, 1);
    player.board = (player.board ?? []).filter(tile => tile.id !== returned.id);
    shuffle(game.bag);
    const drawn = game.bag.splice(-3);
    player.hand.push(...drawn);
    game.bag.push(returned);
    shuffle(game.bag);
    game.dumps = (game.dumps ?? 0) + 1;
    player.stats ??= { dumps: 0, peels: 0, bestPeelStreak: 0 };
    player.stats.dumps++;
    await this.save(game);
    this.sendTo(player.id, { t: 'hand', tiles: player.hand, replace: true });
    this.sendTo(player.id, { t: 'toast', text: `Dumped ${returned.letter}. Three new tiles.`, tone: 'plain' });
    this.broadcastRoom(game);
  }

  private async review(session: Session, rotten: boolean): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'review' || session.id === game.claimantId) return;
    const voter = game.players.find(value => value.id === session.id && !value.eliminated);
    if (!voter || voter.voted) return;
    voter.voted = true;
    if (rotten) game.rottenCalled = true;
    await this.save(game);
    if (rotten || game.players.filter(value => !value.eliminated).every(value => value.voted)) {
      await this.finishReview(game);
    } else this.broadcastRoom(game);
  }

  private recordPeel(game: GameState, player: PlayerState): void {
    player.stats ??= { dumps: 0, peels: 0, bestPeelStreak: 0 };
    game.currentPeelStreak = game.lastPeelerId === player.id ? (game.currentPeelStreak ?? 0) + 1 : 1;
    game.lastPeelerId = player.id;
    player.stats.peels++;
    player.stats.bestPeelStreak = Math.max(player.stats.bestPeelStreak, game.currentPeelStreak);
  }

  private async finishReview(game: GameState): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const claimant = game.players.find(value => value.id === game.claimantId);
    if (!claimant) return;
    if (game.rottenCalled) {
      claimant.eliminated = true;
      game.bag.push(...claimant.hand);
      claimant.hand = [];
      claimant.board = [];
      shuffle(game.bag);
      const active = game.players.filter(value => !value.eliminated);
      if (active.length === 1) {
        game.phase = 'finished';
        game.winnerId = active[0].id;
      } else {
        game.phase = 'playing';
        game.claimantId = undefined;
        game.reviewBoard = undefined;
        game.reviewEndsAt = undefined;
        game.rottenCalled = false;
      }
      await this.save(game);
      this.broadcast({ t: 'toast', text: `${claimant.name} is a Rotten Banana. Play continues!`, tone: 'bad' });
      this.broadcastRoom(game);
    } else {
      game.phase = 'finished';
      game.winnerId = claimant.id;
      await this.save(game);
      this.broadcastRoom(game);
    }
  }

  private async drop(ws: WebSocket): Promise<void> {
    this.budgets.delete(ws);
    const session = this.session(ws);
    if (!session?.joined) return;
    const replacement = this.ctx.getWebSockets().some(candidate =>
      candidate !== ws && this.session(candidate)?.joined && this.session(candidate)?.id === session.id
    );
    if (replacement) return;
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player) return;
    if (game.phase === 'lobby') {
      game.players = game.players.filter(value => value.id !== session.id);
      if (game.hostId === session.id) game.hostId = game.players[0]?.id ?? '';
      await this.save(game);
      this.broadcastRoom(game);
      return;
    }
    player.connected = false;
    await this.save(game);
    this.broadcastRoom(game);
  }

  private snapshot(game: GameState): RoomSnapshot {
    const players: PlayerSummary[] = game.players.map(player => ({
      id: player.id,
      name: player.name,
      color: sanitizePlayerColor(player.color),
      connected: player.connected !== false,
      tilesLeft: looseTileCount(player.hand, player.board ?? []),
      tiles: player.hand,
      board: player.board ?? [],
      area: player.area,
      eliminated: player.eliminated || undefined,
      stats: player.stats ?? { dumps: 0, peels: 0, bestPeelStreak: 0 },
    }));
    return {
      phase: game.phase,
      hostId: game.hostId,
      players,
      bunch: game.bag.length,
      peel: game.peel,
      dumps: game.dumps ?? 0,
      dictionary: game.dictionary ?? 'scowl-gb',
      winnerId: game.winnerId,
      claimantId: game.claimantId,
      reviewBoard: game.reviewBoard,
      reviewEndsAt: game.reviewEndsAt,
    };
  }

  private async load(): Promise<GameState> {
    return (await this.ctx.storage.get<GameState>('game')) ?? {
      phase: 'lobby', hostId: '', players: [], bag: [], peel: 0, dumps: 0, dictionary: 'scowl-gb',
    };
  }

  private async save(game: GameState): Promise<void> {
    await this.ctx.storage.put('game', game);
  }

  private session(ws: WebSocket): Session | null {
    try { return (ws.deserializeAttachment() as Session | null) ?? null; } catch { return null; }
  }

  private uniqueName(wanted: string, game: GameState): string {
    if (!game.players.some(player => player.name.toLowerCase() === wanted.toLowerCase())) return wanted;
    let suffix = 2;
    while (game.players.some(player => player.name.toLowerCase() === `${wanted} ${suffix}`.toLowerCase())) suffix++;
    return `${wanted} ${suffix}`.slice(0, 18);
  }

  private withinBudget(ws: WebSocket): boolean {
    const now = Date.now();
    let budget = this.budgets.get(ws);
    if (!budget || now - budget.at >= 1000) {
      budget = { at: now, count: 0 };
      this.budgets.set(ws, budget);
    }
    return ++budget.count <= 20;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try { ws.send(JSON.stringify(message)); } catch {}
  }

  private sendTo(id: string, message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.session(ws)?.id === id) this.send(ws, message);
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || !this.session(ws)?.joined) continue;
      try { ws.send(data); } catch {}
    }
  }

  private broadcastExceptPlayer(playerId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const session = this.session(ws);
      if (!session?.joined || session.id === playerId) continue;
      try { ws.send(data); } catch {}
    }
  }

  private broadcastRoom(game: GameState, except?: WebSocket): void {
    this.broadcast({ t: 'room', room: this.snapshot(game) }, except);
  }
}

function validResumeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function shuffledBag(): Tile[] {
  const tiles: Tile[] = [];
  let index = 0;
  for (const [letter, count] of Object.entries(DISTRIBUTION)) {
    for (let copy = 0; copy < count; copy++) tiles.push({ id: `t${index++}`, letter });
  }
  return shuffle(tiles);
}

function shuffle<T>(values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}
