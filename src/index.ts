import { apiOffsetLabel, formatDateTime, formatHM, formatMD, parseDateTime } from "./display-time.js";
import { HaWatcher, parseWatch, type HaWatch } from "./ha-watch.js";
import { h, Schema } from "koishi";
import packageMetadata from "../package.json";

export { HaWatcher } from "./ha-watch.js";
export type { HaWatch } from "./ha-watch.js";

export const name = "prism";
export const version = packageMetadata.version;

// Only how to reach the shop is configured here. Everything else (staff, door,
// tables, read-only mode, reminders, watching) is the bot's own settings on its
// resource page in PRiSM, read from the platform when the bot connects.
export const Config: Schema<PrismKoishiPluginConfig> = Schema.object({
  baseUrl: Schema.string().required().description("PRiSM 后端地址，例如 https://link.neri.moe"),
  shopCode: Schema.string().description("可选：店铺编号。接入凭据已经指明店铺，无需填写；旧配置仍认。"),
  integrationToken: Schema.string().role("secret").required().description("集成 API Token；其余设置在 PRiSM 商户工作台 → 资源 → 这个 Bot → Bot 设置"),
});

export function apply(ctx: any, config: PrismKoishiPluginConfig): void {
  applyPrismKoishiPlugin(ctx, config);
}

export class PrismBotClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "PrismBotClientError";
  }
}

/** What the bot is told about itself and the shop by `GET integration/bot`. */
export type BotConfig = {
  bot: { id: string; name: string };
  settings: {
    /** "readonly" leaves players binding, lookups and redeeming; staff keep every command. */
    playerCommands: "all" | "readonly";
    readOnlyNotice: string;
    /** Staff may act for other players. */
    staffCommands: boolean;
    /** Only staff may switch machines off. */
    powerOffStaffOnly: boolean;
    /** Staff on the same platform get checkout receipts privately. */
    receiptsToStaff: boolean;
    /** Channels (`platform:channelId`) told before an idle power-off. */
    idleChannelIds: string[];
    /** How many minutes before an idle power-off to tell them; 0 for never. */
    idleReminderMinutes: number;
    /** Channels (`platform:channelId`) told what happens at the shop, and which of it. */
    eventChannelIds: string[];
    announcePower: boolean;
    announceCards: boolean;
    announceStarts: boolean;
  };
  /** Which shop this credential belongs to; the shop code is no longer configured by hand. */
  shop?: { code: string; name: string };
  /** Whether entering through this bot bills: its own plan, otherwise its resource group's. */
  billingEnabled: boolean;
  currencyName: string;
  /** Staff are these platform identities. */
  staff: Array<{ provider: string; subject: string }>;
  /** The door `lock`/开门 opens. */
  door: { id: string; name: string } | null;
  mahjongTables: Array<{ id: string; name: string; aliases: string[]; capacity: number }>;
};

export type PrismKoishiPluginConfig = {
  /**
   * Used by /list to resolve player display names from the chat platform.
   * For Koishi, this maps an adapter subject and provider to a nickname (e.g. the
   * member list of the current group). If not provided, the plugin will fall
   * back to `playerDisplayName` from the backend.
   */
  resolveDisplayName?: (subject: string, provider: string) => Promise<string | null | undefined> | string | null | undefined;
  /** Get a stable current ISO timestamp; mainly for tests. */
  now?: () => Date;

  // Connection parameters
  shopCode?: string;
  baseUrl?: string;
  integrationToken?: string;

  // Optional client injection (mainly for unit tests / mock)
  client?: any;
  /** Opens the platform connection; defaults to Koishi's `ctx.http.ws`. Mainly for tests. */
  socket?: SocketFactory;
  /** Plain HTTP POST, used only by `api测速`; defaults to Koishi's `ctx.http`. Mainly for tests. */
  httpPost?: HttpPost;
  /** Opens connections to Home Assistant; defaults to Koishi's `ctx.http.ws`. Mainly for tests. */
  haSocket?: SocketFactory;
};

/** A plain HTTP POST answering with its status, headers and decoded body. */
export type HttpPost = (url: string, headers: Record<string, string>, body: unknown) => Promise<{ status: number; headers: Headers; data: any }>;

/** One timed call: the whole round trip, the server's own share when it says, and the Cloudflare edge it went through. */
export type Timing = { ms: number; serverMs: number | null; colo?: string | null };

/** The parts of a WebSocket the plugin uses; both `ws` and browser sockets fit. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export type KoishiCommandRegistration = {
  description: string;
  action: (context: KoishiActionContext, ...args: string[]) => Promise<string> | string;
};

export type KoishiCommandBuilder = {
  action(handler: KoishiCommandRegistration["action"]): KoishiCommandBuilder;
};

export type KoishiLikeContext = {
  command(name: string, description: string): KoishiCommandBuilder;
  logger?(name: string): {
    warn(...args: unknown[]): void;
  };
  /** Send to channels as `platform:channelId`. */
  broadcast?(channels: string[], content: string): Promise<unknown>;
  on?(event: "dispose", listener: () => void): void;
};

export type KoishiActionContext = {
  session: {
    platform?: string;
    isDirect?: boolean;
    userId: string;
    messageId?: string;
    senderId?: string;
    senderName?: string;
    username?: string;
    bot?: {
      platform?: string;
      getUser?(id: string): Promise<{ name?: string }>;
      broadcast?(userIds: string[], content: string): Promise<void>;
    };
  };
};

const USAGE: Record<string, string> = {
  mahjong_join: "/上桌 <桌号>",
  mahjong_leave: "/下桌 [桌号]",
  mahjong_list: "/麻将列表",
  api_benchmark: "/api测速 [次数]",
  ws_benchmark: "/ws测速 [次数]",
  prism_on: "/prism on <设备名|别名|all>",
  prism_off: "/prism off <设备名|别名|all>",
  prism_keep: "/keep <设备名或别名>",
  prism_coin: "/prism coin <设备名或别名> [数量]",
  prism_scan: "/prism scan <设备名或别名>",
  prism_redeem: "/prism redeem <兑换码>",
  list: "/list [资源或方案]",
  show: "/show [设备ID]",
};

type MahjongTable = BotConfig["mahjongTables"][number];

/** A table as `GET integration/mahjong-tables` and the mahjong command report it. */
type MahjongTableState = {
  id?: string;
  name?: string;
  aliases?: string[];
  capacity: number;
  seats: Array<{ playerId: string; name: string; mine?: boolean; playing: boolean }>;
};

type IdentityInput = {
  provider: string;
  subject: string;
  displayName: string;
};

type UncheckedRecord = Record<string, any>;

type ActiveSessionListItem = {
  id?: string;
  playerId?: string;
  playerDisplayName?: string;
  startedAt?: string;
  label?: string | null;
  /** The plan the session bills; null for an older platform. */
  pricingConfigId?: string | null;
  planName?: string | null;
  identities?: Array<{ provider: string; subject: string }>;
};

/** A resource group and the plan it bills, as `integration/sessions/active` reports it. */
type ResourceGroupItem = { id: string; name: string; isDefault?: boolean; pricingConfigId?: string | null };

type ActivePlayer = {
  playerId: string;
  sessions: ActiveSessionListItem[];
  displayName?: string;
};

type PlayerGroup = { label: string; capacity?: number; players: ActivePlayer[] };

/** Where `list` puts players who occupy no resource. */
const OTHER_PLAYERS_LABEL = "其他";

/** `GET integration/roster`: each person once, in one group. */
type RosterView = {
  total?: number;
  groups?: Array<{
    kind: "resource" | "plan";
    id: string | null;
    name: string;
    capacity?: number;
    members?: Array<{ playerId: string; displayName: string | null; identities?: Array<{ provider: string; subject: string }> }>;
  }>;
};

type DeviceStateItem = {
  deviceId?: string;
  label?: string;
  aliases?: string[];
  state?: string | { state?: string } | null;
  targetKind?: string;
};

