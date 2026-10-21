import { apiOffsetLabel, formatDateTime, formatHM, formatMD, parseDateTime } from "./display-time.js";
import { h, Schema } from "koishi";
import packageMetadata from "../package.json";

export const name = "prism";
export const version = packageMetadata.version;

export const Config: Schema<PrismKoishiPluginConfig> = Schema.object({
  autoRegister: Schema.boolean().default(true).description("是否自动注册"),
  shopCode: Schema.string().required().description("统一平台店铺编号"),
  baseUrl: Schema.string().required().description("PRiSM 后端地址，例如 https://link.neri.moe"),
  integrationToken: Schema.string().role("secret").description("集成 API Token"),
  currencyName: Schema.string().default("猫粮").description("代币名称"),
  defaultDoorDeviceId: Schema.string().default("front-door").description("默认开门设备名或别名"),
  defaultScanProvider: Schema.string().default("aime").description("默认刷卡提供商"),
  loginPricingConfigIds: Schema.array(Schema.string()).default([]).description("默认入场绑定的计费策略ID"),
  loginSessionLabel: Schema.string().default("音游区间").description("默认入场场次标签 (防重复入场)"),
  enableStaffCommands: Schema.boolean().default(false).description("是否启用管理员指令"),
  staffUserIds: Schema.array(Schema.string()).default([]).description("允许执行管理员指令的平台身份列表（如 onebot:123456、telegram:123456）"),
  powerCommandsAdminOnly: Schema.boolean().default(false).description("关机是否仅允许管理员使用；开机始终仅已入场玩家可用"),
  playerCommands: Schema.union([
    Schema.const("all").description("全部：玩家可以在 Bot 里入场、结账、上下桌和操作设备"),
    Schema.const("readonly").description("只读：玩家只能绑定身份、查询和兑换；入场、结账、上下桌和设备操作仅管理员可用"),
  ]).default("all").description("玩家可用的命令"),
  readOnlyNotice: Schema.string().default("请扫描设备上的二维码或碰 NFC，在网页或 App Clip 里操作").description("只读模式下玩家使用受限命令时的回复"),
  logoutNotifyUserIds: Schema.array(Schema.string()).default([]).description("结账账单私聊通知的平台身份列表（如 onebot:123456）"),
  idleNotifyChannelIds: Schema.array(Schema.string()).default([]).description("闲置自动关机的提醒发到哪里：群写 onebot:群号，私聊写 onebot:private:QQ号"),
  idleReminderMinutes: Schema.number().min(0).max(120).default(5).description("自动关机前几分钟提醒（0 为不提醒）"),
  mahjongTableConfigs: Schema.array(Schema.object({
    displayName: Schema.string().required().description("桌位显示名称和 session 标签"),
    aliases: Schema.array(Schema.string()).default([]).description("命令别名（至少一个），例如 a、四麻A"),
    pricingConfigIds: Schema.array(Schema.string()).default([]).description("开局时绑定的计费方案 ID"),
  })).default([]).description("麻将桌配置"),
  mahjongTableSize: Schema.number().default(4).description("麻将桌人数限制"),
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

export type MahjongTableConfig = {
  tableId: string;
  displayName: string;
  aliases: string[];
  pricingConfigIds: string[];
};

export type MahjongTableConfigInput = Omit<MahjongTableConfig, "tableId">;

export type PrismKoishiPluginConfig = {
  autoRegister: boolean;
  /** "readonly" leaves players binding, lookups and redeeming; staff keep every command. */
  playerCommands?: "all" | "readonly";
  readOnlyNotice?: string;
  loginPricingConfigIds?: string[];
  loginSessionLabel?: string;
  defaultDoorDeviceId: string;
  defaultScanProvider: string;
  currencyName: string;
  enableStaffCommands?: boolean;
  staffUserIds?: string[];
  powerCommandsAdminOnly?: boolean;
  logoutNotifyUserIds?: string[];
  mahjongTableConfigs?: MahjongTableConfigInput[];
  mahjongTableSize?: number;
  /** Channels (`platform:channelId`) told before an idle power-off. */
  idleNotifyChannelIds?: string[];
  /** How many minutes before an idle power-off to tell them; 0 for never. */
  idleReminderMinutes?: number;
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
  mahjong_leave: "/下桌",
  mahjong_list: "/麻将列表",
  api_benchmark: "/api测速 [次数]",
  ws_benchmark: "/ws测速 [次数]",
  prism_on: "/prism on <设备名|别名|all>",
  prism_off: "/prism off <设备名|别名|all>",
  prism_keep: "/keep <设备名或别名>",
  prism_coin: "/prism coin <设备名或别名> [数量]",
  prism_scan: "/prism scan <设备名或别名>",
  prism_redeem: "/prism redeem <兑换码>",
  list: "/list",
  show: "/show [设备ID]",
};

type MahjongSeat = {
  playerId: string;
  senderId: string;
  displayName: string;
  identity: IdentityInput;
};

type MahjongTableState = {
  waiting: MahjongSeat[];
  activeSessions: Record<string, string>;
};

type IdentityInput = {
  provider: string;
  subject: string;
  autoRegister: boolean;
  displayName: string;
};

type UncheckedRecord = Record<string, any>;

type ActiveSessionListItem = {
  id?: string;
  playerId?: string;
  playerDisplayName?: string;
  startedAt?: string;
  label?: string | null;
  identities?: Array<{ provider: string; subject: string }>;
};

type ActivePlayer = {
  playerId: string;
  sessions: ActiveSessionListItem[];
  displayName?: string;
};

type PlayerGroups = {
  groups: Array<{ label: string; table?: MahjongTableConfig; players: ActivePlayer[] }>;
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

  const wrap = (
    handler: (context: KoishiActionContext, ...args: string[]) => Promise<string> | string,
  ) => async (context: KoishiActionContext, ...args: string[]): Promise<string> => {
    try {
      const message = await handler(context, ...args);
      return context.session?.messageId ? `${h("quote", { id: context.session.messageId })}${message}` : message;
    } catch (error) {
      const message = service.handleCommandError(error);
      return context.session?.messageId ? `${h("quote", { id: context.session.messageId })}${message}` : message;
    }
  };

  const bind = wrap(async (context, code) => service.bind(await service.sender(context), code));
  ctx.command("bind <code:string>", "绑定网页登录账号到当前平台身份").action(bind);
  // Instructions already handed to players may still say prism.bind.
  ctx.command("prism.bind <code:string>", "绑定网页登录账号到当前平台身份（旧命令，同 bind）").action(bind);

  // In read-only mode a player may look things up and redeem, but anything that
  // starts billing, settles a bill or drives a device is left to staff.
  const effect = (
    handler: (context: KoishiActionContext, ...args: string[]) => Promise<string> | string,
  ) => wrap(async (context, ...args) => {
    if (config.playerCommands === "readonly" && !matchesPlatformIdentity(config.staffUserIds ?? [], await service.sender(context))) {
      return config.readOnlyNotice || "请扫描设备上的二维码或碰 NFC，在网页或 App Clip 里操作";
    }
    return handler(context, ...args);
  });

  ctx.command("login [target:user]", "开启玩家计费场次").action(effect(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  ));

  ctx.command("入场 [target:user]", "入场").action(effect(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  ));

  ctx.command("mahjong <tableId>", "加入指定麻将桌").action(effect(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("上桌 [tableId]", "加入指定麻将桌").action(effect(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("下桌", "离开当前所在麻将桌").action(effect(async (context) =>
    service.mahjongLeave(await service.sender(context)),
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

  ctx.command("versions", "查看 Bot 与 PRiSM 后端版本").action(wrap(async () =>
    service.versions(),
  ));

  ctx.command("items [target:user]", "查看玩家资产").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.items(sender), context.session?.bot),
  ));

  ctx.command("list", "查看当前在线玩家列表").action(wrap(async (context) =>
    service.listActiveSessions(await service.sender(context)),
  ));

  ctx.command("show [deviceId]", "查看设备电源状态").action(wrap(async (context, deviceId) =>
    service.listDeviceStates(deviceId),
  ));

  ctx.command("history [target:user]", "查看玩家历史").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.history(sender), context.session?.bot),
  ));

  ctx.command("lock", "向默认门锁设备发送开门指令").action(effect(async (context) =>
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
  private readonly pongWaiters: Array<() => void> = [];

  constructor(
    private readonly open: SocketFactory,
    private readonly url: string,
    private readonly token: string,
    private readonly hello: Record<string, unknown>,
    private readonly onEvent: (event: PlatformEvent) => void,
    private readonly logger?: { warn(...args: unknown[]): void },
  ) {}

  start(): void {
    this.stopped = false;
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
      socket = this.open(this.url, { Authorization: `Bearer ${this.token}` });
    } catch (error) {
      this.logger?.warn("PRiSM connection failed", error);
      this.reconnectLater();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retryMs = FIRST_RETRY_MS;
      this.lastHeard = Date.now();
      socket.send(JSON.stringify({ type: "hello", ...this.hello }));
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
      this.reconnectLater();
    });
    socket.addEventListener("error", (error) => this.logger?.warn("PRiSM connection error", error?.message ?? error));
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

/** The platform connection URL for a shop. */
export function platformSocketUrl(baseUrl: string, shopCode: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/api/v1/shops/${encodeURIComponent(shopCode)}/integration/ws`;
}

/* ----------------------------- api client ---------------------------------- */

class PrismApiClient {
  constructor(
    private readonly socket: PrismSocket,
    private readonly http?: { post: HttpPost; baseUrl: string; shopCode: string; token: string },
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
      ...(identity.autoRegister === undefined ? {} : { autoRegister: identity.autoRegister }),
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    };
  }

  async resolveOrRegisterIdentity(identity: any) {
    const endpoint = identity.autoRegister
      ? "/rpc/integration/players/by-identity/register"
      : "/rpc/integration/players/by-identity/resolve";
    const result = await this.request("POST", endpoint, {
      body: this.identityBody(identity),
    });
    return result.player;
  }

  async getVersion() {
    return this.request("GET", "version", {});
  }

  async startSessionByIdentity(identity: any, body?: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/session/start", {
      body: {
        ...this.identityBody(identity),
        ...(body ?? {}),
      },
    });
  }

  async stopSessionByIdentity(identity: any, sessionId: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/sessions/:sessionId/stop", {
      params: { sessionId },
      body: this.identityBody(identity),
    });
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

  async adjustAssetsByIdentity(identity: any, adjustments: unknown[]) {
    return this.request("POST", "/rpc/integration/players/by-identity/assets/adjustments", {
      body: { ...this.identityBody(identity), adjustments },
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

class PrismKoishiService {
  private readonly mahjongTables = new Map<string, MahjongTableState>();
  private readonly logoutInFlight = new Map<string, Promise<string>>();
  private readonly client: any;
  private readonly logger?: { warn(...args: unknown[]): void };

  private readonly socket: PrismSocket | null = null;

  constructor(private readonly ctx: KoishiLikeContext, private readonly config: PrismKoishiPluginConfig) {
    this.logger = ctx.logger?.("prism");
    if (config.client) {
      this.client = config.client;
      return;
    }
    if (!config.shopCode || !config.baseUrl || !config.integrationToken) {
      throw new Error("PRiSM Koishi plugin requires 'shopCode', 'baseUrl' and 'integrationToken'.");
    }
    const open: SocketFactory = config.socket ?? ((url, headers) => {
      const http = (ctx as any).http;
      if (!http?.ws) throw new Error("Koishi http service with WebSocket support is required.");
      return http.ws(url, { headers });
    });
    const lead = Math.max(0, config.idleReminderMinutes ?? 5);
    this.socket = new PrismSocket(
      open,
      platformSocketUrl(config.baseUrl, config.shopCode),
      config.integrationToken,
      // Without anywhere to send it, the platform need not plan a reminder.
      lead > 0 && (config.idleNotifyChannelIds ?? []).length ? { reminderLeadSeconds: lead * 60 } : {},
      (event) => {
        if (event.event === "idle.reminder") void this.remindIdle(event.data as IdleReminder);
      },
      this.logger,
    );
    const post: HttpPost = config.httpPost ?? (async (url, headers, body) => {
      const http = (ctx as any).http;
      if (typeof http !== "function") throw new PrismBotClientError("HTTP 测速需要 Koishi 的 http 服务", "HTTP_UNAVAILABLE", 0, {});
      const response = await http(url, {
        method: "POST", headers, data: body, keepAlive: true, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
      });
      return { status: response.status, headers: response.headers, data: response.data };
    });
    this.client = new PrismApiClient(this.socket, { post, baseUrl: config.baseUrl, shopCode: config.shopCode, token: config.integrationToken });
    this.socket.start();
  }

  dispose(): void {
    this.socket?.stop();
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

  /** Tell the configured channels a power-off is coming. Short: they can read a device name. */
  async remindIdle(reminder: IdleReminder): Promise<void> {
    const channels = this.config.idleNotifyChannelIds ?? [];
    if (!channels.length || typeof this.ctx.broadcast !== "function") return;
    const now = (this.config.now?.() ?? new Date()).getTime();
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

  async register(sender: Sender): Promise<string> {
    await this.client.resolveOrRegisterIdentity(this.identity(sender));
    return "注册成功";
  }

  async loginForTarget(actor: Sender, targetSubject?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender, isTargeted) => {
      await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
      return isTargeted ? `✅ 已为用户 ${formatPlayerReference(sender)} 入场成功` : "✅ 入场成功";
    }, bot);
  }

  async login(sender: Sender): Promise<string> {
    await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
    return "✅ 入场成功";
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
      return `✅ 已为用户 ${formatPlayerReference(sender)}${isAddition ? "增加" : "扣除"} ${formatNumber(amount)} ${this.config.currencyName}`;
    }, bot);
  }

  async overwriteTargetCheckout(actor: Sender, targetSubject: string, rawAmount: string, rawReason?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender) => {
      const total = Number(rawAmount);
      if (!Number.isFinite(total) || total < 0) return "金额必须为非负数";
      const reason = cleanText(rawReason) || "管理员调价";
      const result = (await this.client.checkoutWithOverrideByIdentity(this.identity(sender), total, reason)) as UncheckedRecord;
      const playerId = String(result.playerSettlement.playerId);
      if (playerId) this.removeMahjongPlayer(playerId);
      return this.formatAndNotifyCheckout(result, sender, "✅ 覆盖结账成功 · 结算账单", bot);
    }, bot);
  }

  async mahjongJoin(sender: Sender, rawTableId: string): Promise<string> {
    const tableId = cleanText(rawTableId);
    if (!tableId) return "请指定麻将桌，例如 /上桌 a；可先使用 /麻将列表 查看可用桌位。";
    const tableConfig = this.mahjongTableConfigs().get(tableId);
    if (!tableConfig) return `未找到麻将桌「${tableId}」。可先使用 /麻将列表 查看可用桌位。`;
    const tableKey = tableConfig.tableId;
    const tableSubject = tableConfig.displayName || `${tableKey} 桌`;

    const player = await this.resolvePlayer(sender);
    const playerId = String(player.id ?? "");
    const activeResult = (await this.client.listActiveSessions()) as UncheckedRecord;
    const activeSessions = (activeResult.sessions ?? []) as ActiveSessionListItem[];
    this.syncMahjongTableStates(activeSessions);
    if (!this.hasEntrySession(playerId, activeSessions)) {
      return "请先入场后再上桌。";
    }
    const existing = this.mahjongTableForPlayer(playerId);
    if (existing) return `你已经在 ${existing}，无需重复上桌。`;

    const state = this.mahjongTables.get(tableKey) ?? { waiting: [], activeSessions: {} };
    this.mahjongTables.set(tableKey, state);
    const activeCount = Object.keys(state.activeSessions).length;
    const tableSize = this.config.mahjongTableSize ?? 4;
    if (activeCount >= tableSize) {
      return `「${tableSubject}」正在游玩中（${activeCount}/${tableSize}），请等待本局结束后再上桌。`;
    }

    if (activeCount > 0) {
      const label = tableConfig.displayName;
      const result = (await this.client.startSessionByIdentity(this.identity(sender), {
        pricingConfigIds: tableConfig.pricingConfigIds,
        label,
        entry: false,
      })) as UncheckedRecord;
      const session = (result?.session ?? {}) as UncheckedRecord;
      const sessionId = String(session.id ?? "");
      if (sessionId) {
        state.activeSessions[playerId] = sessionId;
      }
      return `已加入 ${tableSubject}，补位成功，麻将计费已开始。当前 ${activeCount + 1}/${tableSize} 人。`;
    }

    state.waiting.push({
      playerId,
      senderId: sender.id,
      displayName: sender.name || playerId,
      identity: this.identity(sender),
    });

    if (state.waiting.length < tableSize) {
      return `已加入 ${tableSubject}，当前 ${state.waiting.length}/${tableSize} 人。`;
    }

    const seats = state.waiting.slice(0, tableSize);
    state.waiting = state.waiting.slice(tableSize);
    const label = tableConfig.displayName;
    for (const seat of seats) {
      const result = (await this.client.startSessionByIdentity(seat.identity, {
        pricingConfigIds: tableConfig.pricingConfigIds,
        label,
        entry: false,
      })) as UncheckedRecord;
      const session = (result?.session ?? {}) as UncheckedRecord;
      const sessionId = String(session.id ?? "");
      if (sessionId) state.activeSessions[seat.playerId] = sessionId;
    }
    return `${tableSubject}已满，麻将计费已开始。`;
  }

  async mahjongLeave(sender: Sender): Promise<string> {
    const activeResult = (await this.client.listActiveSessions()) as UncheckedRecord;
    this.syncMahjongTableStates((activeResult.sessions ?? []) as ActiveSessionListItem[]);
    const player = await this.resolvePlayer(sender);
    const playerId = String(player.id ?? "");
    const tableKey = this.mahjongTableForPlayer(playerId);
    if (!tableKey) return "你当前未在任何麻将桌上。";
    const tableConfig = uniqueMahjongConfigs(this.mahjongTableConfigs()).find((table) => table.tableId === tableKey);
    const tableSubject = tableConfig?.displayName || tableKey;
    const state = this.mahjongTables.get(tableKey);
    if (!state) return "你当前未在任何麻将桌上。";
    const waitingBefore = state.waiting.length;
    state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
    if (state.waiting.length !== waitingBefore) {
      return `已离开 ${tableSubject}，当前 ${state.waiting.length}/${this.config.mahjongTableSize ?? 4} 人。`;
    }

    const sessionId = state.activeSessions[playerId];
    if (!sessionId) return "你当前未在任何麻将桌上。";
    // Do not show an available seat while the backend session is still running.
    // Failed stop requests must preserve the table state for safe retry.
    await this.client.stopSessionByIdentity(this.identity(sender), sessionId);
    delete state.activeSessions[playerId];
    const remainingCount = Object.keys(state.activeSessions).length;
    const tableSize = this.config.mahjongTableSize ?? 4;
    return `已离开 ${tableSubject}，麻将计费已停止。当前还剩 ${remainingCount}/${tableSize} 人。`;
  }

  async listMahjongTables(): Promise<string> {
    const activeResult = (await this.client.listActiveSessions()) as UncheckedRecord;
    this.syncMahjongTableStates((activeResult.sessions ?? []) as ActiveSessionListItem[]);
    const tableSize = this.config.mahjongTableSize ?? 4;
    const tables = uniqueMahjongConfigs(this.mahjongTableConfigs());
    if (tables.length === 0) return "当前没有配置任何麻将机。";
    const lines = [`🀄️ 麻将机列表（${tables.length} 台）`];
    for (const table of tables) {
      const state = this.mahjongTables.get(table.tableId) ?? { waiting: [], activeSessions: {} };
      const activeCount = Object.keys(state.activeSessions).length;
      const waitingCount = state.waiting.length;
      const statuses = [
        ...(activeCount > 0 ? [`游玩中 ${activeCount}/${tableSize}`] : []),
        ...(waitingCount > 0 ? [`等位 ${waitingCount}/${tableSize}`] : []),
      ];
      lines.push(`- ${table.displayName}｜别名：${table.aliases.length > 0 ? table.aliases.join("、") : "无"}｜${statuses.join("；") || "空闲"}`);
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
    const playerId = String(result.playerSettlement.playerId);
    if (playerId) this.removeMahjongPlayer(playerId);
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
    const recipients = [...new Set([...(this.config.staffUserIds ?? []), ...(this.config.logoutNotifyUserIds ?? [])])];
    const channelIds = recipients.flatMap(identity => {
      if (identity.startsWith(`${sender.provider}:`)) return [`private:${identity.slice(sender.provider.length+1)}`];
      if (sender.provider === "onebot" && (!identity.includes(":") || identity.startsWith("private:")))
        return [identity.startsWith("private:") ? identity : `private:${identity}`];
      return [];
    });
    if (channelIds.length > 0 && bot?.broadcast) await bot.broadcast(channelIds,receipt);
    return receipt;
  }

  async wallet(sender: Sender): Promise<string> {
    const result = (await this.client.getWalletByIdentity(this.identity(sender))) as UncheckedRecord;
    return formatWallet(result.wallet as UncheckedRecord[], this.config.currencyName);
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
    return formatHistory(result.sessions as UncheckedRecord[], this.config.currencyName);
  }

  async lock(sender: Sender): Promise<string> {
    try {
      const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
        type: "door.open",
        target: { kind: "facility", ref: this.config.defaultDoorDeviceId },
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
        provider: this.config.defaultScanProvider || "aime",
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

  async listActiveSessions(sender: Sender): Promise<string> {
    const result = (await this.client.listActiveSessions()) as UncheckedRecord;
    const sessions = (result?.sessions ?? []) as ActiveSessionListItem[];
    this.syncMahjongTableStates(sessions);

    const tableByLabel = new Map(
      uniqueMahjongConfigs(this.mahjongTableConfigs()).map((table) => [
        mahjongSessionLabel(table),
        table,
      ]),
    );
    const players = groupSessionsByPlayer(sessions);
    const groups = await this.buildPlayerGroups(players, tableByLabel, sender.provider);
    this.mergeWaitingSeats(groups);
    const tables = result.mahjongTables as {id:string;name:string;capacity:number;players:{id:string;name:string}[]}[] | undefined;
    if (!tables) return formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4);
    const seated = new Set(tables.flatMap(table => table.players.map(player => player.id)));
    for (const group of groups.groups) group.players = group.players.filter(player => !seated.has(player.playerId));
    return [
      formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4, new Set([
        ...seated, ...groups.groups.flatMap(group => group.players.map(player => player.playerId)),
      ]).size),
      ...tables.map(table => `
${table.name}（${table.players.length}/${table.capacity}）：
${table.players.map(player => player.name).join("、")}`),
    ].filter(Boolean).join("\n");

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
    const staffOverride = state === "off" && this.config.powerCommandsAdminOnly === true;
    if (staffOverride && !matchesPlatformIdentity(this.config.staffUserIds ?? [],sender)) {
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

  private getCommandFailureMessage(result: any): string | null {
    const action = result?.action;
    if (action?.status === "expired" || action?.status === "rejected") {
      return action.payload?.executorFailure?.message || "命令执行被拒绝或超时";
    }
    return null;
  }

  private async resolvePlatformName(subject: string, provider: string): Promise<string | null> {
    if (!this.config.resolveDisplayName) return null;
    try {
      return (await this.config.resolveDisplayName(subject, provider)) ?? null;
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

  private async buildPlayerGroups(
    players: Map<string, ActivePlayer>,
    tableByLabel: Map<string, MahjongTableConfig>,
    provider: string,
  ): Promise<PlayerGroups> {
    const groups: PlayerGroups = { groups: [] };
    const groupByLabel = new Map<string, PlayerGroups["groups"][number]>();
    const musicLabel = this.config.loginSessionLabel?.trim() || "音游区间";

    for (const player of players.values()) {
      player.displayName = await this.displayNameForPlayer(player, provider);
      const nonMusic = player.sessions.filter((session) => Boolean(session.label) && session.label !== "entry" && session.label !== musicLabel);
      const source = nonMusic.length > 0 ? nonMusic : player.sessions;
      const selected = source.reduce((latest, session) =>
        !latest || sessionStartedAt(session) > sessionStartedAt(latest) ? session : latest,
        undefined as ActiveSessionListItem | undefined);
      const label = selected?.label === "entry" ? musicLabel : selected?.label || musicLabel;
      let group = groupByLabel.get(label);
      if (!group) {
        group = { label, table: tableByLabel.get(label), players: [] };
        groupByLabel.set(label, group);
        groups.groups.push(group);
      }
      group.players.push(player);
    }
    return groups;
  }

  private mergeWaitingSeats(groups: PlayerGroups): void {
    for (const [tableId, state] of this.mahjongTables) {
      const table = uniqueMahjongConfigs(this.mahjongTableConfigs()).find((candidate) => candidate.tableId === tableId);
      if (!table) continue;
      const label = mahjongSessionLabel(table);
      let group = groups.groups.find((candidate) => candidate.label === label);
      if (!group) {
        group = { label, table, players: [] };
        groups.groups.push(group);
      }
      for (const seat of state.waiting) {
        if (group.players.some((player) => player.playerId === seat.playerId)) continue;
        const existing = groups.groups.flatMap((candidate) => candidate.players)
          .find((player) => player.playerId === seat.playerId);
        for (const candidate of groups.groups) {
          if (candidate !== group) candidate.players = candidate.players.filter((player) => player.playerId !== seat.playerId);
        }
        group.players.push(existing ?? { playerId: seat.playerId, sessions: [], displayName: seat.displayName });
      }
    }
  }

  private async resolvePlayerDisplay(sender: Sender | null, playerId?: string): Promise<string> {
    if (!sender) return playerId || "未知玩家";
    const platformName = await this.resolvePlatformName(sender.id, sender.provider);
    const name = platformName
      || (sender.name && sender.name !== sender.id ? sender.name : "")
      || "未知昵称";
    return `玩家：${name}（${sender.provider}:${sender.id}）`;
  }


  private mahjongTableForPlayer(playerId: string): string | null {
    for (const [tableId, state] of this.mahjongTables) {
      if (state.activeSessions[playerId]) return tableId;
      if (state.waiting.some((seat) => seat.playerId === playerId)) return tableId;
    }
    return null;
  }

  private removeMahjongPlayer(playerId: string): void {
    for (const state of this.mahjongTables.values()) {
      delete state.activeSessions[playerId];
      state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
    }
  }

  private mahjongTableConfigs(): Map<string, MahjongTableConfig> {
    return resolveMahjongTableConfigs(this.config.mahjongTableConfigs ?? []);
  }

  private syncMahjongTableStates(sessions: readonly ActiveSessionListItem[]): void {
    const tables = uniqueMahjongConfigs(this.mahjongTableConfigs());
    const tableByLabel = new Map(tables.map((table) => [
      mahjongSessionLabel(table),
      table,
    ]));
    // All playerIds that still have at least one active session in the backend.
    // Used to evict waiting seats for players who have fully checked out externally.
    const allActivePlayerIds = new Set(
      sessions.map((s) => String(s.playerId ?? "")).filter(Boolean),
    );
    const activeByTable = new Map<string, Record<string, string>>();
    for (const session of sessions) {
      const table = tableByLabel.get(session.label ?? "");
      const playerId = String(session.playerId ?? "");
      const sessionId = String(session.id ?? "");
      if (!table || !playerId || !sessionId) continue;
      const active = activeByTable.get(table.tableId) ?? {};
      active[playerId] = sessionId;
      activeByTable.set(table.tableId, active);
    }
    for (const table of tables) {
      const state = this.mahjongTables.get(table.tableId) ?? { waiting: [], activeSessions: {} };
      state.activeSessions = activeByTable.get(table.tableId) ?? {};
      // Remove seats that have been promoted to active, or whose players have
      // fully left the backend (no entry session remaining — orphan eviction).
      state.waiting = state.waiting.filter(
        (seat) => !state.activeSessions[seat.playerId] && allActivePlayerIds.has(seat.playerId),
      );
      if (state.waiting.length > 0 || Object.keys(state.activeSessions).length > 0 || this.mahjongTables.has(table.tableId)) {
        this.mahjongTables.set(table.tableId, state);
      }
    }
  }

  private async resolvePlayer(sender: Sender): Promise<UncheckedRecord> {
    return (await this.client.resolveOrRegisterIdentity(this.identity(sender))) as UncheckedRecord;
  }

  private hasEntrySession(playerId: string, sessions: readonly ActiveSessionListItem[]): boolean {
    const label = this.config.loginSessionLabel?.trim();
    return sessions.some((session) =>
      session.playerId === playerId && (session.label === "entry" || (label ? session.label === label : true)),
    );
  }

  private identity(sender: Sender): IdentityInput {
    return {
      provider: sender.provider,
      subject: sender.id,
      autoRegister: this.config.autoRegister,
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
    const denied = this.targetStaffDenied(actor);
    if (denied) return denied;
    try {
      const user = await bot?.getUser?.(subject);
      return { id: subject, name: user?.name || subject, provider };
    } catch {
      return { id: subject, name: subject, provider };
    }
  }

  private loginSessionBody(): { pricingConfigIds?: string[]; label?: string; entry: true } {
    const pricingConfigIds = (this.config.loginPricingConfigIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    const label = this.config.loginSessionLabel?.trim();
    return {
      entry: true,
      ...(pricingConfigIds.length === 0 ? {} : { pricingConfigIds }),
      ...(label ? { label } : {}),
    };
  }

  private staffDenied(sender: Sender): string | null {
    if (!this.config.enableStaffCommands) return "员工命令未启用";
    const allowed = this.config.staffUserIds ?? [];
    if (allowed.length > 0 && !matchesPlatformIdentity(allowed,sender)) return "权限不足";
    return null;
  }

  private targetStaffDenied(sender: Sender): string | null {
    if (!this.config.enableStaffCommands) return "员工命令未启用";
    const allowed = this.config.staffUserIds ?? [];
    if (!matchesPlatformIdentity(allowed,sender)) return "权限不足";
    return null;
  }

  private async formatCheckoutPreview(
    result: UncheckedRecord,
    sender: Sender | null,
    title = "【结算账单】",
    isPreview: boolean,
  ): Promise<string> {
    const currency = this.config.currencyName;
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
      const overallEnd = validEnds.length > 0 ? validEnds.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : now(this.config).toISOString();
      const offsets = [...new Set([apiOffsetLabel(overallStart), apiOffsetLabel(overallEnd)])].join(" / ");
      lines.push(`⏰ 游玩时间：${formatHM(overallStart)}–${formatHM(overallEnd)}（${offsets}）`);
    }

    for (const sPrev of sessionPreviews) {
      const label = sPrev?.label === "entry" ? this.config.loginSessionLabel?.trim() || "音游区间" : sPrev?.label || "计时区间";
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
      if (error.code?.startsWith("LOCATION_") && this.config.shopCode && this.config.baseUrl) {
        return `请在网页完成到店校验：${this.config.baseUrl.replace(/\/+$/, "")}/t/${encodeURIComponent(this.config.shopCode)}`;
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
  if (error.code === "DUPLICATE_SESSION_LABEL") {
    return "❌ 您已经处于入场状态，请勿重复发送入场命令。";
  }
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
    return "请稍后再试";
  }
  return "请稍后再试";
}

function deviceActionFailureReason(error: unknown): string {
  if (!(error instanceof PrismBotClientError)) return "请稍后再试";
  if (error.code === "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION") return "玩家未入场";
  if (error.code === "DEVICE_NOT_FOUND") return "设备不存在";
  if (error.code === "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER") return "玩家未绑定 Aime 卡";
  if (error.code === "COIN_COMMAND_COOLDOWN_ACTIVE") return "投币冷却中，请稍后再试";
  return "请稍后再试";
}

function deviceCommandFailureReason(result: unknown): string | null {
  const action = (result as UncheckedRecord)?.action as UncheckedRecord | undefined;
  if (!action || (action.status !== "expired" && action.status !== "rejected")) return null;
  const message = cleanText(action.payload?.executorFailure?.message);
  if (message.includes("没有在线客户端")) return "设备未连接";
  if (message.includes("设备配置不存在")) return "设备未配置";
  return "请稍后再试";
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

export function resolveMahjongTableConfigs(
  structured: readonly MahjongTableConfigInput[],
): Map<string, MahjongTableConfig> {
  const tables = new Map<string, MahjongTableConfig>();
  for (const input of structured) {
    const displayName = cleanText(input.displayName);
    const tableId = displayName;
    const aliases = [...new Set((input.aliases ?? []).map(cleanText).filter(Boolean))];
    const pricingConfigIds = (input.pricingConfigIds ?? []).map(cleanText).filter(Boolean);
    if (!tableId || !displayName || pricingConfigIds.length === 0) continue;
    const table: MahjongTableConfig = { tableId, displayName, aliases, pricingConfigIds };
    for (const alias of aliases) tables.set(alias, table);
  }
  return tables;
}

function uniqueMahjongConfigs(tables: Map<string, MahjongTableConfig>): MahjongTableConfig[] {
  return [...new Map([...tables.values()].map((table) => [table.tableId, table])).values()];
}

function mahjongSessionLabel(table: MahjongTableConfig): string {
  return table.displayName;
}

function groupSessionsByPlayer(sessions: readonly ActiveSessionListItem[]): Map<string, ActivePlayer> {
  const players = new Map<string, ActivePlayer>();
  for (const session of sessions) {
    const playerId = session.playerId || findSubjectForSession(session, "") || "";
    if (!playerId) continue;
    const player = players.get(playerId) ?? { playerId, sessions: [] };
    player.sessions.push(session);
    players.set(playerId, player);
  }
  return players;
}

function sessionStartedAt(session: ActiveSessionListItem): number {
  const value = Date.parse(session.startedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function formatPlayerGroups(groups: PlayerGroups, tableSize: number, totalPlayers?: number): string {
  const populatedGroups = groups.groups.filter((group) => group.players.length > 0);
  const total = totalPlayers ?? new Set(populatedGroups.flatMap((group) => group.players.map((player) => player.playerId))).size;
  if (total === 0) return "🫥 窝里目前没有玩家呢";

  const lines = [`[总计 ${total} 人]`];
  for (const group of populatedGroups) {
    const heading = group.table
      ? `${group.table.displayName} ( ${group.players.length}/${tableSize} )`
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

function matchesPlatformIdentity(identities: string[], sender: Sender): boolean {
  return identities.includes(`${sender.provider}:${sender.id}`)
    // Legacy unqualified staff lists belong to the original adapter only.
    || (sender.provider === "onebot" && identities.includes(sender.id));
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

function minDate(dates: Date[]): Date {
  return dates.reduce((acc, d) => (d.getTime() < acc.getTime() ? d : acc), dates[0]);
}

function maxDate(dates: Date[]): Date {
  return dates.reduce((acc, d) => (d.getTime() > acc.getTime() ? d : acc), dates[0]);
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
