// A GitHub-compatible git forge in one file: git smart HTTP (protocol v2 + v0), REST v3,
// GraphQL v4 and MCP over streamable HTTP, all over one in-memory store, implemented with
// Node's standard library only (node:http, node:crypto, node:zlib). No git binary, no npm
// packages, no model calls.
//
// Determinism: nothing observable reads the wall clock or an unseeded random source. Times
// derive from MAKEFUN_TRIAL_NOW plus a per-process counter; ids come from counters. The
// token's login (the viewer) is learned from the owner segment of the first repo-addressed
// request, which is how the suite addresses the token owner's repositories.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Deterministic time and ids
// ---------------------------------------------------------------------------------------------

const TRIAL_NOW_RAW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const parsedTrialNow = Date.parse(TRIAL_NOW_RAW);
const BASE_TIME_MS = Number.isFinite(parsedTrialNow) ? parsedTrialNow : 1_735_689_600_000; // scenario epoch fallback
let tickCounter = 0;

/** The next deterministic timestamp: the trial's opening time plus a counter of seconds. */
function tickIso(): string {
  tickCounter += 1;
  return new Date(BASE_TIME_MS + tickCounter * 1000).toISOString().replace('.000Z', 'Z');
}

/** The next deterministic unix-seconds timestamp for git objects. */
function tickSec(): number {
  tickCounter += 1;
  return Math.floor(BASE_TIME_MS / 1000) + tickCounter;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FORGE_NAME = 'makefun-forge';
const FORGE_VERSION = '1.0.0';
const COMMITTER = 'MakeFun Forge <forge@make.fun>';

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

interface IssueRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

interface PullRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
}

interface RepoRec {
  dbId: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  flatCache: Map<string, Map<string, FlatEntry>>;
}

interface FlatEntry {
  oid: string;
  mode: string;
}

const reposByName = new Map<string, RepoRec>();
let viewerLogin: string | null = null;
let nextRepoDbId = 1;
let nextIssueDbId = 1;

/** Remember the token owner's login the first time a request addresses a repository by owner. */
function learnViewer(owner: string): void {
  if (viewerLogin === null && owner !== '') viewerLogin = owner;
}

/** The repository named `name` as seen by `owner`: another owner's repository is invisible. */
function findRepo(owner: string, name: string): RepoRec | null {
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (viewerLogin === null) learnViewer(owner);
  if (owner !== viewerLogin) return null;
  return repo;
}

function createRepoRecord(name: string, isPrivate: boolean, description: string): RepoRec {
  const repo: RepoRec = {
    dbId: nextRepoDbId,
    name,
    isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdAt: tickIso(),
    flatCache: new Map(),
  };
  nextRepoDbId += 1;
  reposByName.set(name, repo);
  return repo;
}

/** An error that carries the HTTP status the REST surface should answer. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

function buildCommitBytes(tree: string, parents: readonly string[], message: string, timestampSec: number): Buffer {
  const who = `${COMMITTER} ${timestampSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseTagTarget(data: Buffer): string {
  for (const line of data.subarray(0, data.indexOf('\n\n') < 0 ? data.length : data.indexOf('\n\n')).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

/** Peel an object id through annotated tags to the commit it ultimately names (or itself). */
function peelToCommit(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTagTarget(object.data);
  }
  return current;
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
function collectClosure(repo: RepoRec, roots: Iterable<string>, into: Set<string> = new Set()): Set<string> {
  const queue: string[] = [];
  for (const root of roots) if (HEX40.test(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data));
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return into;
}