export function applyPrismKoishiPlugin(ctx: KoishiLikeContext, config: PrismKoishiPluginConfig): void {
  const service = new PrismKoishiService(ctx, config);

  type Handler = (context: KoishiActionContext, ...args: string[]) => Promise<string> | string;
  /**
   * `effect`: starts billing, settles a bill or drives a device, so read-only mode
   * leaves it to staff. `entry`: starts this bot's plan, which there is none of
   * when the bot's resource group is free; everything else a player owes or
   * holds spans the shop, so the platform answers it.
   * `offline`: answers without the bot's settings, as `versions` must.
   */
  type Gate = { effect?: boolean; entry?: boolean; offline?: boolean };

  const wrap = (handler: Handler, gate: Gate = {}) => async (context: KoishiActionContext, ...args: string[]): Promise<string> => {
    const quoted = (message: string) =>
      context.session?.messageId ? `${h("quote", { id: context.session.messageId })}${message}` : message;
    try {
      if (!gate.offline) {
        // A disabled bot, or one that cannot read its settings, answers nothing else.
        const bot = await service.config();
        if (gate.effect && bot.settings.playerCommands === "readonly" && !service.isStaff(bot, await service.sender(context))) {
          return quoted(bot.settings.readOnlyNotice || DEFAULT_READ_ONLY_NOTICE);
        }
        if (gate.entry && !bot.billingEnabled) return quoted(RESOURCE_NOT_BILLED_NOTICE);
      }
      return quoted(await handler(context, ...args));
    } catch (error) {
      return quoted(service.handleCommandError(error));
    }
  };

  const effect = (handler: Handler, gate: Gate = {}) => wrap(handler, { ...gate, effect: true });
  const entry = { entry: true };

  const bind = wrap(async (context, code) => service.bind(await service.sender(context), code));
  ctx.command("bind <code:string>", "绑定网页登录账号到当前平台身份").action(bind);
  // Instructions already handed to players may still say prism.bind.
  ctx.command("prism.bind <code:string>", "绑定网页登录账号到当前平台身份（旧命令，同 bind）").action(bind);

  ctx.command("login [target:user]", "开启玩家计费场次").action(effect(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  entry));

  ctx.command("入场 [target:user]", "入场").action(effect(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  entry));

  ctx.command("mahjong <tableId>", "加入指定麻将桌").action(effect(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("上桌 [tableId]", "加入指定麻将桌").action(effect(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("下桌 [tableId]", "离开当前所在麻将桌").action(effect(async (context, tableId) =>
    service.mahjongLeave(await service.sender(context), tableId),
  ));

  ctx.command("麻将列表", "查看麻将机状态与别名").action(wrap(async () =>
    service.listMahjongTables(),
  ));

  ctx.command("logout [target:user]", "结算玩家计费场次").action(effect(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.logout(sender, context.session?.bot), context.session?.bot),
  ));

  ctx.command("billing [target:user]", "预览玩家结账费用").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.billing(sender), context.session?.bot),
  ));

  ctx.command("wallet [target:user]", "查看玩家钱包").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.wallet(sender), context.session?.bot),
  ));

  ctx.command("api测速 [count:number]", "测试 Bot 走 HTTP 到 PRiSM 的延迟").action(wrap(async (context, count) =>
    service.benchmarkApi(await service.sender(context), count),
  ));

  ctx.command("ws测速 [count:number]", "测试 Bot 走 WebSocket 到 PRiSM 的延迟").action(wrap(async (context, count) =>
    service.benchmarkWs(await service.sender(context), count),
  ));

  // The Bot's own version stays visible while the platform is out of reach.
  ctx.command("versions", "查看 Bot 与 PRiSM 后端版本").action(wrap(async () =>
    service.versions(),
  { offline: true }));

  ctx.command("items [target:user]", "查看玩家资产").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.items(sender), context.session?.bot),
  ));

  ctx.command("list [name:text]", "查看在店玩家，或某个资源、某个计费方案上的玩家").action(wrap(async (context, name) =>
    service.listActiveSessions(await service.sender(context), name),
  ));

  ctx.command("show [deviceId]", "查看设备电源状态").action(wrap(async (context, deviceId) =>
    service.listDeviceStates(deviceId),
  ));

  ctx.command("history [target:user]", "查看玩家历史").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.history(sender), context.session?.bot),
  ));

  ctx.command("lock", "向本店门锁发送开门指令").action(effect(async (context) =>
    service.lock(await service.sender(context)),
  ));

  ctx.command("on <deviceRef>", "请求启动指定设备电源").action(effect(async (context, deviceRef) =>
    service.powerOn(await service.sender(context), deviceRef),
  ));

  ctx.command("off <deviceRef>", "请求关闭指定设备电源").action(effect(async (context, deviceRef) =>
    service.powerOff(await service.sender(context), deviceRef),
  ));

  // Not limited by read-only mode: it never switches anything on, and the
  // platform only accepts it from an entered player for a device that is on.
  ctx.command("keep <deviceRef>", "延迟闲置设备的自动关机").action(wrap(async (context, deviceRef) =>
    service.keep(await service.sender(context), deviceRef),
  ));

  ctx.command("coin <deviceRef> [count]", "请求向指定设备投币").action(
    effect(async (context, deviceRef, count) => service.coin(await service.sender(context), deviceRef, count)),
  );

  ctx.command("scan <deviceRef>", "使用当前玩家绑定的 Aime 卡刷卡").action(
    effect(async (context, deviceRef) => service.scan(await service.sender(context), deviceRef)),
  );

  ctx.command("redeem <code>", "兑换 PRiSM 礼物码").action(wrap(async (context, code) =>
    service.redeem(await service.sender(context), code),
  ));

  ctx.command("add <target:user> <amount:number>", "增加玩家余额").action(wrap(async (context, target, amount) =>
    service.adjustTargetBalance(await service.sender(context), target, amount, 1, context.session?.bot),
  ));

  ctx.command("del <target:user> <amount:number>", "扣除玩家余额").action(wrap(async (context, target, amount) =>
    service.adjustTargetBalance(await service.sender(context), target, amount, -1, context.session?.bot),
  ));

  ctx.command("overwrite <target:user> <amount:number> [reason:text]", "覆盖结账金额并立即结账").action(
    wrap(async (context, target, amount, reason) =>
      service.overwriteTargetCheckout(await service.sender(context), target, amount, reason, context.session?.bot),
    ),
  );

  ctx.on?.("dispose", () => service.dispose());
}

const DEFAULT_READ_ONLY_NOTICE = "请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。";
/** Platforms before per-resource billing refused billing commands shop-wide. */
const BILLING_DISABLED_NOTICE = "本店未启用计费";
/** The bot's resource has no plan, so there is nothing to enter. */
const RESOURCE_NOT_BILLED_NOTICE = "这里不计费，无需入场";

/* --------------------------- platform connection --------------------------- */

const SOCKET_OPEN = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const PING_MS = 30_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

type PlatformEvent = { event: string; data: unknown };

/**
 * The one connection to PRiSM. Requests go out as frames and are matched to
 * their replies by id; the platform also pushes events down it. While it is
 * down a request fails at once: queueing a checkout or a top-up to run later
 * would make players repeat it, and a resend could run it twice.
 */
export class PrismSocket {
  private socket: SocketLike | null = null;
  private readonly pending = new Map<string, { resolve(value: SocketReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private stopped = false;
  private sequence = 0;
  /** Bumped by every hello being prepared, so only the newest one is sent. */
  private greeting = 0;
  private readonly pongWaiters: Array<() => void> = [];

  constructor(
    private readonly open: SocketFactory,
    /** Resolved at each connection: the shop is learned from the credential first. */
    private readonly url: string | (() => string),
    private readonly token: string,
    /**
     * What to say in hello, read afresh each time: the bot's settings live on
     * the platform, so they are fetched over this connection before it is
     * sent. Null when they could not be read.
     */
    private readonly hello: () => Promise<Record<string, unknown> | null>,
    private readonly onEvent: (event: PlatformEvent) => void,
    private readonly logger?: { warn(...args: unknown[]): void },
    /**
     * `onWatch`: the platform asked this bot to watch Home Assistant, or with null to stop.
     * `onClose`: the connection is gone, and with it the platform's idea of what this bot watches.
     */
    private readonly hooks?: { onWatch(watch: HaWatch | null): void; onClose(): void },
  ) {}

  /** Send a frame if the connection is up; a report made while it is down is dropped, as the platform has forgotten the watch by then. */
  send(frame: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The connection went between the check and the send.
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Connect again with what the platform has just told us, such as the shop. */
  reconnect(): void {
    this.socket?.close(1000, "shop known");
    this.socket = null;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close(1000, "dispose");
    this.socket = null;
    this.failPending();
  }

  private connect(): void {
    let socket: SocketLike;
    try {
      socket = this.open(typeof this.url === "function" ? this.url() : this.url, { Authorization: `Bearer ${this.token}` });
    } catch (error) {
      this.logger?.warn("PRiSM connection failed", error);
      this.reconnectLater();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.lastHeard = Date.now();
      void this.greet(socket, true);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        // Two missed pings: the connection is gone even if no close arrived.
        if (Date.now() - this.lastHeard > PING_MS * 2) socket.close(4000, "silent");
        else if (socket.readyState === SOCKET_OPEN) socket.send("ping");
      }, PING_MS);
    });
    socket.addEventListener("message", (event) => this.receive(String(event?.data ?? "")));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.failPending();
      // The platform forgets what this bot watches with the connection; it is asked again after hello.
      this.hooks?.onClose();
      this.reconnectLater();
    });
    socket.addEventListener("error", (error) => this.logger?.warn("PRiSM connection error", error?.message ?? error));
  }

  /**
   * Read the bot's settings and say hello with them: on connecting, and again
   * when the platform says they changed. A connection that cannot read them
   * at all is closed and tried again later, without resetting the backoff, so
   * a platform that keeps failing is not asked every second.
   */
  private async greet(socket: SocketLike, connecting: boolean): Promise<void> {
    const greeting = ++this.greeting;
    let hello: Record<string, unknown> | null = null;
    try {
      hello = await this.hello();
    } catch (error) {
      this.logger?.warn("PRiSM bot settings unavailable", error);
    }
    // A newer hello is on its way, or this connection is already gone.
    if (greeting !== this.greeting || this.socket !== socket) return;
    if (!hello) {
      if (connecting) socket.close(4000, "settings unavailable");
      return;
    }
    if (connecting) this.retryMs = FIRST_RETRY_MS;
    this.send({ type: "hello", ...hello });
  }

  private reconnectLater(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private failPending(): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(unreachable());
    }
    this.pending.clear();
  }

  private receive(raw: string): void {
    this.lastHeard = Date.now();
    if (raw === "pong") {
      this.pongWaiters.shift()?.();
      return;
    }
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame?.type === "response" && typeof frame.id === "string") {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: Number(frame.status) || 500, body: frame.body, serverMs: typeof frame.serverMs === "number" ? frame.serverMs : null });
    } else if (frame?.type === "event" && typeof frame.event === "string") {
      try {
        this.onEvent({ event: frame.event, data: frame.data });
      } catch (error) {
        this.logger?.warn("PRiSM event handling failed", error);
      }
    } else if (frame?.type === "config.changed") {
      // The bot's settings, staff, door or tables changed: read them again and say hello with them.
      if (this.socket) void this.greet(this.socket, false);
    } else if (frame?.type === "ha.watch" || frame?.type === "ha.unwatch") {
      // A watch that cannot be read is as good as none: the platform has nothing for this bot to watch.
      const watch = frame.type === "ha.watch" ? parseWatch(frame.watch) : null;
      try {
        this.hooks?.onWatch(watch);
      } catch (error) {
        this.logger?.warn("PRiSM Home Assistant watch failed", error);
      }
    }
  }

  /** One heartbeat round trip in milliseconds: the network to the platform and nothing else. */
  ping(): Promise<number> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return Promise.reject(unreachable());
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const timer = setTimeout(() => {
        const index = this.pongWaiters.indexOf(answered);
        if (index >= 0) this.pongWaiters.splice(index, 1);
        reject(new PrismBotClientError("服务器没有及时回应", "API_TIMEOUT", 0, {}));
      }, REQUEST_TIMEOUT_MS);
      const answered = () => {
        clearTimeout(timer);
        resolve(performance.now() - startedAt);
      };
      this.pongWaiters.push(answered);
      socket.send("ping");
    });
  }

  request(frame: { method: "GET" | "POST" | "PUT"; path: string; query?: Record<string, unknown>; body?: unknown }): Promise<SocketReply> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return Promise.reject(unreachable());
    const id = `${Date.now().toString(36)}-${(this.sequence++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrismBotClientError("服务器没有及时回应，请稍后确认结果", "API_TIMEOUT", 0, {}));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "request", id, ...frame }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(unreachable());
      }
    });
  }
}

type SocketReply = { status: number; body: any; serverMs?: number | null };

function unreachable() {
  return new PrismBotClientError("暂时连不上服务器", "API_UNREACHABLE", 0, {});
}

function replyError(status: number, body: any) {
  const err = body && typeof body === "object" && typeof body.error === "object" ? body.error : {};
  return new PrismBotClientError(
    typeof err.message === "string" ? err.message : `Backend request failed with HTTP ${status}.`,
    typeof err.code === "string" ? err.code : `HTTP_${status}`,
    status,
    body ?? {},
  );
}

function benchmarkCount(raw?: string): number | null {
  const count = raw == null || raw === "" ? 5 : Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : null;
}

function spread(samples: number[]): string {
  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  return `最小 ${Math.round(Math.min(...samples))} / 平均 ${Math.round(average)} / 最大 ${Math.round(Math.max(...samples))} ms`;
}

function serverLine(timings: Timing[]): string[] {
  const known = timings.map((timing) => timing.serverMs).filter((value): value is number => value !== null);
  if (!known.length) return [];
  return [`服务端处理：平均 ${Math.round(known.reduce((sum, value) => sum + value, 0) / known.length)} ms`];
}

/**
 * The platform connection URL. The credential names the shop, as a device's
 * token names its machine at `/io/ws`, so nothing identifying is in the path.
 */
export function platformSocketUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/integration/ws`;
}

