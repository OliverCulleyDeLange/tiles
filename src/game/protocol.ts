export const PROTOCOL_VERSION = 4;
export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 18;
export const MAX_MESSAGE_BYTES = 16_384;
export const DEFAULT_ROOM = '';
export const PLAYER_AREA_WIDTH = 16;
export const PLAYER_AREA_HEIGHT = 11;
export const DICTIONARY_IDS = ['scowl-us', 'scowl-gb', 'de', 'es', 'it', 'fr', 'pt'] as const;
export type DictionaryId = typeof DICTIONARY_IDS[number];

export function isDictionaryId(value: unknown): value is DictionaryId {
  return typeof value === 'string' && (DICTIONARY_IDS as readonly string[]).includes(value);
}

export interface Tile {
  id: string;
  letter: string;
}

export interface PlacedTile extends Tile {
  x: number;
  y: number;
}

export interface PlayerArea {
  x: number;
  y: number;
  rotation: number;
}

export interface PlayerSummary {
  id: string;
  name: string;
  connected?: boolean;
  tilesLeft: number;
  tiles: Tile[];
  board: PlacedTile[];
  area?: PlayerArea;
  eliminated?: boolean;
}

export function createPlayerAreas(count: number): PlayerArea[] {
  const players = Math.max(1, Math.min(MAX_PLAYERS, count));
  const radius = [0, 0, 7, 12, 14.5, 17, 19.5, 22, 24][players];
  const horizontalRadius = radius * (players >= 5 ? 1.12 : 1);
  return Array.from({ length: players }, (_, index) => {
    const angle = index * Math.PI * 2 / players;
    const tableQuarterTurn = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    return {
      x: Math.round(Math.sin(angle) * horizontalRadius * 2) / 2,
      y: Math.round(Math.cos(angle) * radius * 2) / 2,
      // The seats stay radial, but crossword tiles must remain on a square grid.
      // Cardinal working angles keep every player's local right/down axes aligned
      // with whole board cells, including tables with an odd number of players.
      rotation: -tableQuarterTurn,
    };
  });
}

export function tileInsideArea(tile: Pick<PlacedTile, 'x' | 'y'>, area: PlayerArea): boolean {
  const dx = tile.x - area.x;
  const dy = tile.y - area.y;
  const cosine = Math.cos(-area.rotation);
  const sine = Math.sin(-area.rotation);
  const localX = dx * cosine - dy * sine;
  const localY = dx * sine + dy * cosine;
  return Math.abs(localX) <= PLAYER_AREA_WIDTH / 2 - 0.5 &&
    Math.abs(localY) <= PLAYER_AREA_HEIGHT / 2 - 0.5;
}

export interface RoomSnapshot {
  phase: 'lobby' | 'playing' | 'review' | 'finished';
  hostId: string;
  players: PlayerSummary[];
  bunch: number;
  peel: number;
  dictionary: DictionaryId;
  winnerId?: string;
  claimantId?: string;
  reviewBoard?: PlacedTile[];
  reviewEndsAt?: number;
}

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; resumeToken?: string }
  | { t: 'dictionary'; dictionary: DictionaryId }
  | { t: 'start' }
  | { t: 'new-game' }
  | { t: 'layout'; board: PlacedTile[] }
  | { t: 'peel'; peel: number; board: PlacedTile[] }
  | { t: 'dump'; tileId: string }
  | { t: 'review'; rotten: boolean }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; id: string; resumeToken?: string; room: RoomSnapshot }
  | { t: 'room'; room: RoomSnapshot }
  | { t: 'layout'; playerId: string; board: PlacedTile[] }
  | { t: 'new-game' }
  | { t: 'hand'; tiles: Tile[]; replace: boolean }
  | { t: 'toast'; text: string; tone?: 'good' | 'bad' | 'plain' }
  | { t: 'error'; message: string }
  | { t: 'pong' };

const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH).join('');
}

export function sanitizeRoom(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ROOM;
  const room = raw.trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(room) ? room : DEFAULT_ROOM;
}

export function sanitizeBoard(raw: unknown, allowed: Set<string>): PlacedTile[] | null {
  const board = sanitizeLayout(raw, allowed);
  if (!board || board.length !== allowed.size) return null;
  if (board.length < 2) return board;
  const cells = new Set(board.map(tile => `${tile.x},${tile.y}`));
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
  return reached.size === board.length ? board : null;
}

export function sanitizeLayout(raw: unknown, allowed: Set<string>): PlacedTile[] | null {
  if (!Array.isArray(raw) || raw.length > allowed.size || raw.length > 144) return null;
  const seenIds = new Set<string>();
  const seenCells = new Set<string>();
  const board: PlacedTile[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null;
    const source = value as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id : '';
    const letter = typeof source.letter === 'string' ? source.letter.toUpperCase() : '';
    const x = typeof source.x === 'number' ? Math.round(source.x) : NaN;
    const y = typeof source.y === 'number' ? Math.round(source.y) : NaN;
    if (!allowed.has(id) || seenIds.has(id) || !/^[A-Z]$/.test(letter)) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100 || Math.abs(y) > 100) return null;
    const cell = `${x},${y}`;
    if (seenCells.has(cell)) return null;
    seenIds.add(id);
    seenCells.add(cell);
    board.push({ id, letter, x, y });
  }
  return board;
}