/** Whether `ancestor` is `descendant` itself or reachable from it by parent edges. */
function isAncestor(repo: RepoRec, ancestor: string, descendant: string, extra?: Map<string, GitObj>): boolean {
  const lookup = (oid: string): GitObj | undefined => extra?.get(oid) ?? repo.objects.get(oid);
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
function mergeBaseOf(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queueA.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Flatten a tree object into a path -> entry map (cached per repository; entries are immutable). */
function flattenTree(repo: RepoRec, treeOid: string): Map<string, FlatEntry> {
  const cached = repo.flatCache.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  repo.flatCache.set(treeOid, out);
  return out;
}

/** The flattened file map of a commit (empty for a missing commit). */
function filesOfCommit(repo: RepoRec, commitOid: string | undefined): Map<string, FlatEntry> {
  if (commitOid === undefined) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** Build (and store) a tree hierarchy from a flattened file map; answers the root tree id. */
function buildTreeFromFlat(repo: RepoRec, files: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeBytes(entries));
  };
  return build(root);
}

/** Create a commit on `branch` whose tree is `files`, fast-forwarding the branch ref. */
function commitFiles(repo: RepoRec, branch: string, files: ReadonlyMap<string, FlatEntry>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const tree = buildTreeFromFlat(repo, files);
  const commit = storeObject(repo, 'commit', buildCommitBytes(tree, parent === undefined ? [] : [parent], message, tickSec()));
  repo.refs.set(ref, commit);
  return commit;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (never delta-compressed) objects, with its SHA-1 trailer. */
function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries (a REF_DELTA base may come from
 * `resolveBase`, for thin packs). Throws on any structural problem.
 */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset];
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes');

  const resolved = new Map<string, GitObj>();
  const byOid = new Map<string, Raw & { type: GitObjectType; out: Buffer }>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = byOid.get(entry.baseOid!);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.out, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (external === undefined) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    byOid.set(oid, { ...entry, type, out: data });
    return { type, data, oid };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    if (!resolved.has(object.oid)) resolved.set(object.oid, { type: object.type, data: object.data });
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

const PKT_MAX_PAYLOAD = 65520 - 4;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every complete pkt-line in `body`; `rest` is whatever follows the last whole packet. */
function decodePackets(body: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      // Everything after the first flush of a request is unframed (a push packfile).
      return { packets, rest: body.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error('invalid pkt-line length');
    if (offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: body.subarray(offset) };
}

/** Split decoded packets into sections divided by delim/flush control packets. */
function packetSections(packets: readonly Packet[]): Buffer[][] {
  const sections: Buffer[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload);
    else sections.push([]);
  }
  return sections;
}

function linesOf(section: readonly Buffer[]): string[] {
  return section.map((payload) => payload.toString('utf8').replace(/\n$/, ''));
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** Sorted ref entries (branches then tags, by name) for advertisements and ls-refs. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function gitAdvertise(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): Buffer {
  if (service === 'git-upload-pack' && protocolV2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${FORGE_NAME}/${FORGE_VERSION}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
  }
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch} agent=${FORGE_NAME}/${FORGE_VERSION}`
      : `${RECEIVE_CAPS} agent=${FORGE_NAME}/${FORGE_VERSION}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    let first = true;
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD\u0000${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\u0000${caps}\n` : `${oid} ${ref}\n`));
      first = false;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function gitLsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch sends: everything reachable from the wants, minus what the haves prove
 * the client holds, cut at the requested depth. Shallow boundary handling follows protocol
 * v2: `deepen N` sets the resulting history depth to N generations from the wants.
 */
function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowReq: readonly string[],
  deepen: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowReq);
  const haveSet = new Set<string>();
  for (const have of haves) {
    if (!HEX40.test(have) || !repo.objects.has(have)) continue;
    if (shallowSet.has(have)) {
      // A shallow boundary commit: the client holds the commit and its tree, nothing below.
      haveSet.add(have);
      const object = repo.objects.get(have)!;
      if (object.type === 'commit') collectClosure(repo, [parseCommit(object.data).tree], haveSet);
    } else {
      collectClosure(repo, [have], haveSet);
    }
  }
  for (const boundary of shallowSet) {
    if (!haveSet.has(boundary) && repo.objects.has(boundary)) {
      haveSet.add(boundary);
      const object = repo.objects.get(boundary)!;
      if (object.type === 'commit') collectClosure(repo, [parseCommit(object.data).tree], haveSet);
    }
  }

  const include = new Set<string>();
  const visited = new Set<string>();
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const enqueue = (oid: string, gen: number): void => {
    const known = generation.get(oid);
    if (known !== undefined && known <= gen) return;
    generation.set(oid, gen);
    queue.push({ oid, gen });
  };
  for (const want of wants) {
    if (!HEX40.test(want)) continue;
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!haveSet.has(want)) include.add(want);
      enqueue(parseTagTarget(object.data), 1);
    } else if (object.type === 'commit') {
      enqueue(want, 1);
    } else {
      if (!haveSet.has(want)) include.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (visited.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    visited.add(oid);
    if (deepen !== null && gen > deepen) continue;
    if (!haveSet.has(oid)) {
      include.add(oid);
      collectClosure(repo, [parseCommit(object.data).tree], include);
      for (const held of haveSet) include.delete(held);
    }
    // Expand to parents: always for a commit the client lacks; for a shallow boundary commit
    // only when deepening reaches past it; never for a fully-held commit.
    const expand = !haveSet.has(oid) || (shallowSet.has(oid) && deepen !== null && gen < deepen);
    if (!expand) continue;
    if (deepen !== null && gen >= deepen) continue;
    for (const parent of parseCommit(object.data).parents) enqueue(parent, gen + 1);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of include) {
    const object = repo.objects.get(oid)!;
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => repo.objects.has(parent) && !include.has(parent))) shallow.push(oid);
  }
  for (const boundary of shallowSet) {
    if (!visited.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0 || parents.every((parent) => visited.has(parent))) unshallow.push(boundary);
  }

  const objects: GitObj[] = [];
  for (const oid of include) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

/** Sideband-framed packfile packets (band 1), each pkt-line within the 65520-byte maximum. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    parts.push(pktLine(payload));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function gitFetchV2(repo: RepoRec, argLines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let deepen: number | null = null;
  for (const line of argLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallowReq, deepen);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acked = haves.filter((have) => repo.objects.has(have));
    if (acked.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktFlush());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function gitFetchV0(repo: RepoRec, sections: readonly (readonly string[])[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let deepen: number | null = null;
  let sideband = false;
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        const [oid, ...caps] = rest.split(' ');
        wants.push(oid);
        if (caps.join(' ').includes('side-band-64k')) sideband = true;
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
    }
  }
  const plan = planFetch(repo, wants, haves, shallowReq, deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (sideband) {
    parts.push(...sidebandPackets(pack));
    parts.push(pktFlush());
  } else {
    parts.push(pktFlush());
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

interface PushOutcome {
  reportLines: string[];
  sideband: boolean;
}

function gitReceivePack(repo: RepoRec, body: Buffer): PushOutcome {
  const { packets, rest } = decodePackets(body);
  const commandLines: string[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') break;
    let text = packet.payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        if (text.slice(nul + 1).includes('side-band-64k')) sideband = true;
        text = text.slice(0, nul);
      }
      first = false;
    }
    commandLines.push(text.replace(/\n$/, ''));
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) throw new Error(`bad receive-pack command: ${line.slice(0, 60)}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  let staged = new Map<string, GitObj>();
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      staged = readPack(rest, (oid) => repo.objects.get(oid));
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const lookup = (oid: string): GitObj | undefined => staged.get(oid) ?? repo.objects.get(oid);

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const failWith = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      failWith(`unpack failed: ${unpackError}`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      failWith(command.oldOid === ZERO_OID ? 'reference already exists' : 'old value mismatch');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = lookup(command.newOid);
    if (target === undefined) {
      failWith('new object not found');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      if (target.type !== 'commit' || !isAncestor(repo, command.oldOid, command.newOid, staged)) {
        failWith('non-fast-forward');
        continue;
      }
    }
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (unpackError === null) {
    for (const [oid, object] of staged) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    for (let index = 0; index < commands.length; index += 1) {
      if (!results[index].ok) continue;
      const command = commands[index];
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
  }

  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  return { reportLines, sideband };
}

// ---------------------------------------------------------------------------------------------
// Domain operations shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------------------------

function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = viewerLogin ?? '';
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1, type: 'User' },
    html_url: '',
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, default: false, description: null };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: { login: viewerLogin ?? '', id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: viewerLogin ?? '', id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = viewerLogin ?? '';
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function createIssueRecord(repo: RepoRec, input: { title?: unknown; body?: unknown; labels?: unknown }): IssueRec {
  if (typeof input.title !== 'string' || input.title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const labelNames: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const label of input.labels) {
      const name = typeof label === 'string' ? label : typeof label === 'object' && label !== null ? String((label as { name?: unknown }).name ?? '') : '';
      if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
      labelNames.push(name);
    }
  }
  const now = tickIso();
  const issue: IssueRec = {
    dbId: nextIssueDbId,
    number: repo.nextNumber,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: labelNames,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  nextIssueDbId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function addCommentRecord(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: repo.nextCommentId, body, createdAt: tickIso() };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

function createPullRecord(repo: RepoRec, input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): PullRec {
  const stripPrefix = (value: unknown): string => {
    const text = typeof value === 'string' ? value : '';
    const colon = text.indexOf(':');
    return colon >= 0 ? text.slice(colon + 1) : text;
  };
  const head = stripPrefix(input.head);
  const base = stripPrefix(input.base) || repo.defaultBranch;
  if (head === '') throw new HttpError(422, 'Validation Failed: head is required');
  if (branchTip(repo, head) === undefined) throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  if (branchTip(repo, base) === undefined) throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, 'Validation Failed: a pull request already exists for this head and base');
    }
  }
  const pull: PullRec = {
    dbId: nextIssueDbId,
    number: repo.nextNumber,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    headRef: head,
    baseRef: base,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    createdAt: tickIso(),
  };
  nextIssueDbId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

interface MergeComputation {
  conflict: boolean;
  files: Map<string, FlatEntry> | null;
}

/** The file-level three-way merge of a pull request against its base branch's current tip. */
function computeMerge(repo: RepoRec, pull: PullRec): MergeComputation {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { conflict: true, files: null };
  const base = mergeBaseOf(repo, baseTip, headTip);
  const ancestorFiles = base === null ? new Map<string, FlatEntry>() : filesOfCommit(repo, base);
  const baseFiles = filesOfCommit(repo, baseTip);
  const headFiles = filesOfCommit(repo, headTip);
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const result = new Map<string, FlatEntry>(baseFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const baseEntry = baseFiles.get(path);
    const headEntry = headFiles.get(path);
    const headChanged = !same(headEntry, ancestor);
    const baseChanged = !same(baseEntry, ancestor);
    if (headChanged && baseChanged && !same(headEntry, baseEntry)) return { conflict: true, files: null };
    if (headChanged) {
      if (headEntry === undefined) result.delete(path);
      else result.set(path, headEntry);
    }
  }
  return { conflict: false, files: result };
}

/** Squash-merge a pull request onto its base branch; answers the merge commit id. */
function mergePullRecord(repo: RepoRec, pull: PullRec): string {
  if (pull.state === 'closed' && pull.merged) throw new HttpError(405, 'Pull Request is already merged');
  if (pull.state === 'closed') throw new HttpError(405, 'Pull Request is not mergeable');
  const computation = computeMerge(repo, pull);
  if (computation.conflict || computation.files === null) throw new HttpError(405, 'Pull Request is not mergeable: conflicts must be resolved');
  const baseTip = branchTip(repo, pull.baseRef)!;
  const tree = buildTreeFromFlat(repo, computation.files);
  const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}`;
  const commit = storeObject(repo, 'commit', buildCommitBytes(tree, [baseTip], message, tickSec()));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commit;
  pull.mergedAt = tickIso();
  return commit;
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const linesOf = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const available = counts.get(line) ?? 0;
    if (available > 0) counts.set(line, available - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of counts.values()) deletions += count;
  return { additions, deletions };
}

/** The changed paths of a pull request: its head tree against the merge-base tree. */
function pullChanges(repo: RepoRec, pull: PullRec): FileChange[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBaseOf(repo, baseTip, headTip);
  const ancestorFiles = base === null ? new Map<string, FlatEntry>() : filesOfCommit(repo, base);
  const headFiles = filesOfCommit(repo, headTip);
  const textOf = (entry: FlatEntry | undefined): string => {
    if (entry === undefined) return '';
    const object = repo.objects.get(entry.oid);
    return object === undefined ? '' : object.data.toString('utf8');
  };
  const changes: FileChange[] = [];
  const paths = new Set<string>([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = ancestorFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const { additions, deletions } = lineDiff(textOf(before), textOf(after));
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Resolve a `ref` query value (branch name or commit id) to a commit id. */
function resolveRef(repo: RepoRec, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  const branch = branchTip(repo, ref);
  if (branch !== undefined) return branch;
  if (HEX40.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    if (object !== undefined && object.type === 'tag') return peelToCommit(repo, ref);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${SHOP_TOKEN}`;
}

/** Parse a positive-int query parameter with a fallback. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

/** Commit `files` onto `branch`, creating the branch from the default branch's tip when new. */
function commitToBranch(repo: RepoRec, branch: string, files: ReadonlyMap<string, FlatEntry>, message: string): string {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref);
  if (parent === undefined && branch !== repo.defaultBranch) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const tree = buildTreeFromFlat(repo, files);
  const commit = storeObject(repo, 'commit', buildCommitBytes(tree, parent === undefined ? [] : [parent], message, tickSec()));
  repo.refs.set(ref, commit);
  return commit;
}