/* ----------------------------- api client ---------------------------------- */

class PrismApiClient {
  constructor(
    private readonly socket: PrismSocket,
    private readonly http?: { post: HttpPost; baseUrl: string; token: string; shopCode?: string },
  ) {}

  private async request<T = any>(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: {
      token?: string;
      body?: any;
      params?: Record<string, string | number>;
      query?: Record<string, string | number | boolean | null | undefined>;
    },
  ): Promise<T> {
    let target = path.replace(/^\/rpc\//, "");
    for (const [key, value] of Object.entries(options.params ?? {})) {
      target = target.replace(`:${key}`, encodeURIComponent(String(value)));
    }
    const { status, body } = await this.socket.request({
      method,
      path: target,
      ...(options.query ? { query: options.query } : {}),
      ...(method === "GET" ? {} : { body: options.body ?? {} }),
    });
    if (status >= 400) throw replyError(status, body);
    return body && typeof body === "object" && Object.hasOwn(body, "data") ? body.data : body;
  }

  confirmPlatformBinding(code: string, provider: string, subject: string) {
    return this.request("POST", "/rpc/integration/platform-binding/confirm", { body: { code, provider, subject } });
  }

  private identityBody(identity: any): Record<string, unknown> {
    return {
      identity: {
        provider: identity.provider,
        subject: identity.subject,
      },
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    };
  }

  /** The shop this credential belongs to, read before the shop code is known. */
  setShopCode(code: string): void { if (this.http) this.http.shopCode = code; }

  /** The bot's own settings and what it needs to know about the shop. */
  async getBotConfig() {
    return this.request("GET", "/rpc/integration/bot", {});
  }

  /** Always the register route: whether a new player is created is the shop's own switch. */
  async resolveOrRegisterIdentity(identity: any) {
    const result = await this.request("POST", "/rpc/integration/players/by-identity/register", {
      body: this.identityBody(identity),
    });
    return result.player;
  }

  async getVersion() {
    return this.request("GET", "version", {});
  }

  /** Admit a player into the shop's default plan; `created` is false when it was already billing. */
  async startSessionByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/session/start", {
      body: { ...this.identityBody(identity), entry: true },
    });
  }

  /** Seat or unseat a player; `table` is a table id, name or alias. */
  async mahjongByIdentity(identity: any, table: string, action: "join" | "leave") {
    return this.request("POST", "/rpc/integration/players/by-identity/mahjong", {
      body: { ...this.identityBody(identity), table, action },
    });
  }

  async listMahjongTables() {
    return this.request("GET", "/rpc/integration/mahjong-tables", {});
  }

  /** Who is in the shop, each once at their place; with a name, one resource or one plan. */
  async roster(name?: string) {
    return this.request("GET", "/rpc/integration/roster", name ? { query: { name } } : {});
  }

  async getWalletByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/wallet", {
      body: this.identityBody(identity),
    });
  }

  /** The wallet query over the platform connection, timed. */
  async timeWalletOverSocket(identity: any): Promise<Timing> {
    const startedAt = performance.now();
    const reply = await this.socket.request({ method: "POST", path: "integration/players/by-identity/wallet", body: this.identityBody(identity) });
    const ms = performance.now() - startedAt;
    if (reply.status >= 400) throw replyError(reply.status, reply.body);
    return { ms, serverMs: reply.serverMs ?? null };
  }

  /** The same wallet query as a plain HTTP request, the way the Bot used to call, timed. */
  async timeWalletOverHttp(identity: any): Promise<Timing> {
    if (!this.http) throw new PrismBotClientError("HTTP 测速不可用", "HTTP_UNAVAILABLE", 0, {});
    const { post, baseUrl, shopCode, token } = this.http;
    if (!shopCode) throw new PrismBotClientError("店铺尚未读取", "SHOP_UNKNOWN", 0, {});
    const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/v1/shops/${encodeURIComponent(shopCode)}/integration/players/by-identity/wallet`;
    const startedAt = performance.now();
    const response = await post(url, { authorization: `Bearer ${token}`, "content-type": "application/json" }, this.identityBody(identity));
    const ms = performance.now() - startedAt;
    if (response.status >= 400) throw replyError(response.status, response.data);
    const server = Number.parseFloat(response.headers.get("x-response-time") ?? "");
    return { ms, serverMs: Number.isFinite(server) ? server : null, colo: response.headers.get("cf-ray")?.split("-").pop() ?? null };
  }

  pingSocket(): Promise<number> {
    return this.socket.ping();
  }

  async getAssetsByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/assets", {
      body: this.identityBody(identity),
    });
  }

  async getSessionHistoryByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/history", {
      body: this.identityBody(identity),
    });
  }

  async previewCheckoutByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/preview", {
      body: this.identityBody(identity),
    });
  }

  async confirmCheckoutByIdentity(identity: any, closeSessionsBeforeBalanceCheck = true) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/confirm", {
      body: { ...this.identityBody(identity), closeSessionsBeforeBalanceCheck },
    });
  }

  async redeemCodeByIdentity(identity: any, code: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/redeem", {
      body: {
        ...this.identityBody(identity),
        code,
      },
    });
  }

  async requestDeviceCommandByIdentity(identity: any, command: any, options?: { staffOverride?: boolean }) {
    return this.request("POST", "/rpc/integration/players/by-identity/device-actions", {
      body: {
        ...this.identityBody(identity),
        ...(options?.staffOverride ? { staffOverride: true } : {}),
        target: command.target,
        action: {
          type: command.type,
          ...(command.payload === undefined ? {} : { payload: command.payload }),
        },
      },
    });
  }

  async requestScanByIdentity(identity: any, scan: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/device-actions", {
      body: {
        ...this.identityBody(identity),
        target: {
          kind: "game_machine",
          ref: scan.deviceRef,
        },
        action: {
          type: "aime.scan",
          payload: {
            provider: scan.provider,
          },
        },
      },
    });
  }

  async listActiveSessions() {
    return this.request("GET", "/rpc/integration/sessions/active", {
    });
  }

  async listDeviceStates() {
    return this.request("GET", "/rpc/integration/device-states", {
    });
  }

  async adjustWalletByIdentity(identity: any, amount: number, reason: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/wallet/adjustment", {
      body: { ...this.identityBody(identity), amount, reason },
    });
  }

  async checkoutWithOverrideByIdentity(identity: any, total: number, reason: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/override", {
      body: { ...this.identityBody(identity), total, reason },
    });
  }
}

/* ------------------------------- service ----------------------------------- */

type IdleReminder = { reason: "shop_empty" | "device_idle"; at: number; devices: Array<{ id: string; name: string }> };

type EventPlayer = { playerId: string; displayName: string | null; identities: Array<{ provider: string; subject: string }> };
/** What the platform tells bots happened at the shop; see PRiSM's resources/shop-events.ts. */
type ShopEvent = { resourceId: string; resourceName: string; botId?: string } & (
  | { kind: "power"; state: "on" | "off"; by: "player" | "staff" | "system"; player: EventPlayer | null }
  | { kind: "card"; player: EventPlayer | null; started: boolean }
  | { kind: "occupancy"; player: EventPlayer }
);

class PrismKoishiService {
  private readonly logoutInFlight = new Map<string, Promise<string>>();
  private readonly client: any;
  private readonly logger?: { warn(...args: unknown[]): void };

  private readonly socket: PrismSocket | null = null;
  private readonly watcher: HaWatcher | null = null;
  /** The bot's settings as last read; null until read, and again once the shop disables the bot. */
  private bot: BotConfig | null = null;
  /** Announcements still being sent; each waits for the one before. */
  private announcing: Promise<void> = Promise.resolve();
  /** The read in flight, shared by commands arriving together. */
  private reading: Promise<BotConfig> | null = null;
  private reads = 0;
  /** Whether the settings let this bot watch Home Assistant. */
  private watching = false;

  constructor(private readonly ctx: KoishiLikeContext, private readonly options: PrismKoishiPluginConfig) {
    this.logger = ctx.logger?.("prism");
    if (options.client) {
      this.client = options.client;
      return;
    }
    if (!options.baseUrl || !options.integrationToken) {
      throw new Error("PRiSM Koishi plugin requires 'baseUrl' and 'integrationToken'.");
    }
    const open: SocketFactory = options.socket ?? ((url, headers) => {
      const http = (ctx as any).http;
      if (!http?.ws) throw new Error("Koishi http service with WebSocket support is required.");
      return http.ws(url, { headers });
    });
    // Home Assistant is reached the way the platform is, unless a test stands in for the platform and
    // says nothing about Home Assistant: then there is no watching to offer.
    const haOpen: SocketFactory | null = options.haSocket ?? (options.socket ? null : open);
    if (haOpen) this.watcher = new HaWatcher(haOpen, (frame) => this.socket?.send(frame), this.logger);
    this.socket = new PrismSocket(
      open,
      platformSocketUrl(options.baseUrl),
      options.integrationToken,
      () => this.hello(),
      (event) => {
        if (event.event === "idle.reminder") void this.remindIdle(event.data as IdleReminder);
        // One at a time, so the channels read them in the order they happened.
        else if (event.event === "shop.event") this.announcing = this.announcing
          .then(() => this.announce(event.data as ShopEvent))
          .catch((error) => this.logger?.warn("PRiSM event announcement failed", error));
      },
      this.logger,
      this.watcher
        ? {
          // Only a bot whose settings allow it watches, whatever the platform asks.
          onWatch: (watch) => (watch && this.watching ? this.watcher!.watch(watch) : this.watcher!.stop()),
          onClose: () => this.watcher!.stop(),
        }
        : undefined,
    );
    const post: HttpPost = options.httpPost ?? (async (url, headers, body) => {
      const http = (ctx as any).http;
      if (typeof http !== "function") throw new PrismBotClientError("HTTP 测速需要 Koishi 的 http 服务", "HTTP_UNAVAILABLE", 0, {});
      const response = await http(url, {
        method: "POST", headers, data: body, keepAlive: true, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
      });
      return { status: response.status, headers: response.headers, data: response.data };
    });
    this.client = new PrismApiClient(this.socket, { post, baseUrl: options.baseUrl!, token: options.integrationToken, ...(options.shopCode ? { shopCode: options.shopCode } : {}) });
    this.socket.start();
  }

  dispose(): void {
    this.watcher?.stop();
    this.socket?.stop();
  }

  /** The bot's settings, read from the platform the first time they are needed. */
  async config(): Promise<BotConfig> {
    return this.bot ?? this.reading ?? this.readConfig();
  }

  /** Read the settings afresh. A disabled bot forgets the ones it had, so each command asks again. */
  private readConfig(): Promise<BotConfig> {
    // Only the newest read may settle what the bot knows; an older one answering late is stale.
    const read = ++this.reads;
    this.reading = (async () => {
      try {
        const bot = parseBotConfig(await this.client.getBotConfig());
        if (read === this.reads) {
          this.bot = bot;
          if (bot.shop?.code) this.client.setShopCode(bot.shop.code);
        }
        return bot;
      } catch (error) {
        if (read === this.reads && error instanceof PrismBotClientError && error.code === "BOT_DISABLED") this.bot = null;
        throw error;
      } finally {
        if (read === this.reads) this.reading = null;
      }
    })();
    return this.reading;
  }

  /**
   * What this bot says in hello, from settings read just now. A disabled bot
   * offers nothing: no watching and no reminders.
   */
  private async hello(): Promise<Record<string, unknown> | null> {
    let bot: BotConfig;
    try {
      bot = await this.readConfig();
    } catch (error) {
      if (!(error instanceof PrismBotClientError && error.code === "BOT_DISABLED")) throw error;
      this.watching = false;
      this.watcher?.stop();
      return {};
    }
    const { settings } = bot;
    // Watching is the platform's to schedule: every bot that can offers, and the
    // hub picks among them. A bot with no Home Assistant connection cannot.
    this.watching = this.watcher !== null;
    if (!this.watching) this.watcher?.stop();
    return {
      name: bot.bot.name,
      // Saying so is what makes the platform consider this bot for the watch.
      ...(this.watching ? { ha: true } : {}),
      // Without anywhere to send it, the platform need not plan a reminder.
      ...(settings.idleChannelIds.length && settings.idleReminderMinutes > 0 ? { reminderLeadSeconds: settings.idleReminderMinutes * 60 } : {}),
    };
  }

  /** Whether the sender is one of the shop's staff on this platform. */
  isStaff(bot: BotConfig, sender: Sender): boolean {
    return bot.staff.some((identity) => identity.provider === sender.provider && identity.subject === sender.id);
  }

  async bind(sender: Sender, code: string): Promise<string> {
    try {
      await this.client.confirmPlatformBinding(code, sender.provider, sender.id);
      return "绑定成功，请返回网页继续操作";
    } catch (error) {
      if (error instanceof PrismBotClientError && error.status > 0) return error.message || "绑定失败，请重新生成验证码";
      throw error;
    }
  }

  /**
   * Tell the configured channels what happened, if this bot announces that kind
   * of thing. A card that put its owner on the cabinet is one message: a start
   * when starts are announced, otherwise a card. What this bot's own command
   * did is left out: the bot has answered the command already.
   */
  async announce(event: ShopEvent): Promise<void> {
    const bot = this.bot;
    const channels = bot?.settings.eventChannelIds ?? [];
    if (!bot || !channels.length || typeof this.ctx.broadcast !== "function") return;
    if (event.botId && event.botId === bot.bot.id) return;
    const message = await this.announcement(event, bot.settings);
    if (!message) return;
    try {
      await this.ctx.broadcast(channels, message);
    } catch (error) {
      this.logger?.warn("PRiSM event announcement failed", error);
    }
  }

  private async announcement(event: ShopEvent, settings: BotConfig["settings"]): Promise<string | null> {
    const place = event.resourceName || event.resourceId;
    const who = async () => {
      if (!event.player) return "未绑定的卡";
      // Named as the platform the channels are on would name them, when it can.
      const provider = event.player.identities[0]?.provider ?? "";
      return this.displayNameForPlayer({
        playerId: event.player.playerId,
        displayName: event.player.displayName ?? undefined,
        sessions: [{ playerDisplayName: event.player.displayName ?? undefined, identities: event.player.identities }],
      }, provider);
    };
    if (event.kind === "power") {
      if (!settings.announcePower) return null;
      if (event.by === "system") return event.state === "off" ? `💤 ${place} 闲置，已自动关机` : `✅ ${place} 已开机`;
      const by = event.player ? `（${await who()}）` : "";
      return event.state === "on" ? `✅ ${place} 已开机${by}` : `🛑 ${place} 已关机${by}`;
    }
    if (event.kind === "card") {
      if (event.started && settings.announceStarts) return `🎮 ${await who()} 在 ${place} 刷卡上机`;
      return settings.announceCards ? `💳 ${await who()} 在 ${place} 刷卡` : null;
    }
    if (event.kind === "occupancy") return settings.announceStarts ? `🎮 ${await who()} 在 ${place} 上机` : null;
    return null;
  }

  /** Tell the configured channels a power-off is coming. Short: they can read a device name. */
  async remindIdle(reminder: IdleReminder): Promise<void> {
    const channels = this.bot?.settings.idleChannelIds ?? [];
    if (!channels.length || typeof this.ctx.broadcast !== "function") return;
    const now = (this.options.now?.() ?? new Date()).getTime();
    const minutes = Math.max(1, Math.round((reminder.at - now) / 60_000));
    const names = reminder.devices.map((device) => device.name).join("、");
    const message = reminder.reason === "shop_empty"
      ? `店里没人，${minutes} 分钟后全部关机`
      : `${names} 闲置中，${minutes} 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟`;
    try {
      await this.ctx.broadcast(channels, message);
    } catch (error) {
      this.logger?.warn("PRiSM idle reminder failed", error);
    }
  }

  async sender(context: KoishiActionContext): Promise<Sender> {
    const id = cleanText(context.session?.userId);
    const provider = cleanText(context.session?.platform || context.session?.bot?.platform).toLowerCase();
    if (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new PrismBotClientError("无法获取发送人的平台身份","INVALID_PLATFORM_IDENTITY",400,null);
    let name = context.session?.username || context.session?.senderName || id;
    try {
      if (context.session?.bot?.getUser) {
        const user = await context.session.bot.getUser(id);
        if (user?.name) {
          name = user.name;
        }
      }
    } catch { }
    return { id, name, provider };
  }

  async loginForTarget(actor: Sender, targetSubject?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender, isTargeted) => {
      const result = (await this.client.startSessionByIdentity(this.identity(sender))) as UncheckedRecord;
      // Already in: the player had this session before, and the plan says where.
      if (result?.created === false) {
        const where = typeof result.planName === "string" && result.planName ? `「${result.planName}」` : "场";
        return isTargeted ? `用户 ${formatPlayerReference(sender)} 已在${where}中，无需重复入场` : `您已在${where}中，无需重复入场`;
      }
      // Starting the plan may end one it cannot bill together with.
      const stopped = Array.isArray(result?.billing?.stopped) ? result.billing.stopped.filter((name: unknown) => typeof name === "string" && name) : [];
      const ended = stopped.length ? `\n结束方案：${stopped.join("、")}` : "";
      return (isTargeted ? `✅ 已为用户 ${formatPlayerReference(sender)} 入场成功` : "✅ 入场成功") + ended;
    }, bot);
  }

  async withTarget(
    actor: Sender,
    targetSubject: string | undefined,
    action: (sender: Sender, isTargeted: boolean) => Promise<string>,
    bot?: KoishiActionContext["session"]["bot"],
  ): Promise<string> {
    const target = await this.targetSender(actor, targetSubject, bot);
    if (typeof target === "string") return target;
    return action(target, target !== actor);
  }

  async adjustTargetBalance(actor: Sender, targetSubject: string, rawAmount: string, direction: 1 | -1, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender) => {
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) return "金额必须大于 0";
      const isAddition = direction === 1;
      await this.client.adjustWalletByIdentity(
        this.identity(sender),
        amount * direction,
        isAddition ? "Koishi 管理员增加余额" : "Koishi 管理员扣除余额",
      );
      return `✅ 已为用户 ${formatPlayerReference(sender)}${isAddition ? "增加" : "扣除"} ${formatNumber(amount)} ${(await this.config()).currencyName}`;
    }, bot);
  }

  async overwriteTargetCheckout(actor: Sender, targetSubject: string, rawAmount: string, rawReason?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender) => {
      const total = Number(rawAmount);
      if (!Number.isFinite(total) || total < 0) return "金额必须为非负数";
      const reason = cleanText(rawReason) || "管理员调价";
      const result = (await this.client.checkoutWithOverrideByIdentity(this.identity(sender), total, reason)) as UncheckedRecord;
      return this.formatAndNotifyCheckout(result, sender, "✅ 覆盖结账成功 · 结算账单", bot);
    }, bot);
  }

  /**
   * Seat the player at a table. The platform opens the table (starting
   * everyone's billing) once it fills, so a player need not enter first.
   */
  async mahjongJoin(sender: Sender, rawTableRef: string): Promise<string> {
    const tableRef = cleanText(rawTableRef);
    if (!tableRef) return "请指定麻将桌，例如 /上桌 a；可先使用 /麻将列表 查看可用桌位。";
    const table = findMahjongTable((await this.config()).mahjongTables, tableRef);
    if (!table) return `未找到麻将桌「${tableRef}」。可先使用 /麻将列表 查看可用桌位。`;
    let state: MahjongTableState;
    try {
      state = ((await this.client.mahjongByIdentity(this.identity(sender), table.id, "join")) as UncheckedRecord).mahjong;
    } catch (error) {
      if (!(error instanceof PrismBotClientError)) throw error;
      if (error.code === "MAHJONG_TABLE_NOT_FOUND") return `未找到麻将桌「${tableRef}」。可先使用 /麻将列表 查看可用桌位。`;
      if (error.code === "MAHJONG_TABLE_FULL") return `「${table.name}」已满桌，请等待本局结束后再上桌。`;
      if (error.code === "MAHJONG_ALREADY_SEATED") return "你已经在另一张麻将桌上，请先 /下桌。";
      const message = platformMessage(error);
      if (message) return `上桌失败，${message}`;
      throw error;
    }
    const seated = state.seats.length;
    const mine = state.seats.find((seat) => seat.mine);
    if (mine?.playing) return `已加入 ${table.name}，麻将计费已开始。当前 ${seated}/${state.capacity} 人。`;
    return `已加入 ${table.name}，当前 ${seated}/${state.capacity} 人，满 ${state.capacity} 人开始计费。`;
  }

  /** Leave the table the player sits at, or the one named. */
  async mahjongLeave(sender: Sender, rawTableRef?: string): Promise<string> {
    const tableRef = cleanText(rawTableRef);
    const named = tableRef ? findMahjongTable((await this.config()).mahjongTables, tableRef) : null;
    if (tableRef && !named) return `未找到麻将桌「${tableRef}」。可先使用 /麻将列表 查看可用桌位。`;
    const [listing, player] = await Promise.all([this.client.listMahjongTables(), this.resolvePlayer(sender)]);
    const playerId = String(player?.id ?? "");
    const tables = ((listing as UncheckedRecord)?.tables ?? []) as MahjongTableState[];
    const table = tables.find((candidate) =>
      (!named || candidate.id === named.id) && candidate.seats.some((seat) => seat.playerId === playerId));
    if (!table?.id) return named ? `你当前不在 ${named.name}。` : "你当前未在任何麻将桌上。";
    const name = table.name || named?.name || table.id;
    const wasPlaying = table.seats.some((seat) => seat.playerId === playerId && seat.playing);
    let result: UncheckedRecord;
    try {
      result = (await this.client.mahjongByIdentity(this.identity(sender), table.id, "leave")) as UncheckedRecord;
    } catch (error) {
      if (!(error instanceof PrismBotClientError)) throw error;
      if (error.code === "MAHJONG_TABLE_NOT_FOUND") return "你当前未在任何麻将桌上。";
      const message = platformMessage(error);
      if (message) return `下桌失败，${message}`;
      throw error;
    }
    const state = result.mahjong as MahjongTableState;
    // Getting up does not check out: what still bills is said, so leaving the shop means /logout.
    const remaining = Array.isArray(result.billing?.remaining)
      ? result.billing.remaining.filter((plan: unknown) => typeof plan === "string" && plan)
      : [];
    return `已离开 ${name}${wasPlaying ? "，麻将计费已停止" : ""}。当前还剩 ${state.seats.length}/${state.capacity} 人。`
      + (remaining.length ? `\n仍在计费：${remaining.join("、")}` : "");
  }

  async listMahjongTables(): Promise<string> {
    const result = (await this.client.listMahjongTables()) as UncheckedRecord;
    const tables = (result?.tables ?? []) as MahjongTableState[];
    if (tables.length === 0) return "当前没有配置任何麻将机。";
    const lines = [`🀄️ 麻将机列表（${tables.length} 台）`];
    for (const table of tables) {
      const playing = table.seats.filter((seat) => seat.playing).length;
      const waiting = table.seats.length - playing;
      const statuses = [
        ...(playing > 0 ? [`游玩中 ${playing}/${table.capacity}`] : []),
        ...(waiting > 0 ? [`等位 ${waiting}/${table.capacity}`] : []),
      ];
      const aliases = table.aliases ?? [];
      lines.push(`- ${table.name}｜别名：${aliases.length > 0 ? aliases.join("、") : "无"}｜${statuses.join("；") || "空闲"}`);
    }
    return lines.join("\n");
  }

  async billing(sender: Sender): Promise<string> {
    const result = (await this.client.previewCheckoutByIdentity(this.identity(sender))) as UncheckedRecord;
    return this.formatCheckoutPreview(result, sender, "【结算账单】", true);
  }

  async logout(sender: Sender, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    // A Koishi instance can receive identical userId values from different adapters.
    // In-flight settlement coalescing must use the same composite identity as Bot RPC.
    const key = `${sender.provider}:${sender.id}`;
    const existing = this.logoutInFlight.get(key);
    if (existing) return existing;
    const task = this.performLogout(sender, bot);
    this.logoutInFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.logoutInFlight.get(key) === task) this.logoutInFlight.delete(key);
    }
  }

  private async performLogout(sender: Sender, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    const result = (await this.client.confirmCheckoutByIdentity(this.identity(sender), false)) as UncheckedRecord;
    return this.formatAndNotifyCheckout(result, sender, "✅ 退场成功 · 结算账单", bot);
  }

  private async formatAndNotifyCheckout(
    result: UncheckedRecord,
    sender: Sender,
    title: string,
    bot?: KoishiActionContext["session"]["bot"],
  ): Promise<string> {
    const settlement = result.playerSettlement;
    const records = result.settlements as UncheckedRecord[];
    const checkoutAdjustments = result.checkoutAdjustments as UncheckedRecord[];
    const pricingCapAdjustments = result.pricingCapAdjustments as UncheckedRecord[];
    const checkoutAdjustmentKeys = new Set(checkoutAdjustments.map(adjustmentKey));
    const pricingCapAdjustmentKeys = new Set(pricingCapAdjustments.map(adjustmentKey));
    const sessionPreviews = records.map((rec: UncheckedRecord) => {
      const s = rec.settlement;
      const sessionAdjustments = (rec.adjustments as UncheckedRecord[]).filter((adjustment) => {
        const key = adjustmentKey(adjustment);
        return !checkoutAdjustmentKeys.has(key) &&
          !pricingCapAdjustmentKeys.has(key) &&
          !isPricingCapAdjustment(adjustment);
      });
      const sessionSubtotal = toNumber(s.subtotal);
      return {
        sessionId: s.sessionId,
        label: s.label,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        status: "closed",
        subtotal: sessionSubtotal,
        total: sessionSubtotal + sessionAdjustments.reduce(
          (sum, adjustment) => sum + toNumber(adjustment?.amount ?? 0),
          0,
        ),
        chargeItems: rec.chargeItems,
        adjustments: sessionAdjustments,
      };
    });
    const synthetic = {
      settlementPreview: {
        playerId: settlement.playerId,
        subtotal: settlement.subtotal,
        total: settlement.total,
      },
      sessionPreviews,
      chargeItems: result.chargeItems,
      checkoutAdjustments,
      pricingCapAdjustments,
      globalCapWindows: result.globalCapWindows,
      wallet: result.wallet,
    };
    const receipt = await this.formatCheckoutPreview(synthetic, sender, title, false);
    // Staff reachable through this adapter get the receipt privately, when the bot's settings say so.
    const config = await this.config();
    const channelIds = config.settings.receiptsToStaff
      ? [...new Set(config.staff.filter((identity) => identity.provider === sender.provider).map((identity) => `private:${identity.subject}`))]
      : [];
    if (channelIds.length > 0 && bot?.broadcast) await bot.broadcast(channelIds, receipt);
    return receipt;
  }

  async wallet(sender: Sender): Promise<string> {
    const result = (await this.client.getWalletByIdentity(this.identity(sender))) as UncheckedRecord;
    return formatWallet(result.wallet as UncheckedRecord[], (await this.config()).currencyName);
  }

  /**
   * The wallet query over plain HTTP. The first request usually has to open a
   * connection (DNS, TCP, TLS), so it is reported apart from the reused ones.
   */
  async benchmarkApi(sender: Sender, rawCount?: string): Promise<string> {
    const count = benchmarkCount(rawCount);
    if (count === null) return "次数须为 1 到 10 的整数。";
    const timings: Timing[] = [];
    for (let index = 0; index < count; index++) timings.push(await this.client.timeWalletOverHttp(this.identity(sender)));
    const [first, ...rest] = timings;
    return [
      `📡 API 测速（HTTP，钱包查询 ${count} 次）`,
      `首次：${Math.round(first!.ms)} ms（含建立连接）`,
      ...(rest.length ? [`之后：${spread(rest.map((timing) => timing.ms))}`] : []),
      ...serverLine(timings),
      ...(first!.colo ? [`节点：${first!.colo}`] : []),
    ].join("\n");
  }

  /** Heartbeats (the network alone) and the same wallet query over the platform connection. */
  async benchmarkWs(sender: Sender, rawCount?: string): Promise<string> {
    const count = benchmarkCount(rawCount);
    if (count === null) return "次数须为 1 到 10 的整数。";
    const pings: number[] = [];
    for (let index = 0; index < count; index++) pings.push(await this.client.pingSocket());
    const timings: Timing[] = [];
    for (let index = 0; index < count; index++) timings.push(await this.client.timeWalletOverSocket(this.identity(sender)));
    return [
      `📡 WS 测速（${count} 次）`,
      `心跳：${spread(pings)}`,
      `钱包查询：${spread(timings.map((timing) => timing.ms))}`,
      ...serverLine(timings),
    ].join("\n");
  }

  async versions(): Promise<string> {
    let backendVersion = "不可用";
    try {
      backendVersion = formatReleaseVersion(await this.client.getVersion());
    } catch {
      // The Bot version remains useful when the backend is offline or too old.
    }
    return [
      "PRiSM 版本信息",
      `Bot：${version}`,
      `后端：${backendVersion}`,
    ].join("\n");
  }

  async items(sender: Sender): Promise<string> {
    const result = (await this.client.getAssetsByIdentity(this.identity(sender))) as UncheckedRecord;
    const holdings = result.holdings as UncheckedRecord[];
    if (holdings.length === 0) return "您当前没有任何物品。";
    return ["🎒 --- 您拥有的物品 ---", ...holdings.map(formatInventoryItem)].join("\n");
  }

  async history(sender: Sender): Promise<string> {
    const result = (await this.client.getSessionHistoryByIdentity(this.identity(sender))) as UncheckedRecord;
    return formatHistory(result.sessions as UncheckedRecord[], (await this.config()).currencyName);
  }

  /** Open the door the bot's settings name. */
  async lock(sender: Sender): Promise<string> {
    const door = (await this.config()).door;
    if (!door) return "🔑 本店还没有设置 Bot 开的门";
    try {
      const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
        type: "door.open",
        target: { kind: "facility", ref: door.id },
      });
      const failure = this.getCommandFailureMessage(result);
      if (failure) {
        this.logDeviceCommandFailure(result);
        return `🔑 开门失败，${deviceCommandFailureReason(result)}`;
      }
      if (result?.action?.executorKind && result.action.executorKind !== "ttlock") {
        return "🔑 门锁指令已发送";
      }
      const password = cleanText(result?.action?.payload?.temporaryPassword);
      if (!password) return "🔑 临时门锁密码生成失败，请稍后再试";
      return `🔑 临时门锁密码：${password}\n有效期：3 分钟`;
    } catch (error) {
      this.logCommandError(error);
      return `🔑 开门失败，${deviceActionFailureReason(error)}`;
    }
  }

  async powerOn(sender: Sender, rawDeviceRef: string): Promise<string> {
    const deviceRef = cleanText(rawDeviceRef);
    if (!deviceRef) return commandUsage("prism_on");
    return this.power(sender, deviceRef, "on");
  }

  async powerOff(sender: Sender, rawDeviceRef: string): Promise<string> {
    const deviceRef = cleanText(rawDeviceRef);
    if (!deviceRef) return commandUsage("prism_off");
    return this.power(sender, deviceRef, "off");
  }

  async coin(sender: Sender, rawDeviceRef: string, rawCount: string): Promise<string> {
    const deviceRef = cleanText(rawDeviceRef);
    if (!deviceRef) return commandUsage("prism_coin");
    const { value, error } = parsePositiveInt(rawCount, "prism_coin", "数量", 1);
    if (error) return error;
    try {
      const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
        type: "coin",
        target: { kind: "game_machine", ref: deviceRef },
        payload: { count: value },
      });
      const failure = deviceCommandFailureReason(result);
      if (failure) {
        this.logDeviceCommandFailure(result);
        return `投币失败，${failure}`;
      }
      const label = deviceCommandLabel(result) || deviceRef;
      return `🪙 ${label} 投币成功（${value} 币）`;
    } catch (error) {
      this.logCommandError(error);
      return `投币失败，${deviceActionFailureReason(error)}`;
    }
  }

  async scan(sender: Sender, rawDeviceRef: string): Promise<string> {
    const deviceRef = cleanText(rawDeviceRef);
    if (!deviceRef) return commandUsage("prism_scan");
    try {
      const result = await this.client.requestScanByIdentity(this.identity(sender), {
        deviceRef,
        provider: "aime",
      });
      const failure = deviceCommandFailureReason(result);
      if (failure) {
        this.logDeviceCommandFailure(result);
        return `刷卡失败，${failure}`;
      }
      const label = deviceCommandLabel(result) || deviceRef;
      return `💳 ${label} 刷卡成功`;
    } catch (error) {
      this.logCommandError(error);
      return `刷卡失败，${deviceActionFailureReason(error)}`;
    }
  }

  async redeem(sender: Sender, rawCode: string): Promise<string> {
    const code = cleanText(rawCode);
    if (!code) return commandUsage("prism_redeem");
    const result = (await this.client.redeemCodeByIdentity(this.identity(sender), code)) as UncheckedRecord;
    const grantedAssets = result.grantedAssets as UncheckedRecord[];
    if (grantedAssets.length === 0) return "兑换成功，但没有获得任何物品。";
    return ["✅ 兑换成功！您获得了以下物品：", ...grantedAssets.map(formatRedeemedItem)].join("\n");
  }

  /**
   * Who is in the shop, as the platform lists them: every player playing or
   * billing, each once, at the resource they occupy (with its head count and
   * capacity) or their most specific plan. With a name, everyone on that
   * resource or billing that plan.
   */
  async listActiveSessions(sender: Sender, name?: string): Promise<string> {
    const wanted = cleanText(name);
    let roster: RosterView;
    try {
      roster = (await this.client.roster(wanted || undefined)) as RosterView;
    } catch (error) {
      if (wanted && error instanceof PrismBotClientError && error.code === "ROSTER_TARGET_NOT_FOUND") return `找不到「${wanted}」`;
      throw error;
    }
    const groups: PlayerGroup[] = [];
    for (const group of roster.groups ?? []) {
      const players: ActivePlayer[] = [];
      for (const member of group.members ?? []) {
        const player: ActivePlayer = {
          playerId: member.playerId,
          sessions: [{ playerDisplayName: member.displayName ?? undefined, identities: member.identities ?? [] }],
        };
        player.displayName = await this.displayNameForPlayer(player, sender.provider);
        players.push(player);
      }
      groups.push({ label: group.name, ...(group.kind === "resource" ? { capacity: group.capacity } : {}), players });
    }
    const [only] = groups;
    if (wanted && only && !only.players.length) {
      return only.capacity !== undefined ? `${only.label} ( 0/${only.capacity} )` : `${only.label} ( 0人 )`;
    }
    if (wanted) return formatPlayerGroups(groups);
    // The whole shop: players on a resource are listed there, everyone else together,
    // whatever plan they bill. Asking for a plan by name still lists that plan.
    const onResources = groups.filter((group) => group.capacity !== undefined);
    const others = groups.filter((group) => group.capacity === undefined).flatMap((group) => group.players);
    return formatPlayerGroups([...onResources, ...(others.length ? [{ label: OTHER_PLAYERS_LABEL, players: others }] : [])]);
  }

  async listDeviceStates(rawAlias?: string): Promise<string> {
    const alias = cleanText(rawAlias);
    const result = (await this.client.listDeviceStates()) as UncheckedRecord;
    const states = (result?.deviceStates ?? []) as DeviceStateItem[];
    if (states.length === 0) return "没有找到任何设备状态。";

    if (alias) {
      const matched = states.find((d) => d.deviceId === alias || d.label === alias || d.aliases?.some((value) => value.trim().toLowerCase() === alias.toLowerCase()));
      if (!matched) return `找不到设备: ${alias}`;
      const stateVal = normalizeDeviceState(matched.state);
      return `${matched.label || matched.deviceId}: ${stateVal}`;
    }
    return states
      .map((d) => `${d.label || d.deviceId}: ${normalizeDeviceState(d.state)}`)
      .join("\n");
  }

  /** Keep a running device from being switched off as idle; never switches one on. */
  async keep(sender: Sender, deviceRef: string): Promise<string> {
    try {
      const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
        type: "power.keep",
        target: { kind: "facility", ref: deviceRef },
      });
      if (this.getCommandFailureMessage(result)) {
        this.logDeviceCommandFailure(result);
        return `延迟失败，${deviceCommandFailureReason(result)}`;
      }
      return `✅ ${result.action.payload.deviceLabel} 已延迟关机`;
    } catch (error) {
      this.logCommandError(error);
      return `延迟失败，${powerFailureReason(error)}`;
    }
  }

  /* ---------------------------- helpers ---------------------------------- */

  private async power(sender: Sender, deviceRef: string, state: string): Promise<string> {
    const operation = state === "on" ? "启动" : "关闭";
    const config = await this.config();
    const staffOverride = state === "off" && config.settings.powerOffStaffOnly;
    if (staffOverride && !this.isStaff(config, sender)) {
      return `${operation}失败，权限不足`;
    }
    try {
      const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
        type: state === "on" ? "power.on" : "power.off",
        target: { kind: "facility", ref: deviceRef },
        payload: { state },
      }, staffOverride ? { staffOverride: true } : undefined);
      const failure = this.getCommandFailureMessage(result);
      if (failure) {
        this.logDeviceCommandFailure(result);
        return `${operation}失败，${deviceCommandFailureReason(result)}`;
      }
      const deviceLabel = result.action.payload.deviceLabel;
      return state === "on" ? `✅ ${deviceLabel} 启动成功` : `🛑 ${deviceLabel} 关闭成功`;
    } catch (error) {
      this.logCommandError(error);
      return `${operation}失败，${powerFailureReason(error)}`;
    }
  }

  /** Whether the action failed; the message itself is logged, never shown as it is. */
  private getCommandFailureMessage(result: any): string | null {
    const action = result?.action;
    // `pending` here is an unanswered request (a timeout): it counts as not done.
    if (action?.status === "expired" || action?.status === "rejected" || action?.status === "pending") {
      return action.payload?.executorFailure?.message || "命令执行被拒绝或超时";
    }
    return null;
  }

  private async resolvePlatformName(subject: string, provider: string): Promise<string | null> {
    if (!this.options.resolveDisplayName) return null;
    try {
      return (await this.options.resolveDisplayName(subject, provider)) ?? null;
    } catch {
      return null;
    }
  }

  private async displayNameForPlayer(player: ActivePlayer, provider: string): Promise<string> {
    let identitySubject: string | undefined;
    for (const session of player.sessions) {
      const subject = findSubjectForSession(session, provider);
      if (!subject) continue;
      identitySubject ??= subject;
      const platformName = await this.resolvePlatformName(subject, provider);
      if (platformName) return platformName;
    }
    return player.sessions.find((session) => session.playerDisplayName)?.playerDisplayName
      || identitySubject
      || player.displayName
      || player.playerId
      || "未知玩家";
  }

  private async resolvePlayerDisplay(sender: Sender | null, playerId?: string): Promise<string> {
    if (!sender) return playerId || "未知玩家";
    const platformName = await this.resolvePlatformName(sender.id, sender.provider);
    const name = platformName
      || (sender.name && sender.name !== sender.id ? sender.name : "")
      || "未知昵称";
    return `玩家：${name}（${sender.provider}:${sender.id}）`;
  }


  private async resolvePlayer(sender: Sender): Promise<UncheckedRecord> {
    return (await this.client.resolveOrRegisterIdentity(this.identity(sender))) as UncheckedRecord;
  }

  private identity(sender: Sender): IdentityInput {
    return {
      provider: sender.provider,
      subject: sender.id,
      displayName: sender.name || `${sender.provider} ${sender.id}`,
    };
  }

  private async targetSender(actor: Sender, targetSubject?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<Sender | string> {
    const raw = cleanText(targetSubject);
    if (!raw) return actor;
    const separator = raw.indexOf(":");
    const provider = separator > 0 ? raw.slice(0,separator).toLowerCase() : actor.provider;
    const subject = separator > 0 ? raw.slice(separator+1) : raw;
    if (provider !== actor.provider) return "请在目标平台使用该命令";
    if (!subject) return "无法获取目标平台身份";
    // Acting for another player is for staff, and only when the bot's settings allow it.
    const config = await this.config();
    if (!config.settings.staffCommands) return "员工命令未启用";
    if (!this.isStaff(config, actor)) return "权限不足";
    try {
      const user = await bot?.getUser?.(subject);
      return { id: subject, name: user?.name || subject, provider };
    } catch {
      return { id: subject, name: subject, provider };
    }
  }

  private async formatCheckoutPreview(
    result: UncheckedRecord,
    sender: Sender | null,
    title = "【结算账单】",
    isPreview: boolean,
  ): Promise<string> {
    const currency = (await this.config()).currencyName;
    const preview = result.settlementPreview;
    const playerId = preview.playerId;
    const subtotal = preview.subtotal;
    const total = preview.total;
    const previewedAt = parseDateTime(preview.previewedAt);
    const sessionPreviews = result.sessionPreviews as UncheckedRecord[];
    const pricingCapAdjustments = result.pricingCapAdjustments as UncheckedRecord[];
    const checkoutAdjustments = result.checkoutAdjustments as UncheckedRecord[];
    const wallet = result.wallet as UncheckedRecord;
    const balanceBefore = toNumber(wallet?.balanceBefore ?? 0);
    const balanceAfter = toNumber(wallet?.balanceAfter ?? 0);
    const lines: string[] = [];

    lines.push(title);
    lines.push(await this.resolvePlayerDisplay(sender, playerId));

    const hasNonZeroSessionTotal = sessionPreviews.some((session) =>
      toNumber(session?.total ?? 0) !== 0,
    );
    const hasNonZeroAdjustment = hasAdjustmentEntries(checkoutAdjustments, sessionPreviews);
    if (!hasNonZeroSessionTotal && !hasNonZeroAdjustment) {
      lines.push("");
      lines.push("本次未产生费用");
      lines.push(`余额：${formatNumber(isPreview ? balanceBefore : balanceAfter)}${currency}`);
      return lines.join("\n");
    }

    const validStarts = sessionPreviews.map(s => s.startedAt).filter(value => parseDateTime(value)) as string[];
    const validEnds = sessionPreviews.map(s => s.endedAt || (s.status === "active" ? preview.previewedAt : null)).filter(value => parseDateTime(value)) as string[];
    if (validStarts.length > 0) {
      const overallStart = validStarts.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b);
      const overallEnd = validEnds.length > 0 ? validEnds.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : now(this.options).toISOString();
      const offsets = [...new Set([apiOffsetLabel(overallStart), apiOffsetLabel(overallEnd)])].join(" / ");
      lines.push(`⏰ 游玩时间：${formatHM(overallStart)}–${formatHM(overallEnd)}（${offsets}）`);
    }

    for (const sPrev of sessionPreviews) {
      const label = sPrev?.label === "entry" ? DEFAULT_PLAN_LABEL : sPrev?.label || "计时区间";
      const startDt = parseDateTime(sPrev?.startedAt);
      const endDt = sessionDisplayEnd(sPrev, previewedAt);
      const status = sPrev?.status ?? "active";
      const sTotal = toNumber(sPrev?.total ?? 0);
      lines.push("");
      lines.push(label);
      if (startDt && endDt) {
        const minutes = Math.floor((endDt.getTime() - startDt.getTime()) / 60_000);
        lines.push(`游玩时段：${formatHM(sPrev.startedAt)}-${formatHM(sPrev.endedAt || preview.previewedAt || endDt.toISOString())}`);
        lines.push(`游玩时长：${formatDurationValue(minutes)}｜计价：${formatNumber(sTotal)}${currency}`);
      } else if (startDt) {
        lines.push(`入场：${formatHM(sPrev.startedAt)}  （${status === "active" ? "计费中" : "已关闭"}）`);
      }
      const sessionAdjustments = (sPrev?.adjustments ?? []) as UncheckedRecord[];
      for (const adj of sessionAdjustments) {
        const amount = toNumber(adj.amount);
        if (amount === 0) continue;
        const adjLabel = adj.label || adj.source || "优惠";
        lines.push(`  └ ${adjLabel}：${formatNumber(amount)}${currency}`);
      }
    }

    const cappedWindows = (result.globalCapWindows as UncheckedRecord[]).filter((window) =>
      toNumber(window?.currentAmount) !== toNumber(window?.amountApplied),
    );
    if (cappedWindows.length > 0) {
      lines.push("");
      lines.push("封顶：");
      for (const window of cappedWindows) {
        const label = window.ruleLabel || "封顶时段";
        const startedAt = parseDateTime(window.windowStartedAt);
        const datedLabel = startedAt ? `${formatMD(window.windowStartedAt)} ${label}` : label;
        const currentAmount = toNumber(window.currentAmount);
        const amountApplied = toNumber(window.amountApplied);
        const priceCap = toNumber(window.priceCap);
        const paidBefore = toNumber(window.paidBefore);
        const details = [`上限${formatNumber(priceCap)}`];
        if (paidBefore > 0) details.push(`已计${formatNumber(paidBefore)}`);
        lines.push(
          `- ${datedLabel}：${formatNumber(currentAmount)} → ${formatNumber(amountApplied)}${currency}（${details.join("，")}）`,
        );
      }
    }

    const visibleCheckoutAdjustments = checkoutAdjustments.filter((adjustment) => {
      const amount = toNumber(adjustment.amount);
      const isOverride = cleanText(adjustment?.source).startsWith("staff.override:");
      return amount !== 0 && !isOverride;
    });
    lines.push("");
    const cappedTotal = Math.max(0, toNumber(subtotal) + pricingCapAdjustments.reduce(
      (sum, adjustment) => sum + toNumber(adjustment?.amount ?? 0),
      0,
    ));
    lines.push(`计费总价：${formatNumber(cappedTotal)}${currency}`);

    const hasManualAdjustment = checkoutAdjustments.some((adjustment) =>
      cleanText(adjustment?.source).startsWith("staff.override:"),
    );
    if (visibleCheckoutAdjustments.length > 0) {
      lines.push("");
      for (const adjustment of visibleCheckoutAdjustments) {
        const amount = toNumber(adjustment.amount);
        const label = adjustment.label || adjustment.source || "优惠";
        lines.push(`${label}：${formatNumber(amount)}${currency}`);
      }
    }

    if (hasNonZeroAdjustment) {
      if (visibleCheckoutAdjustments.length > 0) lines.push("");
      lines.push(`${hasManualAdjustment ? "调整后价格" : "优惠后价格"}：${formatNumber(total)}${currency}`);
    }
    if (isPreview) {
      lines.push(`当前余额：${formatNumber(balanceBefore)}${currency}`);
      lines.push(balanceAfter >= 0
        ? `预计结账后余额：${formatNumber(balanceAfter)}${currency}`
        : `预计结账后余额：余额不足（还差 ${formatNumber(-balanceAfter)}${currency}）`);
    } else {
      lines.push(`扣款后余额：${formatNumber(balanceAfter)}${currency}`);
    }

    return lines.join("\n");
  }

  handleCommandError(error: unknown): string {
    this.logCommandError(error);
    if (error instanceof PrismBotClientError) {
      const shopCode = this.options.shopCode ?? this.bot?.shop?.code;
      if (error.code?.startsWith("LOCATION_") && shopCode && this.options.baseUrl) {
        return `请在网页完成到店校验：${this.options.baseUrl.replace(/\/+$/, "")}/t/${encodeURIComponent(shopCode)}`;
      }
      return humanReadableBotError(error);
    }
    return genericCommandFailure();
  }

  private logCommandError(error: unknown): void {
    this.logger?.warn("PRiSM Bot command failed", error instanceof PrismBotClientError
      ? (error.originalError ?? error)
      : error);
  }

  private logDeviceCommandFailure(result: unknown): void {
    const action = (result as UncheckedRecord)?.action as UncheckedRecord | undefined;
    this.logger?.warn("PRiSM device command failed", action?.payload?.executorFailure ?? action);
  }
}

/* ------------------------------ utilities --------------------------------- */

export type Sender = { id: string; name: string; provider: string };

export function humanReadableBotError(error: PrismBotClientError): string {
  if (error.code === "INVALID_PLATFORM_IDENTITY") return error.message;
  if (error.code === "BOT_DISABLED") return "Bot 已被店铺停用";
  if (error.code === "BILLING_DISABLED") return BILLING_DISABLED_NOTICE;
  if (error.code === "RESOURCE_NOT_BILLED") return RESOURCE_NOT_BILLED_NOTICE;
  if (error.code === "PLAYER_HAS_NO_UNSETTLED_SESSIONS") {
    return "您当前没有未结算的账单，无需结账。";
  }
  if (error.code === "ACTIVE_SESSION_NOT_FOUND") {
    return "您当前没有进行中的计费场次。";
  }
  if (error.code === "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION") {
    return "操作失败，玩家未入场";
  }
  if (error.code === "PLAYER_IDENTITY_NOT_FOUND") {
    return "未找到您的玩家身份，请先注册或绑定账号。";
  }
  if (error.code === "INSUFFICIENT_BALANCE") {
    return "余额不足，暂时不能结账。请先充值，或由店员在后台改价后再结账。";
  }
  if (error.code === "API_UNREACHABLE") return "操作失败，暂时连不上服务器。";
  if (error.code === "NETWORK_ERROR" || error.code === "HTTP_0") {
    return genericCommandFailure();
  }
  if (error.code === "API_TIMEOUT") {
    return genericCommandFailure();
  }
  if (error.code === "INVALID_JSON_RESPONSE") {
    return genericCommandFailure();
  }
  if (error.code === "STAFF_TOKEN_REQUIRED") {
    return genericCommandFailure();
  }
  return genericCommandFailure();
}

function powerFailureReason(error: unknown): string {
  if (error instanceof PrismBotClientError) {
    if (error.code === "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION") return "玩家未入场";
    if (error.code === "PLAYER_IDENTITY_NOT_FOUND") return "玩家未注册";
    if (error.code === "BILLING_DISABLED") return BILLING_DISABLED_NOTICE;
    if (error.code === "DEVICE_NOT_FOUND") return "没有这个设备";
  }
  return "请稍后再试";
}

function deviceActionFailureReason(error: unknown): string {
  if (!(error instanceof PrismBotClientError)) return "请稍后再试";
  if (error.code === "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION") return "玩家未入场";
  if (error.code === "DEVICE_NOT_FOUND") return "设备不存在";
  if (error.code === "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER") return "玩家未绑定 Aime 卡";
  if (error.code === "COIN_COMMAND_COOLDOWN_ACTIVE") return "投币冷却中，请稍后再试";
  if (error.code === "BILLING_DISABLED") return BILLING_DISABLED_NOTICE;
  return "请稍后再试";
}

/**
 * What a player may be told about a device that would not act. Only facts about
 * the device itself — whether it exists, is connected, is off, answered — never
 * how the shop configured it or what went wrong inside the platform.
 */
const DEVICE_REASONS: Array<[RegExp, string]> = [
  [/设备不存在|没有找到这个资源/, "没有这个设备"],
  [/机台未在线|没有在线客户端|设备未连接|直连中继尚未配置/, "设备未连接"],
  [/设备已关机/, "设备已关机"],
  [/设备未响应|机台未响应/, "设备没有响应"],
];

function deviceCommandFailureReason(result: unknown): string | null {
  const action = (result as UncheckedRecord)?.action as UncheckedRecord | undefined;
  if (!action || (action.status !== "expired" && action.status !== "rejected" && action.status !== "pending")) return null;
  const message = cleanText(action.payload?.executorFailure?.message);
  return DEVICE_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? "操作没有完成，请找店员";
}

function deviceCommandLabel(result: unknown): string {
  return cleanText((result as UncheckedRecord)?.action?.payload?.deviceLabel);
}

function genericCommandFailure(): string {
  return "操作失败，请稍后再试。";
}

function normalizeDeviceState(value: DeviceStateItem["state"]): string {
  if (typeof value === "object" && value !== null) {
    return cleanText(value.state) || "unknown";
  }
  const raw = cleanText(value);
  if (!raw) return "unknown";
  if (raw.startsWith("{")) {
    try {
      const decoded = JSON.parse(raw) as { state?: unknown };
      return cleanText(decoded?.state) || "unknown";
    } catch {
      return raw;
    }
  }
  return raw;
}

/** The table a player named, by id, name or alias, as the platform matches it. */
function findMahjongTable(tables: readonly MahjongTable[], ref: string): MahjongTable | null {
  const target = ref.trim().toLowerCase();
  return tables.find((table) =>
    [table.id, table.name, ...table.aliases].some((value) => cleanText(value).toLowerCase() === target)) ?? null;
}

/** The platform's own message for a refusal, when it gave one; never the fallback naming an HTTP status. */
function platformMessage(error: PrismBotClientError): string | null {
  if (error.status < 400 || error.status >= 500) return null;
  const message = (error.body as UncheckedRecord)?.error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * The bot's settings as the platform sent them. Anything missing takes the
 * platform's own default, so a newer setting an older platform lacks does no harm.
 */
function parseBotConfig(value: unknown): BotConfig {
  const record = (value && typeof value === "object" ? value : {}) as UncheckedRecord;
  const settings = (record.settings ?? {}) as UncheckedRecord;
  const strings = (list: unknown) => (Array.isArray(list) ? list : []).map(cleanText).filter(Boolean);
  return {
    bot: { id: cleanText(record.bot?.id), name: cleanText(record.bot?.name) || "Bot" },
    settings: {
      playerCommands: settings.playerCommands === "readonly" ? "readonly" : "all",
      readOnlyNotice: cleanText(settings.readOnlyNotice),
      staffCommands: settings.staffCommands !== false,
      powerOffStaffOnly: settings.powerOffStaffOnly === true,
      receiptsToStaff: settings.receiptsToStaff === true,
      idleChannelIds: strings(settings.idleChannelIds),
      idleReminderMinutes: Math.max(0, Number(settings.idleReminderMinutes ?? 5) || 0),
      eventChannelIds: strings(settings.eventChannelIds),
      announcePower: settings.announcePower === true,
      announceCards: settings.announceCards === true,
      announceStarts: settings.announceStarts === true,
    },
    billingEnabled: record.billingEnabled !== false,
    currencyName: cleanText(record.currencyName) || "余额",
    staff: (Array.isArray(record.staff) ? record.staff : [])
      .map((identity: UncheckedRecord) => ({ provider: cleanText(identity?.provider).toLowerCase(), subject: cleanText(identity?.subject) }))
      .filter((identity: { provider: string; subject: string }) => identity.provider && identity.subject),
    door: record.door?.id ? { id: cleanText(record.door.id), name: cleanText(record.door.name) } : null,
    mahjongTables: (Array.isArray(record.mahjongTables) ? record.mahjongTables : [])
      .filter((table: UncheckedRecord) => cleanText(table?.id))
      .map((table: UncheckedRecord) => ({
        id: cleanText(table.id),
        name: cleanText(table.name) || cleanText(table.id),
        aliases: strings(table.aliases),
        capacity: Number(table.capacity) || 4,
      })),
  };
}

/** What the shop's default plan is called when the platform gives no plan name. */
const DEFAULT_PLAN_LABEL = "入场计费";

function formatPlayerGroups(groups: readonly PlayerGroup[]): string {
  const populatedGroups = groups.filter((group) => group.players.length > 0);
  // Each person is in exactly one group.
  const total = populatedGroups.reduce((sum, group) => sum + group.players.length, 0);
  if (total === 0) return "🫥 窝里目前没有玩家呢";

  const lines = [`[总计 ${total} 人]`];
  for (const group of populatedGroups) {
    const heading = group.capacity !== undefined
      ? `${group.label} ( ${group.players.length}/${group.capacity} )`
      : `${group.label} ( ${group.players.length}人 )`;
    lines.push(`\n${heading}：\n${formatPlayerNames(group.players)}`);
  }
  return lines.join("\n");
}

function formatPlayerNames(players: ActivePlayer[]): string {
  return players.map((player) => `- ${player.displayName || player.playerId || "未知玩家"}`).join(", ");
}

function commandUsage(command: string): string {
  return `用法: ${USAGE[command] ?? command}`;
}

function parsePositiveInt(
  value: string | undefined,
  command: string,
  label: string,
  fallback?: number,
): { value: number; error: string | null } {
  const text = cleanText(value);
  if (!text) {
    if (fallback !== undefined) return { value: fallback, error: null };
    return { value: 0, error: commandUsage(command) };
  }
  const parsed = Number.parseInt(text, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return { value: 0, error: `${label}必须是正整数\n${commandUsage(command)}` };
  }
  return { value: parsed, error: null };
}

function cleanText(value: any): string {
  return value == null ? "" : String(value).trim();
}

function formatReleaseVersion(value: unknown): string {
  const record = value && typeof value === "object" ? value as UncheckedRecord : {};
  const release = cleanText(record.version) || "unknown";
  const revision = cleanText(record.revision);
  return !revision || revision === "unknown" ? release : `${release} (${revision})`;
}

function formatPlayerReference(sender: Sender): string {
  const name = sender.name && sender.name !== sender.id ? sender.name : "未知昵称";
  return `${name}（${sender.provider}:${sender.id}）`;
}

function adjustmentKey(adjustment: UncheckedRecord): string {
  const id = cleanText(adjustment?.id);
  if (id) return `id:${id}`;
  return JSON.stringify([
    adjustment?.source ?? "",
    adjustment?.label ?? "",
    toNumber(adjustment?.amount ?? 0),
  ]);
}

function isPricingCapAdjustment(adjustment: UncheckedRecord): boolean {
  return adjustment?.pricingCapHistory != null ||
    cleanText(adjustment?.source).startsWith("time.cap:") ||
    cleanText(adjustment?.id).startsWith("time-cap:");
}

function toNumber(value: any): number {
  if (value == null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (!text) return 0;
  const asInt = Number.parseInt(text, 10);
  if (!Number.isNaN(asInt)) return asInt;
  const asFloat = Number.parseFloat(text);
  if (!Number.isNaN(asFloat)) return asFloat;
  return 0;
}

function hasAdjustmentEntries(adjustments: unknown, sessionPreviews: UncheckedRecord[]): boolean {
  return (adjustments as UncheckedRecord[]).some((adjustment) =>
    toNumber(adjustment.amount) !== 0,
  ) || sessionPreviews.some((session) =>
    (session.adjustments as UncheckedRecord[]).some((adjustment) =>
      toNumber(adjustment.amount) !== 0,
    ),
  );
}

function formatNumber(value: any): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  const num = toNumber(value);
  if (num || String(value ?? "").trim() === "0" || String(value ?? "").trim() === "0.0") {
    return Number.isInteger(num) ? String(num) : String(num);
  }
  return String(value);
}

function formatDurationValue(minutes: any): string {
  const total = Math.floor(toNumber(minutes));
  if (total >= 60) {
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${hours}小时${mins}分钟`;
  }
  return `${total}分钟`;
}

