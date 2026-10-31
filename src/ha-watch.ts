/**
 * Watching the shop's Home Assistant on the platform's behalf.
 *
 * The platform hands a bot the Home Assistant addresses to try, a read-only token and the entities it
 * cares about (`ha.watch`). The bot subscribes with `subscribe_entities` and reports `ha.status` (also
 * every 60 s, as a heartbeat) and `ha.states` back over its platform connection, every report carrying
 * the term of the assignment it answers; that is how the platform tells a current watcher from a
 * replaced one. This is the same job a HINATA IO does, in the same shape, so the platform treats both
 * alike.
 *
 * Addresses are tried in order, the one that worked last first. Each gets a connect timeout, because
 * without one a dead address costs whatever the operating system waits (over a minute) every time, and
 * "down" is reported only once a whole round of addresses has failed: one that cannot be reached must
 * not look like a lost connection while the next is about to work.
 */
import type { SocketFactory, SocketLike } from "./index.js";

/** What the platform asks for: one entry per Home Assistant. */
export type HaConnection = { id: string; urls: string[]; token: string; entities: string[] };
export type HaWatch = { term: number; connections: HaConnection[] };

export type HaTiming = {
  /** How long one address gets to accept the connection. */
  connectMs: number;
  /** How long it then gets to sign in. */
  authMs: number;
  heartbeatMs: number;
  firstRetryMs: number;
  maxRetryMs: number;
};

export const HA_TIMING: HaTiming = {
  connectMs: 10_000,
  authMs: 10_000,
  // The same beat as a machine's IO: the platform gives a watcher two beats of
  // lease plus slack, and does not care whether the watcher is a bot or a box.
  heartbeatMs: 60_000,
  firstRetryMs: 2_000,
  maxRetryMs: 60_000,
};

const SUBSCRIPTION_ID = 1;
/** The attributes the platform uses; Home Assistant reports many more and forwarding them is only traffic. */
const KEPT_ATTRIBUTES = [
  "hvac_modes",
  "fan_modes",
  "min_temp",
  "max_temp",
  "target_temp_step",
  "temperature",
  "current_temperature",
  "fan_mode",
];

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => !!value && typeof value === "object" && !Array.isArray(value);
const seconds = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type EntityState = {
  state: string;
  attributes: Record_;
  /** Unix seconds, as Home Assistant's compressed state gives it. */
  lastChanged: number | null;
  /**
   * Unix seconds of the last change to the state or any attribute. Unlike `lastChanged` it moves on an
   * attribute-only change, which is what lets the platform order reports from two watchers.
   */
  lastUpdated: number | null;
};

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );

/**
 * Two states are the same when what is reported is the same. `lastUpdated` moves with attributes that
 * are never reported, so it must not make an otherwise identical state look changed.
 */
const same = (a: EntityState, b: EntityState) =>
  a.state === b.state && a.lastChanged === b.lastChanged && stable(a.attributes) === stable(b.attributes);

function kept(attributes: unknown): Record_ {
  if (!isRecord(attributes)) return {};
  return Object.fromEntries(Object.entries(attributes).filter(([name]) => KEPT_ATTRIBUTES.includes(name)));
}

/**
 * Apply one `subscribe_entities` event (`a` added, `c` changed, `r` removed) and return the entities
 * whose reported fields changed.
 */
export function applyEvent(states: Map<string, EntityState>, event: unknown): string[] {
  const changed: string[] = [];
  const put = (id: string, next: EntityState) => {
    const current = states.get(id);
    if (current && same(current, next)) return;
    states.set(id, next);
    changed.push(id);
  };
  if (!isRecord(event)) return changed;
  if (isRecord(event.a)) {
    for (const [id, compressed] of Object.entries(event.a)) {
      if (!isRecord(compressed)) continue;
      put(id, {
        state: typeof compressed.s === "string" ? compressed.s : "unknown",
        attributes: kept(compressed.a),
        lastChanged: seconds(compressed.lc),
        lastUpdated: seconds(compressed.lu),
      });
    }
  }
  if (isRecord(event.c)) {
    for (const [id, diff] of Object.entries(event.c)) {
      if (!isRecord(diff)) continue;
      const base = states.get(id);
      const next: EntityState = base
        ? { ...base, attributes: { ...base.attributes } }
        : { state: "", attributes: {}, lastChanged: null, lastUpdated: null };
      if (isRecord(diff["+"])) {
        const plus = diff["+"];
        if (typeof plus.s === "string") next.state = plus.s;
        Object.assign(next.attributes, kept(plus.a));
        if (seconds(plus.lc) !== null) next.lastChanged = seconds(plus.lc);
        if (seconds(plus.lu) !== null) next.lastUpdated = seconds(plus.lu);
      }
      const minus = isRecord(diff["-"]) ? diff["-"].a : undefined;
      if (Array.isArray(minus)) for (const name of minus) if (typeof name === "string") delete next.attributes[name];
      put(id, next);
    }
  }
  if (Array.isArray(event.r)) for (const id of event.r) if (typeof id === "string") states.delete(id);
  return changed;
}