/** The mutable file map a branch write starts from (its own tip, else the default branch's). */
function branchFiles(repo: RepoRec, branch: string): Map<string, FlatEntry> {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return new Map(filesOfCommit(repo, tip));
}

/** Walk a tree to the entry at `path` (null when absent). */
function treeEntryAt(repo: RepoRec, treeOid: string, path: string): TreeEntry | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The entries of the directory at `path` ('' = root), or null when it is not a directory. */
function dirEntries(repo: RepoRec, treeOid: string, path: string): TreeEntry[] | null {
  if (path === '') {
    const object = repo.objects.get(treeOid);
    return object !== undefined && object.type === 'tree' ? parseTree(object.data) : null;
  }
  const entry = treeEntryAt(repo, treeOid, path);
  if (entry === null || entry.mode !== '40000') return null;
  const object = repo.objects.get(entry.oid);
  return object !== undefined && object.type === 'tree' ? parseTree(object.data) : null;
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: tickIso() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: parseAuthorLine(commit.author),
      committer: parseAuthorLine(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function paginate<T>(items: readonly T[], url: URL): T[] {
  const perPage = intParam(url, 'per_page', 30);
  const page = intParam(url, 'page', 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const raw = await readBody(req);
  const body = (): Record<string, unknown> => asRecord(parseJsonBody(raw));

  if (rest.length === 0) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', user_repositories_url: '/api/v3/user/repos' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { installed_version: FORGE_VERSION, github_services_sha: 'forge' });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: viewerLogin ?? '', id: 1, type: 'User', name: viewerLogin ?? '' });
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const input = body();
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new HttpError(422, 'Validation Failed: name is invalid');
      if (reposByName.has(name)) throw new HttpError(422, 'Validation Failed: name already exists on this account');
      const repo = createRepoRecord(name, input.private === true, typeof input.description === 'string' ? input.description : '');
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const all = [...reposByName.values()].sort((a, b) => a.dbId - b.dbId);
      const perPage = intParam(url, 'per_page', 30);
      const page = intParam(url, 'page', 1);
      const items = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const origin = `http://${req.headers.host ?? 'localhost'}`;
        const lastPage = Math.ceil(all.length / perPage);
        headers.link =
          `<${origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next", ` +
          `<${origin}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}>; rel="last"`;
      }
      sendJson(res, 200, items.map(repoJson), headers);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw new HttpError(404, 'Not Found');
  const owner = rest[1];
  const repoName = rest[2];
  learnViewer(owner);
  const repo = findRepo(owner, repoName);
  if (repo === null) throw new HttpError(404, 'Not Found');
  const sub = rest.slice(3);

  if (sub.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const input = body();
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      reposByName.delete(repo.name);
      sendJson(res, 204, undefined);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'branches') {
    if (sub.length === 1 && method === 'GET') {
      const branches = sortedRefs(repo)
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const tip = branchTip(repo, sub[1]);
      if (tip === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { name: sub[1], commit: { sha: tip }, protected: false });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'commits') {
    if (sub.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, url.searchParams.get('sha') ?? undefined);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return;
      }
      const ordered: string[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        ordered.push(oid);
        const parents = parseCommit(object.data).parents;
        for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
      }
      sendJson(res, 200, paginate(ordered, url).map((oid) => commitJson(repo, oid)));
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const object = repo.objects.get(sub[1]);
      if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, commitJson(repo, sub[1]));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (sub.length === 2) {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          sortedRefs(repo).map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } })),
        );
        return;
      }
      if (method === 'POST') {
        const input = body();
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !HEX40.test(sha) || !repo.objects.has(sha)) {
          throw new HttpError(422, 'Validation Failed: ref or sha is invalid');
        }
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (method === 'GET') {
      const ref = `refs/${sub.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'contents') {
    const path = sub.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, url.searchParams.get('ref') ?? undefined);
      if (tip === undefined) throw new HttpError(404, 'Not Found');
      const tree = parseCommit(repo.objects.get(tip)!.data).tree;
      if (path !== '') {
        const entry = treeEntryAt(repo, tree, path);
        if (entry !== null && entry.mode !== '40000') {
          const blob = repo.objects.get(entry.oid)!;
          sendJson(res, 200, {
            type: 'file',
            name: path.split('/').pop(),
            path,
            sha: entry.oid,
            size: blob.data.length,
            encoding: 'base64',
            content: blob.data.toString('base64'),
          });
          return;
        }
      }
      const entries = dirEntries(repo, tree, path);
      if (entries === null) throw new HttpError(404, 'Not Found');
      sendJson(
        res,
        200,
        entries.map((entry) => {
          const isDir = entry.mode === '40000';
          const object = repo.objects.get(entry.oid);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: path === '' ? entry.name : `${path}/${entry.name}`,
            sha: entry.oid,
            size: isDir ? 0 : (object?.data.length ?? 0),
          };
        }),
      );
      return;
    }
    if (method === 'PUT') {
      const input = body();
      if (path === '') throw new HttpError(422, 'Validation Failed: path is required');
      if (typeof input.message !== 'string' || typeof input.content !== 'string') {
        throw new HttpError(422, 'Validation Failed: message and content are required');
      }
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const files = branchFiles(repo, branch);
      const existing = files.get(path);
      let status = 201;
      if (existing !== undefined) {
        if (typeof input.sha !== 'string') throw new HttpError(422, 'Validation Failed: sha is required when updating a file');
        if (input.sha !== existing.oid) throw new HttpError(409, 'Conflict: the sha does not match the current file');
        status = 200;
      }
      const blob = storeObject(repo, 'blob', Buffer.from(input.content, 'base64'));
      files.set(path, { oid: blob, mode: '100644' });
      const commit = commitToBranch(repo, branch, files, input.message);
      sendJson(res, status, {
        content: { name: path.split('/').pop(), path, sha: blob, size: files.get(path) !== undefined ? Buffer.from(input.content, 'base64').length : 0, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message: input.message },
      });
      return;
    }
    if (method === 'DELETE') {
      const input = body();
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const files = branchFiles(repo, branch);
      const existing = files.get(path);
      if (existing === undefined) throw new HttpError(404, 'Not Found');
      if (typeof input.sha === 'string' && input.sha !== existing.oid) throw new HttpError(409, 'Conflict: the sha does not match the current file');
      files.delete(path);
      const commit = commitToBranch(repo, branch, files, typeof input.message === 'string' ? input.message : `Delete ${path}`);
      sendJson(res, 200, { content: null, commit: { sha: commit, message: typeof input.message === 'string' ? input.message : '' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'labels' && sub.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label.name, label.color)));
      return;
    }
    if (method === 'POST') {
      const input = body();
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, labelJson(name, color));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'issues') {
    if (sub.length === 1) {
      if (method === 'POST') {
        const issue = createIssueRecord(repo, body());
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendJson(res, 200, paginate(list, url).map((issue) => issueJson(repo, issue)));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number.parseInt(sub[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (sub.length === 2) {
      if (issue === undefined) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const input = body();
        if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        issue.updatedAt = tickIso();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (sub.length === 3 && sub[2] === 'comments') {
      if (issue === undefined) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return;
      }
      if (method === 'POST') {
        const input = body();
        if (typeof input.body !== 'string') throw new HttpError(422, 'Validation Failed: body is required');
        const comment = addCommentRecord(repo, issue, input.body);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sub[0] === 'pulls') {
    if (sub.length === 1) {
      if (method === 'POST') {
        const pull = createPullRecord(repo, body());
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, paginate(list, url).map((pull) => pullJson(repo, pull)));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number.parseInt(sub[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (sub.length === 2 && method === 'GET') {
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, pullChanges(repo, pull).map((change) => ({ filename: change.filename, status: change.status, additions: change.additions, deletions: change.deletions, changes: change.changes })));
      return;
    }
    if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      // The body is optional; a malformed one is still a merge attempt on a real pull request.
      try {
        parseJsonBody(raw);
      } catch {
        /* ignored: merge does not need the body */
      }
      const sha = mergePullRecord(repo, pull);
      sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selectionSet: GqlSelection[] | null;
}

interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: GqlSelection[];
}

interface GqlFragmentSpread {
  kind: 'spread';
  name: string;
}

type GqlSelection = GqlField | GqlInlineFragment | GqlFragmentSpread;

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
}

function gqlLex(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(index + 3, end)}"`);
        index = end + 3;
        continue;
      }
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          const escape = source[cursor + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 6), 16));
            cursor += 6;
          } else {
            value += map[escape] ?? escape;
            cursor += 2;
          }
        } else {
          value += source[cursor];
          cursor += 1;
        }
      }
      if (cursor >= source.length) throw new Error('unterminated string');
      tokens.push(`"${value}"`);
      index = cursor + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      index += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
    if (numberMatch !== null) {
      tokens.push(numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private position = 0;

  constructor(source: string) {
    this.tokens = gqlLex(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new Error('unexpected end of document');
    this.position += 1;
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected ${token}, got ${actual}`);
  }

  private skipType(): void {
    // A type reference: Name, [Type], with optional ! suffixes.
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d/.test(token) || /^-?\d+(\.\d+)?[eE]/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  private parseArguments(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.next();
    return args;
  }

  private parseDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') selections.push(this.parseSelection());
    this.next();
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>();
    while (this.position < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== undefined) name = this.next();
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            this.next(); // variable name
            this.expect(':');
            this.skipType();
            if (this.peek() === '=') {
              this.next();
              this.parseValue();
            }
            this.parseDirectives();
          }
          this.next();
        }
        this.parseDirectives();
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.parseDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }
}

// --- schema -------------------------------------------------------------------------------

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository', 'addLabel', 'removeLabel'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'databaseId', 'createdAt', 'updatedAt', 'isViewer', 'resourcePath'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'resourcePath', 'sshUrl', 'homepageUrl', 'stargazerCount', 'forkCount', 'labels',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'locked', 'assignees', 'participants', 'milestone', 'reactionGroups', 'viewerCanReact', 'viewerCanUpdate', 'resourcePath',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'files', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergedBy', 'mergeCommit',
    'additions', 'deletions', 'changedFiles', 'commits', 'comments', 'reviews', 'labels', 'url', 'resourcePath', 'isDraft', 'locked',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'specifiedByURL', 'isOneOf'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const GQL_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueCommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  PullRequestReviewState: ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'],
};

/** The return type of an object field, for completion; unlisted fields are scalars. */
const GQL_FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', user: 'User', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    reopenIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection', repository: 'Repository', author: 'User' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]' },
};

// --- values ---------------------------------------------------------------------------------

type GqlObject = { gqlType: string; [key: string]: unknown };

const encodeGid = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGql(repo: RepoRec): GqlObject {
  return { gqlType: 'Repository', repo };
}

function issueGql(repo: RepoRec, issue: IssueRec): GqlObject {
  return { gqlType: 'Issue', repo, issue };
}

function pullGql(repo: RepoRec, pull: PullRec): GqlObject {
  return { gqlType: 'PullRequest', repo, pull };
}

function repoByDbId(dbId: number): RepoRec | null {
  for (const repo of reposByName.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of value.fields) out[key] = evalValue(field, variables);
      return out;
    }
  }
}

function evalArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, variables);
  return out;
}

// --- resolvers ------------------------------------------------------------------------------

type Resolver = (source: GqlObject, args: Record<string, unknown>) => unknown;

const issueCursor = (number: number): string => encodeGid(`cursor:${number}`);

function decodeCursor(cursor: string): number | null {
  const decoded = decodeGid(cursor);
  if (decoded === null || decoded.kind !== 'cursor') return null;
  const value = Number.parseInt(decoded.parts[0], 10);
  return Number.isFinite(value) ? value : null;
}

const GQL_RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ gqlType: 'User', login: viewerLogin ?? '' }),
    repository: (_source, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      learnViewer(owner);
      const repo = findRepo(owner, name);
      return repo === null ? null : repoGql(repo);
    },
    node: (_source, args) => {
      const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
        return repo === null ? null : repoGql(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
        const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
        return repo !== null && repo !== undefined && issue !== undefined ? issueGql(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
        const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1], 10));
        return repo !== null && repo !== undefined && pull !== undefined ? pullGql(repo, pull) : null;
      }
      if (decoded.kind === 'User') return { gqlType: 'User', login: viewerLogin ?? '' };
      return null;
    },
    __type: (_source, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (GQL_ENUMS[name] !== undefined) return { gqlType: '__Type', typeName: name, kind: 'ENUM', values: GQL_ENUMS[name] };
      if (GQL_TYPE_FIELDS[name] !== undefined) return { gqlType: '__Type', typeName: name, kind: 'OBJECT', values: null };
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = asRecord(args.input);
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: repositoryId does not name a repository');
      const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
      if (repo === null) throw new Error('createIssue: repository not found');
      const issue = createIssueRecord(repo, { title: input.title, body: input.body });
      return { gqlType: 'CreateIssuePayload', issue: issueGql(repo, issue) };
    },
    closeIssue: (_source, args) => {
      const input = asRecord(args.input);
      const decoded = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: issueId does not name an issue');
      const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('closeIssue: issue not found');
      issue.state = 'closed';
      issue.updatedAt = tickIso();
      return { gqlType: 'CloseIssuePayload', issue: issueGql(repo, issue) };
    },
    createPullRequest: (_source, args) => {
      const input = asRecord(args.input);
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: repositoryId does not name a repository');
      const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const pull = createPullRecord(repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
      return { gqlType: 'CreatePullRequestPayload', pullRequest: pullGql(repo, pull) };
    },
    mergePullRequest: (_source, args) => {
      const input = asRecord(args.input);
      const decoded = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: pullRequestId does not name a pull request');
      const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
      const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1], 10));
      if (repo === null || repo === undefined || pull === undefined) throw new Error('mergePullRequest: pull request not found');
      mergePullRecord(repo, pull);
      return { gqlType: 'MergePullRequestPayload', pullRequest: pullGql(repo, pull) };
    },
    addComment: (_source, args) => {
      const input = asRecord(args.input);
      const decoded = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('addComment: subjectId does not name an issue');
      const repo = repoByDbId(Number.parseInt(decoded.parts[0], 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('addComment: issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addCommentRecord(repo, issue, body);
      return {
        gqlType: 'AddCommentPayload',
        commentEdge: {
          gqlType: 'IssueCommentEdge',
          cursor: issueCursor(issue.number),
          node: { gqlType: 'IssueComment', gid: encodeGid(`IssueComment:${repo.dbId}:${issue.number}:${comment.id}`), body: comment.body },
        },
      };
    },
  },
  User: {
    id: () => encodeGid('User:1'),
    login: (source) => source.login,
    name: (source) => source.login,
  },
  Repository: {
    id: (source) => encodeGid(`Repository:${(source.repo as RepoRec).dbId}`),
    databaseId: (source) => (source.repo as RepoRec).dbId,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${viewerLogin ?? ''}/${(source.repo as RepoRec).name}`,
    owner: () => ({ gqlType: 'User', login: viewerLogin ?? '' }),
    description: (source) => (source.repo as RepoRec).description,
    isPrivate: (source) => (source.repo as RepoRec).isPrivate,
    defaultBranchRef: (source) => {
      const repo = source.repo as RepoRec;
      if (branchTip(repo, repo.defaultBranch) === undefined) return null;
      return { gqlType: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    createdAt: (source) => (source.repo as RepoRec).createdAt,
    updatedAt: (source) => (source.repo as RepoRec).createdAt,
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueGql(repo, issue);
    },
    issues: (source, args) => {
      const repo = source.repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = asRecord(args.orderBy);
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
      list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      let start = 0;
      if (typeof args.after === 'string') {
        const cursorNumber = decodeCursor(args.after);
        const index = cursorNumber === null ? -1 : list.findIndex((issue) => issue.number === cursorNumber);
        start = index >= 0 ? index + 1 : 0;
      }
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
      const page = list.slice(start, start + first);
      const hasNextPage = start + page.length < list.length;
      return {
        gqlType: 'IssueConnection',
        nodes: page.map((issue) => issueGql(repo, issue)),
        pageInfo: {
          gqlType: 'PageInfo',
          hasNextPage,
          hasPreviousPage: start > 0,
          startCursor: page.length > 0 ? issueCursor(page[0].number) : null,
          endCursor: page.length > 0 ? issueCursor(page[page.length - 1].number) : null,
        },
        totalCount: list.length,
      };
    },
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullGql(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = source.repo as RepoRec;
      let list = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        const wanted = new Set(states);
        list = [...repo.pulls.values()].filter((pull) => {
          const gqlState = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          return wanted.has(gqlState);
        });
      }
      list.sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
      const page = list.slice(0, first);
      return {
        gqlType: 'PullRequestConnection',
        nodes: page.map((pull) => pullGql(repo, pull)),
        pageInfo: { gqlType: 'PageInfo', hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: list.length,
      };
    },
  },
  Ref: {
    name: (source) => source.name,
  },
  Issue: {
    id: (source) => encodeGid(`Issue:${(source.repo as RepoRec).dbId}:${(source.issue as IssueRec).number}`),
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => ((source.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (source) => (source.issue as IssueRec).createdAt,
    updatedAt: (source) => (source.issue as IssueRec).updatedAt,
    repository: (source) => repoGql(source.repo as RepoRec),
  },
  PullRequest: {
    id: (source) => encodeGid(`PullRequest:${(source.repo as RepoRec).dbId}:${(source.pull as PullRec).number}`),
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source.pull as PullRec).merged,
    mergedAt: (source) => (source.pull as PullRec).mergedAt,
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    mergeable: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return computeMerge(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
      const changes = pullChanges(repo, pull).slice(0, first);
      return {
        gqlType: 'PullRequestChangedFileConnection',
        nodes: changes.map((change) => ({ gqlType: 'PullRequestChangedFile', path: change.filename, additions: change.additions, deletions: change.deletions })),
        pageInfo: { gqlType: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: changes.length,
      };
    },
    createdAt: (source) => (source.pull as PullRec).createdAt,
    updatedAt: (source) => (source.pull as PullRec).createdAt,
    repository: (source) => repoGql(source.repo as RepoRec),
  },
  IssueComment: {
    id: (source) => source.gid,
    body: (source) => source.body,
  },
  __Type: {
    name: (source) => source.typeName,
    kind: (source) => source.kind,
    fields: (source) => {
      const fields = GQL_TYPE_FIELDS[source.typeName as string];
      if (fields === undefined) return null;
      return fields.map((name) => ({ gqlType: '__Field', fieldName: name }));
    },
    enumValues: (source) => {
      const values = source.values as string[] | null;
      if (values === null) return null;
      return values.map((name) => ({ gqlType: '__EnumValue', valueName: name }));
    },
  },
  __Field: {
    name: (source) => source.fieldName,
  },
  __EnumValue: {
    name: (source) => source.valueName,
  },
};

// --- validation and execution ---------------------------------------------------------------

function gqlValidate(typeName: string, selections: readonly GqlSelection[], document: GqlDocument, errors: string[]): void {
  const fields = GQL_TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      gqlValidate(selection.typeCondition ?? typeName, selection.selectionSet, document, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = document.fragments.get(selection.name);
      if (fragment !== undefined) gqlValidate(fragment.typeCondition ?? typeName, fragment.selectionSet, document, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (typeName === 'Query' && (selection.name === '__type' || selection.name === '__schema')) {
      if (selection.selectionSet !== null) gqlValidate('__Type', selection.selectionSet, document, errors);
      continue;
    }
    if (fields === undefined || !fields.includes(selection.name)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (selection.selectionSet !== null) {
      const returnType = GQL_FIELD_TYPES[typeName]?.[selection.name];
      if (returnType !== undefined) gqlValidate(returnType.replace(/[\[\]!]/g, ''), selection.selectionSet, document, errors);
    }
  }
}

interface GqlContext {
  document: GqlDocument;
  variables: Record<string, unknown>;
}

function gqlExecuteSelectionSet(typeName: string, source: GqlObject, selections: readonly GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The concrete type of the wrapped value drives resolver lookup: a Repository reached through
  // the Node interface still resolves its own fields (id included).
  const implType = typeof source?.gqlType === 'string' ? source.gqlType : typeName;
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node' || source.gqlType === selection.typeCondition) {
        Object.assign(out, gqlExecuteSelectionSet(selection.typeCondition ?? typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName || source.gqlType === fragment.typeCondition)) {
        Object.assign(out, gqlExecuteSelectionSet(fragment.typeCondition ?? typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = implType;
      continue;
    }
    const args = evalArgs(selection, ctx.variables);
    let value: unknown;
    if (typeName === 'Query' && selection.name === '__type') {
      value = GQL_RESOLVERS.Query.__type(source, args);
    } else {
      const resolver = GQL_RESOLVERS[implType]?.[selection.name] ?? GQL_RESOLVERS[typeName]?.[selection.name];
      if (resolver !== undefined) value = resolver(source, args);
      else if (source !== null && typeof source === 'object') value = (source as Record<string, unknown>)[selection.name];
      else value = null;
    }
    const returnType = GQL_FIELD_TYPES[implType]?.[selection.name] ?? GQL_FIELD_TYPES[typeName]?.[selection.name] ?? (selection.name === '__type' ? '__Type' : undefined);
    out[key] = gqlComplete(returnType, value, selection, ctx);
  }
  return out;
}

function gqlComplete(returnType: string | undefined, value: unknown, selection: GqlField, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (returnType === undefined) return value;
  const isList = returnType.startsWith('[');
  const named = returnType.replace(/[\[\]!]/g, '');
  if (GQL_TYPE_FIELDS[named] === undefined && GQL_ENUMS[named] === undefined) return value; // a scalar
  if (selection.selectionSet === null) return value;
  if (isList) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => (item === null || item === undefined ? null : gqlExecuteSelectionSet(named, item as GqlObject, selection.selectionSet!, ctx)));
  }
  return gqlExecuteSelectionSet(named, value as GqlObject, selection.selectionSet, ctx);
}

function gqlRunOperation(document: GqlDocument, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  gqlValidate(rootType, operation.selectionSet, document, errors);
  if (errors.length > 0) return { errors: errors.map((message) => ({ message })) };
  try {
    const data = gqlExecuteSelectionSet(rootType, { gqlType: rootType }, operation.selectionSet, { document, variables });
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const record = asRecord(entry);
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = asRecord(record.variables);
    let document: GqlDocument;
    try {
      document = new GqlParser(query).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    let operation = document.operations[0];
    if (typeof record.operationName === 'string') {
      operation = document.operations.find((candidate) => candidate.name === record.operationName) ?? operation;
    }
    if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
    return gqlRunOperation(document, operation, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------------------------
// MCP (Model Context Protocol over streamable HTTP)
// ---------------------------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner (defaults to the authenticated user).' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const MCP_SERVER_INFO = { name: FORGE_NAME, version: FORGE_VERSION };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpRepoArg(args: Record<string, unknown>): RepoRec {
  const owner = typeof args.owner === 'string' ? args.owner : (viewerLogin ?? '');
  const name = typeof args.repo === 'string' ? args.repo : '';
  learnViewer(owner);
  const repo = findRepo(owner, name);
  if (repo === null) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw Object.assign(new Error(`unknown tool: ${name}`), { rpcCode: -32602 });
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      throw Object.assign(new Error(`missing required argument: ${required}`), { rpcCode: -32602 });
    }
  }
  let result: unknown;
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (reposByName.has(repoName)) throw new Error(`repository ${repoName} already exists`);
      const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      result = repoJson(repo);
      break;
    }
    case 'get_repo': {
      result = repoJson(mcpRepoArg(args));
      break;
    }
    case 'list_repos': {
      result = { repos: [...reposByName.values()].sort((a, b) => a.dbId - b.dbId).map(repoJson) };
      break;
    }
    case 'create_issue': {
      const repo = mcpRepoArg(args);
      const issue = createIssueRecord(repo, { title: args.title, body: args.body });
      result = issueJson(repo, issue);
      break;
    }
    case 'list_issues': {
      const repo = mcpRepoArg(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      result = { issues: list.map((issue) => issueJson(repo, issue)) };
      break;
    }
    case 'create_pull_request': {
      const repo = mcpRepoArg(args);
      const pull = createPullRecord(repo, { title: args.title, body: args.body, head: args.head, base: args.base });
      result = pullJson(repo, pull);
      break;
    }
    case 'merge_pull_request': {
      const repo = mcpRepoArg(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      const sha = mergePullRecord(repo, pull);
      result = { number: pull.number, merged: true, sha, state: 'closed' };
      break;
    }
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { rpcCode: -32602 });
  }
  const record = asRecord(result);
  return {
    content: [{ type: 'text', text: JSON.stringify(record) }],
    structuredContent: record,
    isError: false,
  };
}

function mcpDispatch(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = asRecord(request.params);
  const isNotification = !('id' in request);
  const result = (value: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result: value });
  const failure = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'server/discover':
      return result({
        resultType: 'complete',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': MCP_SUPPORTED_VERSIONS[0],
        },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return result({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = asRecord(params.arguments);
      try {
        return result(mcpCallTool(name, args));
      } catch (err) {
        const rpcCode = (err as { rpcCode?: number }).rpcCode;
        if (typeof rpcCode === 'number') return failure(rpcCode, err instanceof Error ? err.message : String(err));
        return result({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return failure(-32601, `method not found: ${method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const response = mcpDispatch(asRecord(entry));
      if (response !== null) responses.push(response);
    }
    sendJson(res, 200, responses);
    return;
  }
  const request = asRecord(parsed);
  const response = mcpDispatch(request);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------------------------
// Git HTTP routing
// ---------------------------------------------------------------------------------------------

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string, tail: string): Promise<void> {
  const method = req.method ?? 'GET';
  learnViewer(owner);
  const repo = findRepo(owner, repoName);
  if (tail === 'info/refs' && method === 'GET') {
    if (repo === null) throw new HttpError(404, 'Not Found');
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Bad service');
    const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    sendRaw(res, 200, gitAdvertise(repo, service, protocolV2), `application/x-${service}-advertisement`);
    return;
  }
  if (tail === 'git-upload-pack' && method === 'POST') {
    if (repo === null) throw new HttpError(404, 'Not Found');
    const raw = await readBody(req);
    let decoded: { packets: Packet[]; rest: Buffer };
    try {
      decoded = decodePackets(raw, false);
    } catch {
      throw new HttpError(400, 'Malformed pkt-line request');
    }
    const sections = packetSections(decoded.packets);
    const firstLine = sections[0]?.[0]?.toString('utf8') ?? '';
    if (firstLine.startsWith('command=')) {
      const command = firstLine.replace(/\n$/, '').slice('command='.length);
      const argLines = linesOf(sections[1] ?? []);
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const line of argLines) {
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        sendRaw(res, 200, gitLsRefs(repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        sendRaw(res, 200, gitFetchV2(repo, argLines), 'application/x-git-upload-pack-result');
        return;
      }
      throw new HttpError(400, `Unsupported command ${command}`);
    }
    // Protocol v0: two flush-separated sections (wants, then haves). decodePackets stops at
    // the first flush, so the second section arrives in `rest` and is decoded separately.
    let lineSections = sections.map((section) => linesOf(section));
    if (decoded.rest.length > 0) {
      let moreSections: string[][];
      try {
        moreSections = packetSections(decodePackets(decoded.rest).packets).map((section) => linesOf(section));
      } catch {
        throw new HttpError(400, 'Malformed pkt-line request');
      }
      lineSections = [...lineSections.slice(0, -1), ...moreSections];
    }
    sendRaw(res, 200, gitFetchV0(repo, lineSections), 'application/x-git-upload-pack-result');
    return;
  }
  if (tail === 'git-receive-pack' && method === 'POST') {
    if (repo === null) throw new HttpError(404, 'Not Found');
    const raw = await readBody(req);
    let outcome: PushOutcome;
    try {
      outcome = gitReceivePack(repo, raw);
    } catch {
      throw new HttpError(400, 'Malformed receive-pack request');
    }
    const report = Buffer.concat(outcome.reportLines.map((line) => pktLine(`${line}\n`)));
    if (outcome.sideband) {
      // The report stream is pkt-framed *inside* band 1, including its terminating flush;
      // a second flush on the wire ends the sideband itself.
      const framed = Buffer.concat([report, pktFlush()]);
      const parts: Buffer[] = [];
      const CHUNK = 32768;
      for (let offset = 0; offset < framed.length; offset += CHUNK) {
        const chunk = framed.subarray(offset, Math.min(framed.length, offset + CHUNK));
        const payload = Buffer.allocUnsafe(chunk.length + 1);
        payload[0] = 1;
        chunk.copy(payload, 1);
        parts.push(pktLine(payload));
      }
      parts.push(pktFlush());
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
    } else {
      sendRaw(res, 200, Buffer.concat([report, pktFlush()]), 'application/x-git-receive-pack-result');
    }
    return;
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const segments = path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) throw new HttpError(401, 'Bad credentials');
          await handleRest(req, res, url, segments);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') throw new HttpError(404, 'Not Found');
          if (!authorized(req)) throw new HttpError(401, 'Bad credentials');
          await handleGraphql(req, res);
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') throw new HttpError(404, 'Not Found');
          if (!authorized(req)) throw new HttpError(401, 'Bad credentials');
          await handleMcp(req, res);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized(req)) throw new HttpError(401, 'Bad credentials');
          await handleGit(req, res, url, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3]);
          return;
        }

        throw new HttpError(404, 'Not Found');
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