function sessionDisplayEnd(session: UncheckedRecord, previewedAt: Date | null): Date | null {
  const endedAt = parseDateTime(session?.endedAt);
  if (endedAt) return endedAt;
  if (session?.status === "active") return previewedAt ?? now(undefined);
  return null;
}

function now(config: PrismKoishiPluginConfig | undefined): Date {
  return config?.now ? config.now() : new Date();
}

function formatInventoryItem(row: UncheckedRecord): string {
  let line = `- ${row.assetName || row.assetCode || "资产"} (x${formatNumber(row.quantity)})`;
  if (row.expiresAt) line += `\n  到期: ${formatDateTime(row.expiresAt)}`;
  return line;
}

function formatRedeemedItem(row: UncheckedRecord): string {
  return `- ${row.assetName || row.assetCode || "资产"} x${formatNumber(row.quantity)}`;
}

function formatWallet(rows: UncheckedRecord[], currency: string): string {
  const paid = rows
    .filter((row) => String(row.assetCode).toLowerCase().includes("paid"))
    .reduce((sum, row) => sum + toNumber(row.quantity), 0);
  const free = rows
    .filter((row) => String(row.assetCode).toLowerCase().includes("free"))
    .reduce((sum, row) => sum + toNumber(row.quantity), 0);
  const other = rows
    .filter((row) => {
      const code = String(row.assetCode).toLowerCase();
      return !code.includes("paid") && !code.includes("free");
    })
    .reduce((sum, row) => sum + toNumber(row.quantity), 0);
  const total = paid + free + other;
  return [
    "💰 --- 钱包余额 ---",
    `可用: ${formatNumber(total)} ${currency} (共 ${formatNumber(total)})`,
    `  - 付费: ${formatNumber(paid)}`,
    `  - 免费: ${formatNumber(free)}`,
  ].join("\n");
}

function formatHistory(sessions: UncheckedRecord[], currency: string): string {
  if (sessions.length === 0) return "暂无历史记录";
  const lines = [`📜 最近 ${sessions.length} 条记录:`];
  for (const session of sessions) {
    const end = session.endedAt ? formatDateTime(session.endedAt) : "进行中";
    const cost = session.total == null ? "未结算" : `${formatNumber(session.total)} ${currency}`;
    lines.push(`- [${session.sessionId}] ${formatDateTime(session.startedAt)} -> ${end} (${cost})`);
  }
  return lines.join("\n");
}

function findSubjectForSession(session: ActiveSessionListItem, provider: string): string | null {
  const identities = session.identities ?? [];
  if (identities.length === 0) return null;
  const identity = provider ? identities.find((id) => id.provider === provider) : identities[0];
  return identity?.subject ?? null;
}

export default {
  name,
  Config,
  ConfigSchema: Config,
  apply,
};
