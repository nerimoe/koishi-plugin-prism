import { h, Schema } from "koishi";
import packageMetadata from "../package.json";

export const name = "prism";
export const version = packageMetadata.version;

export const Config: Schema<PrismKoishiPluginConfig> = Schema.object({
  provider: Schema.string().required().description("平台提供商 (如 qq)"),
  autoRegister: Schema.boolean().default(true).description("是否自动注册"),
  baseUrl: Schema.string().description("PRiSM 后端 API Base URL"),
  integrationToken: Schema.string().role("secret").description("集成 API Token"),
  currencyName: Schema.string().default("猫粮").description("代币名称"),
  defaultDoorDeviceId: Schema.string().default("front-door").description("默认开门设备名或别名"),
  defaultScanProvider: Schema.string().default("aime").description("默认刷卡提供商"),
  loginPricingConfigIds: Schema.array(Schema.string()).default([]).description("默认入场绑定的计费策略ID"),
  loginSessionLabel: Schema.string().default("音游区间").description("默认入场场次标签 (防重复入场)"),
  enableStaffCommands: Schema.boolean().default(false).description("是否启用管理员指令"),
  staffUserIds: Schema.array(Schema.string()).default([]).description("允许执行管理员指令的平台用户ID列表"),
  logoutNotifyUserIds: Schema.array(Schema.string()).default([]).description("结账账单私聊通知的平台用户ID列表"),
  powerOffInterval: Schema.number().default(0).description("无人自动关机等待秒数 (0为禁用)"),
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
  provider: string;
  autoRegister: boolean;
  loginPricingConfigIds?: string[];
  loginSessionLabel?: string;
  defaultDoorDeviceId: string;
  defaultScanProvider: string;
  currencyName: string;
  enableStaffCommands?: boolean;
  staffUserIds?: string[];
  logoutNotifyUserIds?: string[];
  mahjongTableConfigs?: MahjongTableConfigInput[];
  mahjongTableSize?: number;
  powerOffInterval?: number;
  /**
   * Used by /list to resolve player display names from the chat platform.
   * For Koishi, this should map a QQ subject string to a nickname (e.g. the
   * member list of the current group). If not provided, the plugin will fall
   * back to `playerDisplayName` from the backend.
   */
  resolveDisplayName?: (subject: string) => Promise<string | null | undefined> | string | null | undefined;
  /** Get a stable current ISO timestamp; mainly for tests. */
  now?: () => Date;

  // Connection parameters
  baseUrl?: string;
  integrationToken?: string;

  // Optional client injection (mainly for unit tests / mock)
  client?: any;
};

export type KoishiCommandRegistration = {
  description: string;
  action: (context: KoishiActionContext, ...args: string[]) => Promise<string> | string;
};

export type KoishiCommandBuilder = {
  action(handler: KoishiCommandRegistration["action"]): KoishiCommandBuilder;
};

export type KoishiLikeContext = {
  command(name: string, description: string): KoishiCommandBuilder;
  setInterval?(handler: () => Promise<void> | void, intervalMs: number): void;
};

export type KoishiActionContext = {
  session: {
    userId: string;
    messageId?: string;
    senderId?: string;
    senderName?: string;
    username?: string;
    bot?: {
      getUser?(id: string): Promise<{ name?: string }>;
      broadcast?(userIds: string[], content: string): Promise<void>;
    };
  };
};

const LOCAL_TZ_OFFSET_MINUTES = 8 * 60;

const USAGE: Record<string, string> = {
  mahjong_join: "/上桌 <桌号>",
  mahjong_leave: "/下桌",
  mahjong_list: "/麻将列表",
  api_benchmark: "/api测速 [次数]",
  prism_on: "/prism on <设备名|别名|all>",
  prism_off: "/prism off <设备名|别名|all>",
  prism_coin: "/prism coin <设备ID> [数量]",
  prism_scan: "/prism scan <设备ID> <卡号>",
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
  state?: { state?: string } | null;
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

  ctx.command("register", "绑定或注册当前平台用户到 PRiSM").action(wrap(async (context) =>
    service.register(await service.sender(context)),
  ));

  ctx.command("login [target:user]", "开启玩家计费场次").action(wrap(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  ));

  ctx.command("入场 [target:user]", "入场").action(wrap(async (context, target) =>
    service.loginForTarget(await service.sender(context), target, context.session?.bot),
  ));

  ctx.command("mahjong <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("上桌 [tableId]", "加入指定麻将桌").action(wrap(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("下桌", "离开当前所在麻将桌").action(wrap(async (context) =>
    service.mahjongLeave(await service.sender(context)),
  ));

  ctx.command("麻将列表", "查看麻将机状态与别名").action(wrap(async () =>
    service.listMahjongTables(),
  ));

  ctx.command("logout [target:user]", "结算玩家计费场次").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.logout(sender, context.session?.bot), context.session?.bot),
  ));

  ctx.command("billing [target:user]", "预览玩家结账费用").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.billing(sender), context.session?.bot),
  ));

  ctx.command("wallet [target:user]", "查看玩家钱包").action(wrap(async (context, target) =>
    service.withTarget(await service.sender(context), target, (sender) => service.wallet(sender), context.session?.bot),
  ));

  ctx.command("api测速 [count:number]", "测试 Bot 到 PRiSM API 的钱包查询延迟").action(wrap(async (context, count) =>
    service.benchmarkApi(await service.sender(context), count),
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

  ctx.command("lock", "向默认门锁设备发送开门指令").action(wrap(async (context) =>
    service.lock(await service.sender(context)),
  ));

  ctx.command("on <deviceRef>", "请求启动指定设备电源").action(wrap(async (context, deviceRef) =>
    service.powerOn(await service.sender(context), deviceRef),
  ));

  ctx.command("off <deviceRef>", "请求关闭指定设备电源").action(wrap(async (context, deviceRef) =>
    service.powerOff(await service.sender(context), deviceRef),
  ));

  ctx.command("coin <deviceId> [count]", "请求向指定设备投币").action(
    wrap(async (context, deviceId, count) => service.coin(await service.sender(context), deviceId, count)),
  );

  ctx.command("scan <deviceId> <subject>", "请求指定设备模拟刷卡").action(
    wrap(async (context, deviceId, subject) => service.scan(await service.sender(context), deviceId, subject)),
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

  const intervalMs = (config.powerOffInterval ?? 0) * 1000;
  if (intervalMs > 0 && typeof ctx.setInterval === "function") {
    ctx.setInterval(() => {
      service.autoPowerOffLoop().catch(() => {
        /* swallow */
      });
    }, intervalMs);
  }
}

/* ----------------------------- api client ---------------------------------- */

class PrismApiClient {
  constructor(
    private readonly http: any,
    private readonly config: {
      baseUrl: string;
      integrationToken: string;
    },
  ) { }

  private get headers() {
    return {
      "Content-Type": "application/json",
    };
  }

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
    let url = path;
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url = url.replace(`:${key}`, encodeURIComponent(String(value)));
      }
    }
    const fullUrl = `${this.config.baseUrl.replace(/\/+$/, "")}${url}`;
    const headers: Record<string, string> = {
      ...this.headers,
    };
    if (options.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    try {
      const config = { headers, params: options.query };
      let response: any;
      if (method === "GET") {
        response = await this.http.get(fullUrl, config);
      } else if (method === "POST") {
        response = await this.http.post(fullUrl, options.body ?? {}, config);
      } else if (method === "PUT") {
        response = await this.http.put(fullUrl, options.body ?? {}, config);
      } else {
        throw new Error(`Unsupported method ${method}`);
      }
      return response;
    } catch (error: any) {
      if (error.response && error.response.data) {
        const body = error.response.data;
        const err = body.error || {};
        throw new PrismBotClientError(
          err.message || error.message,
          err.code || "API_ERROR",
          error.response.status || 500,
          body,
        );
      }
      throw new PrismBotClientError(error.message || "Network error", "NETWORK_ERROR", 500, {});
    }
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
      token: this.config.integrationToken,
      body: this.identityBody(identity),
    });
    return result.player;
  }

  async getVersion() {
    return this.request("GET", "/version", {});
  }

  async startSessionByIdentity(identity: any, body?: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/session/start", {
      token: this.config.integrationToken,
      body: {
        ...this.identityBody(identity),
        ...(body ?? {}),
      },
    });
  }

  async stopSessionByIdentity(identity: any, sessionId: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/sessions/:sessionId/stop", {
      token: this.config.integrationToken,
      params: { sessionId },
      body: this.identityBody(identity),
    });
  }

  async getWalletByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/wallet", {
      token: this.config.integrationToken,
      body: this.identityBody(identity),
    });
  }

  async getAssetsByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/assets", {
      token: this.config.integrationToken,
      body: this.identityBody(identity),
    });
  }

  async getSessionHistoryByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/history", {
      token: this.config.integrationToken,
      body: this.identityBody(identity),
    });
  }

  async previewCheckoutByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/preview", {
      token: this.config.integrationToken,
      body: this.identityBody(identity),
    });
  }

  async confirmCheckoutByIdentity(identity: any, closeSessionsBeforeBalanceCheck = true) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/confirm", {
      token: this.config.integrationToken,
      body: { ...this.identityBody(identity), closeSessionsBeforeBalanceCheck },
    });
  }

  async redeemCodeByIdentity(identity: any, code: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/redeem", {
      token: this.config.integrationToken,
      body: {
        ...this.identityBody(identity),
        code,
      },
    });
  }

  async requestDeviceCommandByIdentity(identity: any, command: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/device-actions", {
      token: this.config.integrationToken,
      body: {
        ...this.identityBody(identity),
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
      token: this.config.integrationToken,
      body: {
        ...this.identityBody(identity),
        target: {
          kind: "game_machine",
          id: scan.deviceId,
        },
        action: {
          type: "aime.scan",
          payload: {
            provider: scan.provider,
            subject: scan.subject,
          },
        },
      },
    });
  }

  async listActiveSessions() {
    return this.request("GET", "/rpc/integration/sessions/active", {
      token: this.config.integrationToken,
    });
  }

  async listDeviceStates() {
    return this.request("GET", "/rpc/integration/device-states", {
      token: this.config.integrationToken,
    });
  }

  async adjustAssetsByIdentity(identity: any, adjustments: unknown[]) {
    return this.request("POST", "/rpc/integration/players/by-identity/assets/adjustments", {
      token: this.config.integrationToken,
      body: { ...this.identityBody(identity), adjustments },
    });
  }

  async adjustWalletByIdentity(identity: any, amount: number, reason: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/wallet/adjustment", {
      token: this.config.integrationToken,
      body: { ...this.identityBody(identity), amount, reason },
    });
  }

  async checkoutWithOverrideByIdentity(identity: any, total: number, reason: string) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/override", {
      token: this.config.integrationToken,
      body: { ...this.identityBody(identity), total, reason },
    });
  }
}

