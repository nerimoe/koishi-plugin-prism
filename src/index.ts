import { HaWatcher, parseWatch, type HaWatch } from "./ha-watch.js";
import { h, Schema } from "koishi";
import packageMetadata from "../package.json";

export { HaWatcher } from "./ha-watch.js";
export type { HaWatch } from "./ha-watch.js";

export const name = "prism";
export const version = packageMetadata.version;

// Only how to reach the shop is configured here. What the commands do, who may
// use them and what the bot says are the platform's: the bot's settings live
// on its resource page in PRiSM.
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
  ) {
    super(message);
    this.name = "PrismBotClientError";
  }
}

export type PrismKoishiPluginConfig = {
  /**
   * How the chat names a player: an adapter subject and provider to a nickname
   * (e.g. from the current group's member list). Without it, the platform's
   * display name is used.
   */
  resolveDisplayName?: (subject: string, provider: string) => Promise<string | null | undefined> | string | null | undefined;
  shopCode?: string;
  baseUrl?: string;
  integrationToken?: string;
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

export type KoishiCommandBuilder = {
  action(handler: (context: KoishiActionContext, ...args: any[]) => Promise<string> | string): KoishiCommandBuilder;
};

export type KoishiLikeContext = {
  command(name: string, description: string): KoishiCommandBuilder;
  logger?(name: string): { warn(...args: unknown[]): void };
  bots?: Array<{
    platform: string;
    isActive: boolean;
    sendMessage(channelId: string, content: string): Promise<unknown>;
    sendPrivateMessage(userId: string, content: string): Promise<unknown>;
  }>;
  on?(event: "dispose", listener: () => void): void;
};

export type KoishiActionContext = {
  session: {
    platform?: string;
    isDirect?: boolean;
    userId: string;
    channelId?: string;
    messageId?: string;
    senderName?: string;
    username?: string;
    bot?: {
      platform?: string;
      getUser?(id: string): Promise<{ name?: string }>;
      /** Send to this bot's channels by id; `private:<user>` for a private chat. */
      broadcast?(channels: string[], content: string): Promise<unknown>;
    };
  };
};

/**
 * Every command the platform runs, as Koishi registers it. The command's name
 * is its first word; a `target:user` argument names whom it is for and is
 * sent apart from the rest. What each does is `resources/bot-commands.ts` in
 * PRiSM.
 */
const COMMANDS: Array<[declaration: string, description: string]> = [
  ["bind <code:string>", "绑定网页登录账号到当前平台身份"],
  // Instructions already handed to players may still say prism.bind.
  ["prism.bind <code:string>", "绑定网页登录账号到当前平台身份（旧命令，同 bind）"],
  ["login [target:user]", "开启玩家计费场次"],
  ["入场 [target:user]", "入场"],
  ["mahjong <tableId> [target:user]", "加入指定麻将桌"],
  ["上桌 [tableId] [target:user]", "加入指定麻将桌"],
  ["下桌 [tableId] [target:user]", "离开当前所在麻将桌"],
  ["麻将列表", "查看麻将机状态与别名"],
  ["logout [target:user]", "结算玩家计费场次"],
  ["billing [target:user]", "预览玩家结账费用"],
  ["wallet [target:user]", "查看玩家钱包"],
  ["items [target:user]", "查看玩家资产"],
  ["list [name:text]", "查看在店玩家，或某个资源、某个计费方案上的玩家"],
  ["show [deviceId]", "查看设备电源状态"],
  ["history [target:user]", "查看玩家历史"],
  ["lock", "向本店门锁发送开门指令"],
  ["on <deviceRef>", "请求启动指定设备电源"],
  ["off <deviceRef>", "请求关闭指定设备电源"],
  ["keep <deviceRef>", "延迟闲置设备的自动关机"],
  ["coin <deviceRef> [count]", "请求向指定设备投币"],
  ["scan <deviceRef>", "使用当前玩家绑定的 Aime 卡刷卡"],
  ["redeem <code>", "兑换 PRiSM 礼物码"],
  ["add <target:user> <amount:number>", "增加玩家余额"],
  ["del <target:user> <amount:number>", "扣除玩家余额"],
  ["overwrite <target:user> <amount:number> [reason:text]", "覆盖结账金额并立即结账"],
];

export function applyPrismKoishiPlugin(ctx: KoishiLikeContext, config: PrismKoishiPluginConfig): void {
  const service = new PrismKoishiService(ctx, config);
  const quoted = (context: KoishiActionContext, message: string) =>
    context.session?.messageId ? `${h("quote", { id: context.session.messageId })}${message}` : message;

  for (const [declaration, description] of COMMANDS) {
    const [name, ...params] = declaration.split(" ");
    const targetAt = params.findIndex((param) => param.includes(":user"));
    ctx.command(declaration, description).action(async (context, ...args) =>
      quoted(context, await service.run(name!, context, args, targetAt)));
  }

  ctx.command("api测速 [count:number]", "测试 Bot 走 HTTP 到 PRiSM 的延迟").action(async (context, count) =>
    quoted(context, await service.benchmarkApi(context, count)));
  ctx.command("ws测速 [count:number]", "测试 Bot 走 WebSocket 到 PRiSM 的延迟").action(async (context, count) =>
    quoted(context, await service.benchmarkWs(context, count)));
  // The Bot's own version stays visible while the platform is out of reach.
  ctx.command("versions", "查看 Bot 与 PRiSM 后端版本").action(async (context) =>
    quoted(context, await service.versions()));

  ctx.on?.("dispose", () => service.dispose());
}

/* --------------------------- platform connection --------------------------- */

const SOCKET_OPEN = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const PING_MS = 30_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

const UNREACHABLE = "操作失败，暂时连不上服务器。";
const TIMED_OUT = "服务器没有及时回应，请稍后确认结果";

/** A player as the platform names one in what it says. */
type MessagePlayer = { playerId: string; displayName: string | null; identities: Array<{ provider: string; subject: string }> };

/**
 * What the platform writes for a bot to say (PRiSM's core `bot-message.ts`):
 * text, and players the bot names as its chat knows them. A segment of a kind
 * this version does not know is said by its `text`, if it has one.
 */
type BotMessage = Array<{ text?: string; player?: MessagePlayer }>;

/** `say`: something to say, the answer to a command (`replyTo`) or the shop's news. */
export type SayFrame = { type: "say"; message: BotMessage; replyTo?: string; to?: string; done?: boolean };

type ChatIdentity = { provider: string; subject: string; name?: string };

/** A player's command as the platform runs it. */
type CommandFrame = { name: string; args: string[]; from: ChatIdentity; target?: ChatIdentity; channel: string };

type SocketReply = { status: number; body: any; serverMs?: number | null };

/**
 * The one connection to PRiSM. Commands go out as `command` frames and the
 * platform answers with `say` frames naming them; the shop's news comes as
 * `say` frames naming none. While it is down a command fails at once:
 * queueing a checkout or a top-up to run later would make players repeat it.
 */
export class PrismSocket {
  private socket: SocketLike | null = null;
  private readonly pending = new Map<string, { resolve(value: SocketReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** Commands still being answered, by id. */
  private readonly listening = new Map<string, (say: SayFrame | null) => void>();
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
    /** What to say in hello besides that this bot sends commands. */
    private readonly hello: () => Record<string, unknown>,
    /** The shop's news: something to say that answers no command. */
    private readonly onNews: (say: SayFrame) => void,
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
      this.lastHeard = Date.now();
      this.retryMs = FIRST_RETRY_MS;
      this.greet();
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

  /** Hello: on connecting, and again when the platform says the bot's settings changed, so it rereads them. */
  private greet(): void {
    this.send({ type: "hello", commands: 1, ...this.hello() });
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
    for (const [, onSay] of this.listening) onSay(null);
    this.listening.clear();
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
    if (frame?.type === "say" && Array.isArray(frame.message)) {
      const say = frame as SayFrame;
      if (typeof say.replyTo !== "string") {
        this.onNews(say);
        return;
      }
      const onSay = this.listening.get(say.replyTo);
      if (!onSay) return;
      if (say.done) this.listening.delete(say.replyTo);
      onSay(say);
    } else if (frame?.type === "response" && typeof frame.id === "string") {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: Number(frame.status) || 500, body: frame.body, serverMs: typeof frame.serverMs === "number" ? frame.serverMs : null });
    } else if (frame?.type === "config.changed") {
      // The bot's settings changed: hello again, so the platform rereads what this bot announces.
      this.greet();
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

  private nextId(): string {
    return `${Date.now().toString(36)}-${(this.sequence++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Send a command; `onSay` hears each thing the platform says for it, or
   * null once the connection is gone. False while the connection is down.
   */
  command(frame: CommandFrame, onSay: (say: SayFrame | null) => void): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    const id = this.nextId();
    this.listening.set(id, onSay);
    try {
      socket.send(JSON.stringify({ type: "command", id, ...frame }));
    } catch {
      this.listening.delete(id);
      return false;
    }
    // Words that never come are not waited for forever.
    setTimeout(() => this.listening.delete(id), REQUEST_TIMEOUT_MS * 2);
    return true;
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

  /** A platform route over the connection: the version and the speed tests, which measure exactly that. */
  request(frame: { method: "GET" | "POST"; path: string; body?: unknown }): Promise<SocketReply> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return Promise.reject(unreachable());
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrismBotClientError(TIMED_OUT, "API_TIMEOUT", 0, {}));
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

const data = (body: any) => (body && typeof body === "object" && Object.hasOwn(body, "data") ? body.data : body);

/**
 * The platform connection URL. The credential names the shop, as a device's
 * token names its machine at `/io/ws`, so nothing identifying is in the path.
 */
export function platformSocketUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/integration/ws`;
}

/* ------------------------------- service ----------------------------------- */

class PrismKoishiService {
  private readonly logger?: { warn(...args: unknown[]): void };
  private readonly socket: PrismSocket;
  private readonly watcher: HaWatcher | null = null;
  private readonly post: HttpPost;
  /** The shop's code, for the HTTP speed test; read from the platform when first needed. */
  private shopCode: string | null;
  /** News still being said; each waits for the one before, so channels read it in order. */
  private announcing: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: KoishiLikeContext, private readonly options: PrismKoishiPluginConfig) {
    this.logger = ctx.logger?.("prism");
    if (!options.baseUrl || !options.integrationToken) {
      throw new Error("PRiSM Koishi plugin requires 'baseUrl' and 'integrationToken'.");
    }
    this.shopCode = options.shopCode ?? null;
    const open: SocketFactory = options.socket ?? ((url, headers) => {
      const http = (ctx as any).http;
      if (!http?.ws) throw new Error("Koishi http service with WebSocket support is required.");
      return http.ws(url, { headers });
    });
    // Home Assistant is reached the way the platform is, unless a test stands in for the platform and
    // says nothing about Home Assistant: then there is no watching to offer.
    const haOpen: SocketFactory | null = options.haSocket ?? (options.socket ? null : open);
    if (haOpen) this.watcher = new HaWatcher(haOpen, (frame) => this.socket.send(frame), this.logger);
    this.socket = new PrismSocket(
      open,
      platformSocketUrl(options.baseUrl),
      options.integrationToken,
      // Saying it can watch is what makes the platform consider this bot; the platform decides.
      () => (this.watcher ? { ha: true } : {}),
      (say) => {
        this.announcing = this.announcing
          .then(() => this.announce(say))
          .catch((error) => this.logger?.warn("PRiSM announcement failed", error));
      },
      this.logger,
      this.watcher
        ? { onWatch: (watch) => (watch ? this.watcher!.watch(watch) : this.watcher!.stop()), onClose: () => this.watcher!.stop() }
        : undefined,
    );
    this.post = options.httpPost ?? (async (url, headers, body) => {
      const http = (ctx as any).http;
      if (typeof http !== "function") throw new PrismBotClientError("HTTP 测速需要 Koishi 的 http 服务", "HTTP_UNAVAILABLE", 0, {});
      const response = await http(url, {
        method: "POST", headers, data: body, keepAlive: true, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
      });
      return { status: response.status, headers: response.headers, data: response.data };
    });
    this.socket.start();
  }

  dispose(): void {
    this.watcher?.stop();
    this.socket.stop();
  }

  /* ----------------------------- commands -------------------------------- */

  /**
   * Hand a command to the platform and answer with the first thing it says
   * back where the command was said; anything else it says for the command
   * (a receipt to staff, a door code) is sent as it comes.
   */
  async run(name: string, context: KoishiActionContext, rawArgs: unknown[], targetAt: number): Promise<string> {
    const from = await this.sender(context);
    if (!from) return "无法获取发送人的平台身份";
    const target = targetAt >= 0 ? await this.target(from, rawArgs[targetAt], context) : null;
    const args = rawArgs.filter((_, index) => index !== targetAt).map((arg) => (arg == null ? "" : String(arg).trim()));
    while (args.length && !args.at(-1)) args.pop();
    const session = context.session;
    const channel = session.isDirect || !session.channelId ? `private:${from.subject}` : `${from.provider}:${session.channelId}`;
    return new Promise<string>((resolve) => {
      let answered = false;
      let saying: Promise<void> = Promise.resolve();
      const answer = (text: string) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => answer(TIMED_OUT), REQUEST_TIMEOUT_MS);
      const sent = this.socket.command({ name, args, from, ...(target ? { target } : {}), channel }, (say) => {
        if (!say) return answer(UNREACHABLE);
        saying = saying.then(async () => {
          const text = await this.render(say.message, from.provider);
          if (!answered && (!say.to || say.to === channel)) return answer(text);
          await this.deliver(say.to ?? channel, text, context);
        }).catch((error) => this.logger?.warn("PRiSM reply failed", error));
      });
      if (!sent) answer(UNREACHABLE);
    });
  }

  /** Who sent the command, as the platform knows chat identities. */
  private async sender(context: KoishiActionContext): Promise<ChatIdentity | null> {
    const subject = String(context.session?.userId ?? "").trim();
    const provider = String(context.session?.platform || context.session?.bot?.platform || "").trim().toLowerCase();
    if (!subject || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) return null;
    let name = context.session?.username || context.session?.senderName || subject;
    try {
      const user = await context.session?.bot?.getUser?.(subject);
      if (user?.name) name = user.name;
    } catch {
      // The id is enough.
    }
    return { provider, subject, name };
  }

  /** Whom a `target:user` argument names (`platform:id`, or an id on the sender's platform), and what the chat calls them. */
  private async target(from: ChatIdentity, raw: unknown, context: KoishiActionContext): Promise<ChatIdentity | null> {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const separator = text.indexOf(":");
    const provider = separator > 0 ? text.slice(0, separator).toLowerCase() : from.provider;
    const subject = separator > 0 ? text.slice(separator + 1) : text;
    if (!subject) return null;
    let name = subject;
    try {
      const user = provider === from.provider ? await context.session?.bot?.getUser?.(subject) : null;
      if (user?.name) name = user.name;
    } catch {
      // The id is enough.
    }
    return { provider, subject, name };
  }

  /** Somewhere else than where the command was said: a private chat through the same bot, otherwise a channel. */
  private async deliver(to: string, text: string, context: KoishiActionContext): Promise<void> {
    if (to.startsWith("private:")) await context.session?.bot?.broadcast?.([to], text);
    else await this.sendTo(to, text);
  }

  /**
   * `platform:channel` or `platform:private:user`, through that platform's first
   * online bot: this needs neither Koishi's channel database nor its broadcast list.
   */
  private async sendTo(target: string, text: string): Promise<void> {
    try {
      const separator = target.indexOf(":");
      if (separator < 1 || separator === target.length - 1) throw new Error(`无效的播报频道：${target}`);
      const platform = target.slice(0, separator), channel = target.slice(separator + 1);
      if (channel === "private:") throw new Error(`无效的私聊目标：${target}`);
      const bot = this.ctx.bots?.find((candidate) => candidate.platform === platform && candidate.isActive);
      if (!bot) throw new Error(`没有可用的 ${platform} 机器人`);
      if (channel.startsWith("private:")) await bot.sendPrivateMessage(channel.slice(8), text);
      else await bot.sendMessage(channel, text);
    } catch (error) {
      this.logger?.warn(`PRiSM announcement to ${target} failed`, error);
    }
  }

  /** The shop's news, said where the platform says. */
  private async announce(say: SayFrame): Promise<void> {
    if (!say.to) return;
    await this.sendTo(say.to, await this.render(say.message));
  }

  /**
   * The platform's message as this chat says it: each player by the name the
   * chat knows them by on `provider`, or else on the first platform they are on.
   */
  private async render(message: BotMessage, provider?: string): Promise<string> {
    const parts: string[] = [];
    for (const segment of message) {
      const player = segment?.player;
      if (player && typeof player.playerId === "string") parts.push(await this.playerName(player, provider));
      else if (typeof segment?.text === "string") parts.push(segment.text);
    }
    return parts.join("");
  }

  private async playerName(player: MessagePlayer, provider?: string): Promise<string> {
    const identities = Array.isArray(player.identities) ? player.identities : [];
    const identity = identities.find((candidate) => candidate.provider === provider) ?? identities[0];
    if (identity && this.options.resolveDisplayName) {
      try {
        const name = await this.options.resolveDisplayName(identity.subject, identity.provider);
        if (name) return name;
      } catch {
        // The platform's name will do.
      }
    }
    return player.displayName || identity?.subject || player.playerId || "未知玩家";
  }

  /* ------------------------- the bot's own commands ------------------------ */

  async versions(): Promise<string> {
    let backend = "不可用";
    try {
      const reply = await this.socket.request({ method: "GET", path: "version" });
      if (reply.status < 400) {
        const record = data(reply.body) ?? {};
        const release = String(record.version ?? "").trim() || "unknown";
        const revision = String(record.revision ?? "").trim();
        backend = !revision || revision === "unknown" ? release : `${release} (${revision})`;
      }
    } catch {
      // The Bot version remains useful when the backend is offline or too old.
    }
    return ["PRiSM 版本信息", `Bot：${version}`, `后端：${backend}`].join("\n");
  }

  /**
   * The wallet query over plain HTTP. The first request usually has to open a
   * connection (DNS, TCP, TLS), so it is reported apart from the reused ones.
   */
  async benchmarkApi(context: KoishiActionContext, rawCount: unknown): Promise<string> {
    const count = benchmarkCount(rawCount);
    if (count === null) return "次数须为 1 到 10 的整数。";
    const from = await this.sender(context);
    if (!from) return "无法获取发送人的平台身份";
    try {
      const timings: Timing[] = [];
      for (let index = 0; index < count; index++) timings.push(await this.walletOverHttp(from));
      const [first, ...rest] = timings;
      return [
        `📡 API 测速（HTTP，钱包查询 ${count} 次）`,
        `首次：${Math.round(first!.ms)} ms（含建立连接）`,
        ...(rest.length ? [`之后：${spread(rest.map((timing) => timing.ms))}`] : []),
        ...serverLine(timings),
        ...(first!.colo ? [`节点：${first!.colo}`] : []),
      ].join("\n");
    } catch (error) {
      return benchmarkFailure(error);
    }
  }

  /** Heartbeats (the network alone) and the same wallet query over the platform connection. */
  async benchmarkWs(context: KoishiActionContext, rawCount: unknown): Promise<string> {
    const count = benchmarkCount(rawCount);
    if (count === null) return "次数须为 1 到 10 的整数。";
    const from = await this.sender(context);
    if (!from) return "无法获取发送人的平台身份";
    try {
      const pings: number[] = [];
      for (let index = 0; index < count; index++) pings.push(await this.socket.ping());
      const timings: Timing[] = [];
      for (let index = 0; index < count; index++) {
        const startedAt = performance.now();
        const reply = await this.socket.request({ method: "POST", path: "integration/players/by-identity/wallet", body: walletBody(from) });
        if (reply.status >= 400) throw replyError(reply.status, reply.body);
        timings.push({ ms: performance.now() - startedAt, serverMs: reply.serverMs ?? null });
      }
      return [
        `📡 WS 测速（${count} 次）`,
        `心跳：${spread(pings)}`,
        `钱包查询：${spread(timings.map((timing) => timing.ms))}`,
        ...serverLine(timings),
      ].join("\n");
    } catch (error) {
      return benchmarkFailure(error);
    }
  }

  /** The same wallet query as a plain HTTP request, the way the Bot used to call, timed. */
  private async walletOverHttp(from: ChatIdentity): Promise<Timing> {
    const code = this.shopCode ?? (this.shopCode = await this.readShopCode());
    const url = `${this.options.baseUrl!.trim().replace(/\/+$/, "")}/api/v1/shops/${encodeURIComponent(code)}/integration/players/by-identity/wallet`;
    const startedAt = performance.now();
    const response = await this.post(url, { authorization: `Bearer ${this.options.integrationToken}`, "content-type": "application/json" }, walletBody(from));
    const ms = performance.now() - startedAt;
    if (response.status >= 400) throw replyError(response.status, response.data);
    const server = Number.parseFloat(response.headers.get("x-response-time") ?? "");
    return { ms, serverMs: Number.isFinite(server) ? server : null, colo: response.headers.get("cf-ray")?.split("-").pop() ?? null };
  }

  /** The shop this credential belongs to, as the platform names it. */
  private async readShopCode(): Promise<string> {
    const reply = await this.socket.request({ method: "GET", path: "integration/bot" });
    if (reply.status >= 400) throw replyError(reply.status, reply.body);
    const code = String(data(reply.body)?.shop?.code ?? "").trim();
    if (!code) throw new PrismBotClientError("店铺尚未读取", "SHOP_UNKNOWN", 0, {});
    return code;
  }
}

function walletBody(from: ChatIdentity) {
  return { identity: { provider: from.provider, subject: from.subject } };
}

function benchmarkCount(raw: unknown): number | null {
  const count = raw == null || raw === "" ? 5 : Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : null;
}

function benchmarkFailure(error: unknown): string {
  if (error instanceof PrismBotClientError && error.status === 0) return error.code === "API_TIMEOUT" ? TIMED_OUT : UNREACHABLE;
  return "测速失败，请稍后再试。";
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

export default {
  name,
  Config,
  ConfigSchema: Config,
  apply,
};
