import { DurableObject } from 'cloudflare:workers';
import {
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  createPlayerAreas,
  PROTOCOL_VERSION,
  sanitizeBoard,
  sanitizeLayout,
  sanitizeName,
  sanitizeRoom,
  type ClientMessage,
  type DictionaryId,
  type PlacedTile,
  type PlayerSummary,
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
  resumeToken?: string;
  connected?: boolean;
  hand: Tile[];
  board: PlacedTile[];
  area?: PlayerArea;
  eliminated: boolean;
  voted: boolean;
}

interface GameState {
  phase: 'lobby' | 'playing' | 'review' | 'finished';
  hostId: string;
  players: PlayerState[];
  bag: Tile[];
  peel: number;
  dictionary: DictionaryId;
  winnerId?: string;
  claimantId?: string;
  reviewBoard?: PlacedTile[];
  reviewEndsAt?: number;
  rottenCalled?: boolean;
}

const DISTRIBUTION: Record<string, number> = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2,
  L: 5, M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3,
  W: 3, X: 2, Y: 3, Z: 2,
};

const REVIEW_MS = 15_000;

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
    else if (message.t === 'dictionary') await this.setDictionary(session, message.dictionary);
    else if (message.t === 'start') await this.start(session);
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
    } else if (game.phase === 'finished') {
      game.phase = 'lobby';
      game.bag = [];
      game.peel = 0;
      game.winnerId = undefined;
      game.claimantId = undefined;
      game.reviewBoard = undefined;
      game.reviewEndsAt = undefined;
      game.rottenCalled = false;
      for (const player of game.players) {
        player.hand = [];
        player.board = [];
        player.area = undefined;
        player.eliminated = false;
        player.voted = false;
      }
      await this.save(game);
      this.broadcastRoom(game);
    }
  }

  private async hello(ws: WebSocket, session: Session, message: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    if (session.joined || message.v !== PROTOCOL_VERSION) return;
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
      ws.serializeAttachment(session);
      await this.save(game);
      this.send(ws, { t: 'welcome', id: returning.id, resumeToken, room: this.snapshot(game) });
      this.send(ws, { t: 'hand', tiles: returning.hand, replace: true });
      this.broadcastRoom(game, ws);
      for (const candidate of this.ctx.getWebSockets()) {
        if (candidate !== ws && this.session(candidate)?.id === returning.id) {
          try { candidate.close(1000, 'Session resumed elsewhere'); } catch {}
        }
      }
      return;
    }
    if (game.phase !== 'lobby') return this.send(ws, { t: 'error', message: 'A game is already in progress.' });
    if (game.players.length >= MAX_PLAYERS) return this.send(ws, { t: 'error', message: 'This room is full.' });
    session.name = this.uniqueName(name, game);
    session.joined = true;
    ws.serializeAttachment(session);
    const newResumeToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    game.players.push({ id: session.id, name: session.name, resumeToken: newResumeToken, connected: true, hand: [], board: [], eliminated: false, voted: false });
    if (!game.hostId) game.hostId = session.id;
    await this.save(game);
    this.send(ws, { t: 'welcome', id: session.id, resumeToken: newResumeToken, room: this.snapshot(game) });
    this.broadcastRoom(game, ws);
  }

  private async start(session: Session): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby' || session.id !== game.hostId || game.players.length < 2) return;
    game.phase = 'playing';
    game.bag = shuffledBag();
    game.peel = 0;
    game.winnerId = undefined;
    const starting = game.players.length <= 4 ? 21 : game.players.length <= 6 ? 15 : 11;
    const areas = createPlayerAreas(game.players.length);
    for (const [index, player] of game.players.entries()) {
      player.hand = game.bag.splice(-starting);
      player.board = [];
      player.area = areas[index];
      player.eliminated = false;
      player.voted = false;
      this.sendTo(player.id, { t: 'hand', tiles: player.hand, replace: true });
    }
    await this.save(game);
    this.broadcast({ t: 'toast', text: 'SPLIT! Build your grid.', tone: 'good' });
    this.broadcastRoom(game);
  }

  private async setDictionary(session: Session, dictionary: DictionaryId): Promise<void> {
    const game = await this.load();
    if (game.phase !== 'lobby' || session.id !== game.hostId) return;
    if (dictionary !== 'scowl-us' && dictionary !== 'scowl-gb') return;
    game.dictionary = dictionary;
    await this.save(game);
    this.broadcastRoom(game);
  }

  private async layout(session: Session, raw: PlacedTile[]): Promise<void> {
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player || player.eliminated || game.phase !== 'playing') return;
    const board = sanitizeLayout(raw, new Set(player.hand.map(tile => tile.id)));
    if (!board) return;
    const occupied = new Set(game.players
      .filter(value => value.id !== player.id)
      .flatMap(value => value.board ?? [])
      .map(tile => `${tile.x},${tile.y}`));
    if (board.some(tile => occupied.has(`${tile.x},${tile.y}`))) {
      return this.sendTo(session.id, { t: 'toast', text: 'That space belongs to another player.', tone: 'bad' });
    }
    player.board = board;
    await this.save(game);
    this.broadcastRoom(game);
  }

  private async peel(session: Session, message: Extract<ClientMessage, { t: 'peel' }>): Promise<void> {
    const game = await this.load();
    const player = game.players.find(value => value.id === session.id);
    if (!player || player.eliminated || game.phase !== 'playing' || message.peel !== game.peel) return;
    const board = sanitizeBoard(message.board, new Set(player.hand.map(tile => tile.id)));
    if (!board) return this.sendTo(session.id, { t: 'toast', text: 'Your tiles must form one connected grid.', tone: 'bad' });
    const occupied = new Set(game.players
      .filter(value => value.id !== player.id)
      .flatMap(value => value.board ?? [])
      .map(tile => `${tile.x},${tile.y}`));
    if (board.some(tile => occupied.has(`${tile.x},${tile.y}`))) {
      return this.sendTo(session.id, { t: 'toast', text: 'Your grid overlaps another player.', tone: 'bad' });
    }
    player.board = board;
    const active = game.players.filter(value => !value.eliminated);
    if (game.bag.length < active.length) {
      game.phase = 'review';
      game.claimantId = player.id;
      game.reviewBoard = board;
      game.reviewEndsAt = Date.now() + REVIEW_MS;
      game.rottenCalled = false;
      for (const candidate of active) candidate.voted = candidate.id === player.id;
      await this.save(game);
      this.broadcast({ t: 'toast', text: `${player.name} called BANANAS!`, tone: 'plain' });
      this.broadcastRoom(game);
      await this.ctx.storage.setAlarm(game.reviewEndsAt);
      return;
    }
    game.peel++;
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
    game.bag.push(returned);
    shuffle(game.bag);
    const drawn = game.bag.splice(-3);
    player.hand.push(...drawn);
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
      if (game.phase === 'finished') await this.ctx.storage.setAlarm(Date.now() + 7_000);
    } else {
      game.phase = 'finished';
      game.winnerId = claimant.id;
      await this.save(game);
      this.broadcastRoom(game);
      await this.ctx.storage.setAlarm(Date.now() + 7_000);
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
    player.connected = false;
    await this.save(game);
    this.broadcastRoom(game);
  }

  private snapshot(game: GameState): RoomSnapshot {
    const players: PlayerSummary[] = game.players.map(player => ({
      id: player.id,
      name: player.name,
      connected: player.connected !== false,
      tilesLeft: player.hand.length - (player.board?.length ?? 0),
      tiles: player.hand,
      board: player.board ?? [],
      area: player.area,
      eliminated: player.eliminated || undefined,
    }));
    return {
      phase: game.phase,
      hostId: game.hostId,
      players,
      bunch: game.bag.length,
      peel: game.peel,
      dictionary: game.dictionary ?? 'scowl-us',
      winnerId: game.winnerId,
      claimantId: game.claimantId,
      reviewBoard: game.reviewBoard,
      reviewEndsAt: game.reviewEndsAt,
    };
  }

  private async load(): Promise<GameState> {
    return (await this.ctx.storage.get<GameState>('game')) ?? {
      phase: 'lobby', hostId: '', players: [], bag: [], peel: 0, dictionary: 'scowl-us',
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