/* ------------------------------- service ----------------------------------- */

class PrismKoishiService {
  private readonly mahjongTables = new Map<string, MahjongTableState>();
  private readonly logoutInFlight = new Map<string, Promise<string>>();
  private readonly client: any;

  constructor(ctx: KoishiLikeContext, private readonly config: PrismKoishiPluginConfig) {
    if (config.client) {
      this.client = config.client;
    } else {
      if (!config.baseUrl) {
        throw new Error("PRiSM Koishi plugin requires either 'client' or 'baseUrl' in config.");
      }
      if (!config.integrationToken) {
        throw new Error("PRiSM Koishi plugin requires 'integrationToken' in config when 'client' is not provided.");
      }
      const http = (ctx as any).http ?? {
        async get(url: string, c: any) {
          const res = await fetch(url, { method: "GET", headers: c.headers });
          if (!res.ok) throw { response: { data: await res.json(), status: res.status } };
          return res.json();
        },
        async post(url: string, body: any, c: any) {
          const res = await fetch(url, { method: "POST", headers: c.headers, body: JSON.stringify(body) });
          if (!res.ok) throw { response: { data: await res.json(), status: res.status } };
          return res.json();
        },
        async put(url: string, body: any, c: any) {
          const res = await fetch(url, { method: "PUT", headers: c.headers, body: JSON.stringify(body) });
          if (!res.ok) throw { response: { data: await res.json(), status: res.status } };
          return res.json();
        }
      };
      this.client = new PrismApiClient(http, {
        baseUrl: config.baseUrl,
        integrationToken: config.integrationToken,
      });
    }
  }