export function statesFrame(term: number, connection: string, full: boolean, states: Map<string, EntityState>, ids: string[]) {
  return {
    type: "ha",
    method: "ha.states",
    params: {
      term,
      connection,
      full,
      states: ids.flatMap((id) => {
        const state = states.get(id);
        return state
          ? [{ entity_id: id, state: state.state, last_changed: state.lastChanged, last_updated: state.lastUpdated, attributes: state.attributes }]
          : [];
      }),
    },
  };
}

export function statusFrame(term: number, connection: string, connected: boolean, error: string | null) {
  return { type: "ha", method: "ha.status", params: { term, connection, connected, error } };
}

/** `http(s)://host[:port]` to the WebSocket API address; null for anything else. */
export function websocketUrl(base: string): string | null {
  const trimmed = base.trim().replace(/\/+$/, "");
  const match = /^(https?):\/\/(.+)$/i.exec(trimmed);
  if (!match) return null;
  return `${match[1]!.toLowerCase() === "https" ? "wss" : "ws"}://${match[2]}/api/websocket`;
}

/** The addresses in the order to try them: rotated to start at the one that worked last. */
export function attemptOrder(length: number, lastGood: number): number[] {
  return Array.from({ length }, (_, step) => (lastGood + step) % length);
}

/** An `ha.watch` body, or null when it is not one (the platform then has nothing for this bot to watch). */
export function parseWatch(value: unknown): HaWatch | null {
  if (!isRecord(value) || typeof value.term !== "number" || !Array.isArray(value.connections)) return null;
  const connections: HaConnection[] = [];
  for (const item of value.connections) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.token !== "string") return null;
    if (!Array.isArray(item.urls) || !item.urls.every((url) => typeof url === "string")) return null;
    if (!Array.isArray(item.entities) || !item.entities.every((entity) => typeof entity === "string")) return null;
    connections.push({ id: item.id, urls: item.urls as string[], token: item.token, entities: item.entities as string[] });
  }
  return { term: value.term, connections };
}

type Outcome = { up: boolean; error: string | null };
type Logger = { warn(...args: unknown[]): void };

const reason = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "connection error");

export class HaWatcher {
  /** Bumped whenever the watch is replaced or stopped, so a run that was left behind knows to end. */
  private generation = 0;
  private readonly aborts = new Set<() => void>();
  private readonly waits = new Set<{ timer: ReturnType<typeof setTimeout>; done: () => void }>();

  constructor(
    private readonly open: SocketFactory,
    private readonly send: (frame: Record_) => void,
    private readonly logger?: Logger,
    private readonly timing: HaTiming = HA_TIMING,
  ) {}

  /** Watch what the platform asked for, in place of whatever was watched before. */
  watch(watch: HaWatch): void {
    this.stop();
    const generation = this.generation;
    for (const connection of watch.connections) void this.run(generation, watch.term, connection);
  }

  /** Stop watching, and drop every Home Assistant connection. */
  stop(): void {
    this.generation += 1;
    for (const abort of [...this.aborts]) abort();
    this.aborts.clear();
    for (const wait of [...this.waits]) {
      clearTimeout(wait.timer);
      wait.done();
    }
    this.waits.clear();
  }

  private current(generation: number) {
    return generation === this.generation;
  }