  async sender(context: KoishiActionContext): Promise<Sender> {
    const id = context.session?.senderId || context.session?.userId || "";
    let name = context.session?.username || context.session?.senderName || id;
    try {
      if (context.session?.bot?.getUser) {
        const user = await context.session.bot.getUser(id);
        if (user?.name) {
          name = user.name;
        }
      }
    } catch { }
    return { id, name };
  }

  async register(sender: Sender): Promise<string> {
    await this.client.resolveOrRegisterIdentity(this.identity(sender));
    return "注册成功";
  }

  async loginForTarget(actor: Sender, targetSubject?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<string> {
    return this.withTarget(actor, targetSubject, async (sender, isTargeted) => {
      await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
      return isTargeted ? `✅ 已为用户 ${formatPlayerReference(sender, this.config.provider)} 入场成功` : "✅ 入场成功";
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
      return `✅ 已为用户 ${formatPlayerReference(sender, this.config.provider)}${isAddition ? "增加" : "扣除"} ${formatNumber(amount)} ${this.config.currencyName}`;
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
    delete state.activeSessions[playerId];
    const remainingCount = Object.keys(state.activeSessions).length;
    const tableSize = this.config.mahjongTableSize ?? 4;
    await this.client.stopSessionByIdentity(this.identity(sender), sessionId);
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
    const existing = this.logoutInFlight.get(sender.id);
    if (existing) return existing;
    const task = this.performLogout(sender, bot);
    this.logoutInFlight.set(sender.id, task);
    try {
      return await task;
    } finally {
      if (this.logoutInFlight.get(sender.id) === task) this.logoutInFlight.delete(sender.id);
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
    if (recipients.length > 0 && bot?.broadcast) {
      const channelIds = recipients.map((id) => (id.includes(":") ? id : `private:${id}`));
      await bot.broadcast(channelIds, receipt);
    }
    return receipt;
  }

  async wallet(sender: Sender): Promise<string> {
    const result = (await this.client.getWalletByIdentity(this.identity(sender))) as UncheckedRecord;
    return formatWallet(result.wallet as UncheckedRecord[], this.config.currencyName);
  }

  async benchmarkApi(sender: Sender, rawCount?: string): Promise<string> {
    const count = rawCount == null || rawCount === "" ? 3 : Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 10) return "次数须为 1 到 10 的整数。";
    const samples: number[] = [];
    for (let index = 0; index < count; index++) {
      const startedAt = performance.now();
      await this.client.getWalletByIdentity(this.identity(sender));
      samples.push(performance.now() - startedAt);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    return [
      `📡 PRiSM API 测速（钱包查询，${count} 次）`,
      `最小：${formatNumber(min)} ms`,
      `平均：${formatNumber(average)} ms`,
      `最大：${formatNumber(max)} ms`,
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
    await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: "door.open",
      target: { kind: "facility", ref: this.config.defaultDoorDeviceId },
    });
    return "🔑 门锁指令已发送";
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

  async coin(sender: Sender, rawDeviceId: string, rawCount: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    if (!deviceId) return commandUsage("prism_coin");
    const { value, error } = parsePositiveInt(rawCount, "prism_coin", "数量", 1);
    if (error) return error;
    const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: "coin",
      target: { kind: "game_machine", id: deviceId },
      payload: { count: value },
    });
    const failure = this.getCommandFailureMessage(result);
    if (failure) return `❌ 执行失败：${failure}`;
    return `🪙 已为 ${deviceId} 投入 ${value} 个币`;
  }

  async scan(sender: Sender, rawDeviceId: string, rawSubject: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    const subject = cleanText(rawSubject);
    if (!deviceId || !subject) return commandUsage("prism_scan");
    const result = await this.client.requestScanByIdentity(this.identity(sender), {
      deviceId,
      provider: this.config.defaultScanProvider || "aime",
      subject,
    });
    const failure = this.getCommandFailureMessage(result);
    if (failure) return `❌ 执行失败：${failure}`;
    return `💳 使用尾号为 ${subject.slice(-4)} 的卡刷卡成功`;
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
    const groups = await this.buildPlayerGroups(players, tableByLabel);
    this.mergeWaitingSeats(groups);
    return formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4);
  }

  async listDeviceStates(rawAlias?: string): Promise<string> {
    const alias = cleanText(rawAlias);
    const result = (await this.client.listDeviceStates()) as UncheckedRecord;
    const states = (result?.deviceStates ?? []) as DeviceStateItem[];
    if (states.length === 0) return "没有找到任何设备状态。";

    if (alias) {
      const matched = states.find((d) => d.deviceId === alias || d.label === alias);
      if (!matched) return `找不到设备: ${alias}`;
      const stateVal = matched.state?.state ?? "unknown";
      return `${matched.label || matched.deviceId}: ${stateVal}`;
    }
    return states
      .map((d) => `${d.label || d.deviceId}: ${d.state?.state ?? "unknown"}`)
      .join("\n");
  }

  async autoPowerOffLoop(): Promise<void> {
    const interval = this.config.powerOffInterval ?? 0;
    if (interval <= 0) return;
    const result = (await this.client.listActiveSessions()) as UncheckedRecord;
    const sessions = (result?.sessions ?? []) as UncheckedRecord[];
    if (sessions.length > 0) return;
    const statesResult = (await this.client.listDeviceStates()) as UncheckedRecord;
    const states = (statesResult?.deviceStates ?? []) as DeviceStateItem[];
    const anyOn = states.some((d) => d.state?.state !== "off");
    if (!anyOn) return;
    const dummySender: Sender = { id: "system", name: "system" };
    await this.powerOff(dummySender, "all");
  }

  /* ---------------------------- helpers ---------------------------------- */

  private async power(sender: Sender, deviceRef: string, state: string): Promise<string> {
    const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: state === "on" ? "power.on" : "power.off",
      target: { kind: "facility", ref: deviceRef },
      payload: { state },
    });
    const failure = this.getCommandFailureMessage(result);
    if (failure) return `❌ 执行失败：${failure}`;
    const deviceLabel = result.action.payload.deviceLabel;
    return state === "on" ? `✅ ${deviceLabel} 启动成功` : `🛑 ${deviceLabel} 关闭成功`;
  }

  private getCommandFailureMessage(result: any): string | null {
    const action = result?.action;
    if (action?.status === "expired" || action?.status === "rejected") {
      return action.payload?.executorFailure?.message || "命令执行被拒绝或超时";
    }
    return null;
  }

  private async resolvePlatformName(subject: string): Promise<string | null> {
    if (!this.config.resolveDisplayName) return null;
    try {
      return (await this.config.resolveDisplayName(subject)) ?? null;
    } catch {
      return null;
    }
  }

  private async displayNameForPlayer(player: ActivePlayer): Promise<string> {
    let identitySubject: string | undefined;
    for (const session of player.sessions) {
      const subject = findSubjectForSession(session, this.config.provider);
      if (!subject) continue;
      identitySubject ??= subject;
      const platformName = await this.resolvePlatformName(subject);
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
  ): Promise<PlayerGroups> {
    const groups: PlayerGroups = { groups: [] };
    const groupByLabel = new Map<string, PlayerGroups["groups"][number]>();
    const musicLabel = this.config.loginSessionLabel?.trim() || "音游区间";

    for (const player of players.values()) {
      player.displayName = await this.displayNameForPlayer(player);
      const nonMusic = player.sessions.filter((session) => Boolean(session.label) && session.label !== musicLabel);
      const source = nonMusic.length > 0 ? nonMusic : player.sessions;
      const selected = source.reduce((latest, session) =>
        !latest || sessionStartedAt(session) > sessionStartedAt(latest) ? session : latest,
        undefined as ActiveSessionListItem | undefined);
      const label = selected?.label || musicLabel;
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
    const platformName = await this.resolvePlatformName(sender.id);
    const name = platformName
      || (sender.name && sender.name !== sender.id ? sender.name : "")
      || "未知昵称";
    return `玩家：${name}（${this.config.provider.toUpperCase()}：${sender.id}）`;
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
      session.playerId === playerId && (label ? session.label === label : true),
    );
  }

  private identity(sender: Sender): IdentityInput {
    return {
      provider: this.config.provider,
      subject: sender.id,
      autoRegister: this.config.autoRegister,
      displayName: sender.name || `${this.config.provider.toUpperCase()} ${sender.id}`,
    };
  }

  private async targetSender(actor: Sender, targetSubject?: string, bot?: KoishiActionContext["session"]["bot"]): Promise<Sender | string> {
    const subject = normalizeTargetSubject(targetSubject);
    if (!subject) return actor;
    const denied = this.targetStaffDenied(actor);
    if (denied) return denied;
    try {
      const user = await bot?.getUser?.(subject);
      return { id: subject, name: user?.name || subject };
    } catch {
      return { id: subject, name: subject };
    }
  }

  private loginSessionBody(): { pricingConfigIds?: string[]; label?: string } | undefined {
    const pricingConfigIds = (this.config.loginPricingConfigIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    const label = this.config.loginSessionLabel?.trim();
    if (pricingConfigIds.length === 0 && !label) return undefined;
    return {
      ...(pricingConfigIds.length === 0 ? {} : { pricingConfigIds }),
      ...(label ? { label } : {}),
    };
  }

  private staffDenied(sender: Sender): string | null {
    if (!this.config.enableStaffCommands) return "员工命令未启用";
    const allowed = this.config.staffUserIds ?? [];
    if (allowed.length > 0 && !allowed.includes(sender.id)) return "权限不足";
    return null;
  }

  private targetStaffDenied(sender: Sender): string | null {
    if (!this.config.enableStaffCommands) return "员工命令未启用";
    const allowed = this.config.staffUserIds ?? [];
    if (!allowed.includes(sender.id)) return "权限不足";
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

    const validStarts = sessionPreviews.map((s) => parseDateTime(s?.startedAt)).filter(Boolean) as Date[];
    const validEnds = sessionPreviews.map((s) => sessionDisplayEnd(s, previewedAt)).filter(Boolean) as Date[];
    if (validStarts.length > 0) {
      const overallStart = minDate(validStarts);
      const overallEnd = validEnds.length > 0 ? maxDate(validEnds) : now(this.config);
      lines.push(`⏰ 游玩时间：${formatHM(overallStart)}–${formatHM(overallEnd)}`);
    }

    for (const sPrev of sessionPreviews) {
      const label = sPrev?.label || "计时区间";
      const startDt = parseDateTime(sPrev?.startedAt);
      const endDt = sessionDisplayEnd(sPrev, previewedAt);
      const status = sPrev?.status ?? "active";
      const sTotal = toNumber(sPrev?.total ?? 0);
      lines.push("");
      lines.push(label);
      if (startDt && endDt) {
        const minutes = Math.floor((endDt.getTime() - startDt.getTime()) / 60_000);
        lines.push(`游玩时段：${formatHM(startDt)}-${formatHM(endDt)}`);
        lines.push(`游玩时长：${formatDurationValue(minutes)}｜计价：${formatNumber(sTotal)}${currency}`);
      } else if (startDt) {
        lines.push(`入场：${formatHM(startDt)}  （${status === "active" ? "计费中" : "已关闭"}）`);
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
        const datedLabel = startedAt ? `${formatMD(startedAt)} ${label}` : label;
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
    if (error instanceof PrismBotClientError) {
      return humanReadableBotError(error);
    }
    if (error instanceof Error) {
      return `操作失败: ${error.message}`;
    }
    return "操作失败";
  }
}

/* ------------------------------ utilities --------------------------------- */

export type Sender = { id: string; name: string };

export function humanReadableBotError(error: PrismBotClientError): string {
  if (error.code === "DUPLICATE_SESSION_LABEL") {
    return "❌ 您已经处于入场状态，请勿重复发送入场命令。";
  }
  if (error.code === "PLAYER_HAS_NO_UNSETTLED_SESSIONS") {
    return "您当前没有未结算的账单，无需结账。";
  }
  if (error.code === "ACTIVE_SESSION_NOT_FOUND") {
    return "您当前没有进行中的计费场次。";
  }
  if (error.code === "PLAYER_IDENTITY_NOT_FOUND") {
    return "未找到您的玩家身份，请先注册或绑定账号。";
  }
  if (error.code === "INSUFFICIENT_BALANCE") {
    return "余额不足，暂时不能结账。请先充值，或由店员在后台改价后再结账。";
  }
  if (error.code === "API_UNREACHABLE" || error.code === "HTTP_0") {
    return "连接不到 PRiSM 后端，请确认后端服务正在运行。";
  }
  if (error.code === "API_TIMEOUT") {
    return "PRiSM 后端响应超时，请稍后再试。";
  }
  if (error.code === "INVALID_JSON_RESPONSE") {
    return "PRiSM 后端返回了非 JSON 响应，请检查后端是否正常运行。";
  }
  if (error.code === "STAFF_TOKEN_REQUIRED") {
    return "缺少管理面板令牌。";
  }
  return String(error?.message ?? error);
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

function formatPlayerGroups(groups: PlayerGroups, tableSize: number): string {
  const populatedGroups = groups.groups.filter((group) => group.players.length > 0);
  const total = new Set(populatedGroups.flatMap((group) => group.players.map((player) => player.playerId))).size;
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

function normalizeTargetSubject(value: unknown): string {
  const subject = cleanText(value);
  const separator = subject.indexOf(":");
  return separator > 0 ? subject.slice(separator + 1) : subject;
}

function formatPlayerReference(sender: Sender, provider = "qq"): string {
  const name = sender.name && sender.name !== sender.id ? sender.name : "未知昵称";
  return `${name}（${provider.toUpperCase()}：${sender.id}）`;
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

function parseDateTime(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return ensureLocal(value);
  }
  const text = String(value).trim();
  if (!text) return null;
  let normalized = text;
  if (normalized.endsWith("Z")) normalized = `${normalized.slice(0, -1)}+00:00`;
  const dt = new Date(normalized);
  if (!Number.isNaN(dt.getTime())) return ensureLocal(dt);
  return null;
}

function ensureLocal(dt: Date): Date {
  const offsetMs = LOCAL_TZ_OFFSET_MINUTES * 60_000;
  const local = new Date(dt.getTime() + offsetMs);
  void local;
  return dt;
}

function formatHM(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function formatMD(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function formatDateTime(value: any): string {
  const dt = parseDateTime(value);
  if (!dt) return "永不过期";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function formatTimeRange(start: any, end: any): string {
  const startDt = parseDateTime(start);
  const endDt = parseDateTime(end);
  if (!startDt || !endDt) return `${formatDateTime(start)} - ${formatDateTime(end)}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const startTime = `${pad(startDt.getHours())}:${pad(startDt.getMinutes())}:${pad(startDt.getSeconds())}`;
  const endTime = `${pad(endDt.getHours())}:${pad(endDt.getMinutes())}:${pad(endDt.getSeconds())}`;
  if (startDt.toDateString() === endDt.toDateString()) return `${startTime} - ${endTime}`;
  return `${startDt.getMonth() + 1}/${startDt.getDate()} ${startTime} - ${endDt.getMonth() + 1}/${endDt.getDate()} ${endTime}`;
}

function formatDurationMinutes(start: any, end: any): string {
  const startDt = parseDateTime(start);
  const endDt = parseDateTime(end);
  if (!startDt || !endDt) return "0分钟";
  return formatDurationValue(Math.floor((endDt.getTime() - startDt.getTime()) / 60_000));
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
  const qq = identities.find((id) => id.provider === provider);
  if (qq) return qq.subject;
  return identities[0].subject ?? null;
}

export default {
  name,
  Config,
  ConfigSchema: Config,
  apply,
};