  private report(generation: number, frame: Record_) {
    if (!this.current(generation)) return;
    try {
      this.send(frame);
    } catch (error) {
      this.logger?.warn("PRiSM Home Assistant report failed", error);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = { timer: setTimeout(() => finish(), ms), done: () => finish() };
      const finish = () => {
        this.waits.delete(entry);
        resolve();
      };
      this.waits.add(entry);
    });
  }

  private async run(generation: number, term: number, connection: HaConnection): Promise<void> {
    let delay = this.timing.firstRetryMs;
    let first = 0;
    while (this.current(generation)) {
      const failures: string[] = [];
      for (const index of attemptOrder(connection.urls.length, first)) {
        if (!this.current(generation)) return;
        const url = connection.urls[index]!;
        const outcome = await this.watchOnce(generation, term, connection, url);
        if (!this.current(generation)) return;
        if (outcome.up) {
          // It was up and then ended; start over from it, and without a long wait.
          first = index;
          delay = this.timing.firstRetryMs;
          failures.length = 0;
          if (outcome.error) {
            this.logger?.warn(`Home Assistant ${url}: ${outcome.error}`);
            this.report(generation, statusFrame(term, connection.id, false, outcome.error));
          }
          break;
        }
        const error = outcome.error ?? "closed before signing in";
        this.logger?.warn(`Home Assistant ${url}: ${error}`);
        failures.push(`${url}: ${error}`);
      }
      if (failures.length) this.report(generation, statusFrame(term, connection.id, false, failures.join("; ")));
      await this.wait(delay);
      delay = Math.min(delay * 2, this.timing.maxRetryMs);
    }
  }

  /** One attempt at one address, ending when the connection does. `up` says it got as far as subscribing. */
  private watchOnce(generation: number, term: number, connection: HaConnection, base: string): Promise<Outcome> {
    return new Promise((resolve) => {
      const url = websocketUrl(base);
      if (!url) return resolve({ up: false, error: `unsupported address ${base}` });
      let socket: SocketLike;
      try {
        socket = this.open(url, {});
      } catch (error) {
        return resolve({ up: false, error: reason(error) });
      }
      const states = new Map<string, EntityState>();
      let up = false;
      let settled = false;
      let awaitingPong = false;
      let firstEvent = true;
      let nextId = SUBSCRIPTION_ID + 1;
      let authTimer: ReturnType<typeof setTimeout> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      const abort = () => finish(null);
      const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(authTimer);
        clearInterval(beat);
        this.aborts.delete(abort);
        try {
          socket.close(1000, "done");
        } catch {
          // Already closed.
        }
        resolve({ up, error });
      };
      this.aborts.add(abort);
      const connectTimer = setTimeout(() => finish("connecting timed out"), this.timing.connectMs);

      socket.addEventListener("open", () => {
        if (settled) return;
        clearTimeout(connectTimer);
        authTimer = setTimeout(() => finish("signing in timed out"), this.timing.authMs);
      });
      socket.addEventListener("error", (event) => finish(reason(event?.error ?? event?.message ?? event)));
      socket.addEventListener("close", () => finish(up ? null : "closed before signing in"));
      socket.addEventListener("message", (event) => {
        if (settled) return;
        let message: Record_;
        try {
          const parsed = JSON.parse(String(event?.data ?? ""));
          if (!isRecord(parsed)) return;
          message = parsed;
        } catch {
          return;
        }
        switch (message.type) {
          case "auth_required":
            socket.send(JSON.stringify({ type: "auth", access_token: connection.token }));
            break;
          case "auth_invalid":
            finish("Home Assistant rejected the token");
            break;
          case "auth_ok":
            clearTimeout(authTimer);
            socket.send(JSON.stringify({ id: SUBSCRIPTION_ID, type: "subscribe_entities", entity_ids: connection.entities }));
            up = true;
            this.report(generation, statusFrame(term, connection.id, true, null));
            beat = setInterval(() => {
              if (awaitingPong) return finish("Home Assistant stopped answering");
              awaitingPong = true;
              socket.send(JSON.stringify({ id: nextId++, type: "ping" }));
              this.report(generation, statusFrame(term, connection.id, true, null));
            }, this.timing.heartbeatMs);
            break;
          case "event":
            if (message.id !== SUBSCRIPTION_ID) break;
            {
              const changed = applyEvent(states, message.event);
              if (firstEvent) {
                // The first event is everything that exists now.
                this.report(generation, statesFrame(term, connection.id, true, states, [...states.keys()]));
                firstEvent = false;
              } else if (changed.length) {
                this.report(generation, statesFrame(term, connection.id, false, states, changed));
              }
            }
            break;
          case "result":
            if (message.id === SUBSCRIPTION_ID && message.success === false) {
              finish(isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "subscription refused");
            }
            break;
          case "pong":
            awaitingPong = false;
            break;
        }
      });
    });
  }
}
