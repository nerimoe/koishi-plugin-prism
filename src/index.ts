import { Schema } from "koishi";

export const name = "prism";

export const Config: Schema<PrismKoishiPluginConfig> = Schema.object({
  provider: Schema.string().required().description("平台提供商 (如 qq)"),
  autoRegister: Schema.boolean().default(true).description("是否自动注册"),
  baseUrl: Schema.string().description("PRiSM 后端 API Base URL"),
  integrationToken: Schema.string().role("secret").description("集成 API Token"),
  staffSessionToken: Schema.string().role("secret").description("Staff 管理 Token (可选)"),
  currencyName: Schema.string().default("猫粮").description("代币名称"),
  defaultDoorDeviceId: Schema.string().default("front-door").description("默认开门设备ID"),
  defaultScanProvider: Schema.string().default("aime").description("默认刷卡提供商"),
  loginPricingConfigIds: Schema.array(Schema.string()).default([]).description("默认入场绑定的计费策略ID"),
  loginSessionLabel: Schema.string().default("音游区间").description("默认入场场次标签 (防重复入场)"),
  enableStaffCommands: Schema.boolean().default(false).description("是否启用管理员指令"),
  staffUserIds: Schema.array(Schema.string()).default([]).description("允许执行管理员指令的平台用户ID列表"),
  powerOffInterval: Schema.number().default(0).description("无人自动关机等待秒数 (0为禁用)"),
  mahjongTables: Schema.string().description("麻将桌配置"),
  mahjongTableSize: Schema.number().default(4).description("麻将桌人数限制"),
  mahjongLabelPrefix: Schema.string().default("麻将桌").description("麻将账单前缀"),
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
  mahjongTables?: string;
  mahjongTableSize?: number;
  mahjongLabelPrefix?: string;
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
  staffSessionToken?: string;

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
    senderId?: string;
    senderName?: string;
    username?: string;
    bot?: {
      getUser?(id: string): Promise<{ name?: string }>;
    };
  };
};

const LOCAL_TZ_OFFSET_MINUTES = 8 * 60;

const USAGE: Record<string, string> = {
  mahjong_join: "/上桌 <桌号>",
  mahjong_leave: "/下桌 <桌号>",
  prism_on: "/prism on <设备ID>",
  prism_off: "/prism off <设备ID|all>",
  prism_coin: "/prism coin <设备ID> [数量]",
  prism_scan: "/prism scan <设备ID> <卡号>",
  prism_redeem: "/prism redeem <兑换码>",
  list: "/list",
  show: "/show [设备ID]",
  staff_create_player: "/prism.admin.create-player <玩家昵称>",
  staff_grant_balance: "/prism.admin.grant-balance <玩家ID> <金额>",
  staff_redeem_code: "/prism.admin.redeem-code <兑换码> <礼物ID>",
  staff_checkout: "/prism.admin.checkout <玩家ID>",
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
      return await handler(context, ...args);
    } catch (error) {
      return service.handleCommandError(error);
    }
  };

  ctx.command("register", "绑定或注册当前平台用户到 PRiSM").action(wrap(async (context) =>
    service.register(await service.sender(context)),
  ));

  ctx.command("login", "开启当前玩家的计费场次").action(wrap(async (context) =>
    service.login(await service.sender(context)),
  ));

  ctx.command("入场", "入场 (alias of login)").action(wrap(async (context) =>
    service.login(await service.sender(context)),
  ));

  ctx.command("mahjong <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("上桌 <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) =>
    service.mahjongJoin(await service.sender(context), tableId),
  ));

  ctx.command("下桌 <tableId>", "离开指定麻将桌").action(wrap(async (context, tableId) =>
    service.mahjongLeave(await service.sender(context), tableId),
  ));

  ctx.command("logout", "结算当前玩家的计费场次").action(wrap(async (context) =>
    service.logout(await service.sender(context)),
  ));

  ctx.command("billing", "预览当前玩家的结账费用").action(wrap(async (context) =>
    service.billing(await service.sender(context)),
  ));

  ctx.command("wallet", "查看当前玩家钱包余额").action(wrap(async (context) =>
    service.wallet(await service.sender(context)),
  ));

  ctx.command("items", "查看当前玩家持有资产").action(wrap(async (context) =>
    service.items(await service.sender(context)),
  ));

  ctx.command("list", "查看当前在线玩家列表").action(wrap(async (context) =>
    service.listActiveSessions(await service.sender(context)),
  ));

  ctx.command("show [deviceId]", "查看设备电源状态").action(wrap(async (context, deviceId) =>
    service.listDeviceStates(deviceId),
  ));

  ctx.command("history", "查看当前玩家历史场次").action(wrap(async (context) =>
    service.history(await service.sender(context)),
  ));

  ctx.command("lock", "向默认门锁设备发送开门指令").action(wrap(async (context) =>
    service.lock(await service.sender(context)),
  ));

  ctx.command("on <deviceId>", "请求启动指定设备电源").action(wrap(async (context, deviceId) =>
    service.powerOn(await service.sender(context), deviceId),
  ));

  ctx.command("off <deviceId>", "请求关闭指定设备电源").action(wrap(async (context, deviceId) =>
    service.powerOff(await service.sender(context), deviceId),
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

  if (config.enableStaffCommands) {
    ctx.command("admin.players", "列出 PRiSM 玩家").action(wrap(async (context) =>
      service.staffPlayers(await service.sender(context)),
    ));
    ctx.command("admin.create-player <displayName>", "创建 PRiSM 玩家").action(
      wrap(async (context, displayName) => service.staffCreatePlayer(await service.sender(context), displayName)),
    );
    ctx.command("admin.grant-balance <playerId> <amount>", "给指定玩家发放充值余额").action(
      wrap(async (context, playerId, amount) => service.staffGrantBalance(await service.sender(context), playerId, amount)),
    );
    ctx.command("admin.redeem-code <code> <presentId>", "创建单次使用兑换码").action(
      wrap(async (context, code, presentId) => service.staffRedeemCode(await service.sender(context), code, presentId)),
    );
    ctx.command("admin.checkout <playerId>", "替指定玩家结账").action(wrap(async (context, playerId) =>
      service.staffCheckout(await service.sender(context), playerId),
    ));
  }

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
      staffSessionToken?: string;
    },
  ) {}

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

  private requireStaffSessionToken(): string {
    if (!this.config.staffSessionToken) {
      throw new PrismBotClientError("Staff session token is required for this Bot shortcut.", "STAFF_TOKEN_REQUIRED", 0, {});
    }
    return this.config.staffSessionToken;
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

  async confirmCheckoutByIdentity(identity: any) {
    return this.request("POST", "/rpc/integration/players/by-identity/checkout/confirm", {
      token: this.config.integrationToken,
      body: this.identityBody(identity),
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

  // Staff commands
  async listStaffPlayers() {
    return this.request("GET", "/rpc/staff/players", {
      token: this.requireStaffSessionToken(),
    });
  }

  async createStaffPlayer(displayName: string) {
    return this.request("POST", "/rpc/staff/players", {
      token: this.requireStaffSessionToken(),
      body: { displayName },
    });
  }

  async grantStaffAssets(playerId: string, assets: any[]) {
    return this.request("POST", "/rpc/staff/players/:playerId/adjustments/assets", {
      token: this.requireStaffSessionToken(),
      params: { playerId },
      body: { assets },
    });
  }

  async createStaffRedeemCode(input: any) {
    return this.request("POST", "/rpc/staff/redeem-codes", {
      token: this.requireStaffSessionToken(),
      body: input,
    });
  }

  async staffCheckout(playerId: string) {
    return this.request("POST", "/rpc/staff/players/:playerId/settlements/checkout", {
      token: this.requireStaffSessionToken(),
      params: { playerId },
    });
  }
}

/* ------------------------------- service ----------------------------------- */

class PrismKoishiService {
  private readonly mahjongTables = new Map<string, MahjongTableState>();
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
        staffSessionToken: config.staffSessionToken,
      });
    }
  }

  async sender(context: KoishiActionContext): Promise<Sender> {
    const id = context.session?.senderId || context.session?.userId || "";
    let name = id;
    try {
      if (context.session?.bot?.getUser) {
        const user = await context.session.bot.getUser(id);
        if (user?.name) {
          name = user.name;
        }
      }
    } catch {
      name = context.session?.username || context.session?.senderName || id;
    }
    return { id, name };
  }

  async register(sender: Sender): Promise<string> {
    await this.client.resolveOrRegisterIdentity(this.identity(sender));
    return "注册成功";
  }

  async login(sender: Sender): Promise<string> {
    await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
    return "✅ 入场成功";
  }

  async mahjongJoin(sender: Sender, rawTableId: string): Promise<string> {
    const tableId = cleanText(rawTableId);
    if (!tableId) return commandUsage("mahjong_join");
    const tableConfig = this.mahjongTableConfigs().get(tableId);
    if (!tableConfig) return `找不到 ${tableId} 桌的麻将计费配置。`;
    const tableKey = tableConfig.tableId;
    const tableSubject = tableConfig.displayName || `${tableKey} 桌`;

    const player = await this.resolvePlayer(sender);
    const playerId = String(player.id ?? "");
    const existing = this.mahjongTableForPlayer(playerId);
    if (existing) return `你已经在 ${existing} 桌了。`;

    const state = this.mahjongTables.get(tableKey) ?? { waiting: [], activeSessions: {} };
    this.mahjongTables.set(tableKey, state);
    if (Object.keys(state.activeSessions).length > 0) {
      return `${tableSubject}已经开始计费，请先等当前这一桌结束。`;
    }

    state.waiting.push({
      playerId,
      senderId: sender.id,
      displayName: sender.name || playerId,
      identity: this.identity(sender),
    });

    const tableSize = this.config.mahjongTableSize ?? 4;
    if (state.waiting.length < tableSize) {
      return `已加入 ${tableSubject}，当前 ${state.waiting.length}/${tableSize} 人。`;
    }

    const seats = state.waiting.slice(0, tableSize);
    state.waiting = state.waiting.slice(tableSize);
    const label = tableConfig.displayName || `${this.config.mahjongLabelPrefix ?? "麻将桌"} ${tableKey}`;
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

  async mahjongLeave(sender: Sender, rawTableId: string): Promise<string> {
    const tableId = cleanText(rawTableId);
    if (!tableId) return commandUsage("mahjong_leave");
    const tableConfig = this.mahjongTableConfigs().get(tableId);
    const tableKey = tableConfig?.tableId ?? tableId;
    const tableSubject = tableConfig?.displayName || `${tableId} 桌`;
    const state = this.mahjongTables.get(tableKey);
    if (!state) return `你不在 ${tableSubject}。`;

    const player = await this.resolvePlayer(sender);
    const playerId = String(player.id ?? "");
    const waitingBefore = state.waiting.length;
    state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
    if (state.waiting.length !== waitingBefore) {
      return `已离开 ${tableSubject}，当前 ${state.waiting.length}/${this.config.mahjongTableSize ?? 4} 人。`;
    }

    const sessionId = state.activeSessions[playerId];
    if (!sessionId) return `你不在 ${tableSubject}。`;
    delete state.activeSessions[playerId];
    await this.client.stopSessionByIdentity(this.identity(sender), sessionId);
    return `已离开 ${tableSubject}，麻将计费已停止。`;
  }

  async billing(sender: Sender): Promise<string> {
    const result = (await this.client.previewCheckoutByIdentity(this.identity(sender))) as UncheckedRecord;
    return this.formatCheckoutPreview(result, sender);
  }

  async logout(sender: Sender): Promise<string> {
    const result = (await this.client.confirmCheckoutByIdentity(this.identity(sender))) as UncheckedRecord;
    const settlement = result?.playerSettlement ?? result?.settlement ?? {};
    const records = result?.settlements ?? [];
    const sessionPreviews = records.map((rec: UncheckedRecord) => {
      const s = rec?.settlement ?? {};
      return {
        sessionId: s.sessionId,
        label: s.label,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? s.settledAt,
        status: "closed",
        subtotal: s.subtotal ?? 0,
        total: s.total ?? 0,
        chargeItems: rec?.chargeItems ?? [],
        adjustments: rec?.adjustments ?? [],
      };
    });
    const synthetic = {
      settlementPreview: {
        playerId: settlement.playerId,
        subtotal: settlement.subtotal ?? 0,
        total: settlement.total ?? 0,
      },
      sessionPreviews,
      chargeItems: result?.chargeItems ?? [],
      adjustments: result?.adjustments ?? [],
      assetHoldings: result?.assetHoldings ?? [],
    };
    return this.formatCheckoutPreview(synthetic, sender, "✅ 退场成功 · 结算账单");
  }

  async wallet(sender: Sender): Promise<string> {
    const result = (await this.client.getWalletByIdentity(this.identity(sender))) as UncheckedRecord;
    return formatWallet(result, this.config.currencyName);
  }

  async items(sender: Sender): Promise<string> {
    const holdings = extractRows((await this.client.getAssetsByIdentity(this.identity(sender))) as UncheckedRecord);
    if (holdings.length === 0) return "您当前没有任何物品。";
    return ["🎒 --- 您拥有的物品 ---", ...holdings.map(formatInventoryItem)].join("\n");
  }

  async history(sender: Sender): Promise<string> {
    return formatHistory((await this.client.getSessionHistoryByIdentity(this.identity(sender))) as UncheckedRecord, this.config.currencyName);
  }

  async lock(sender: Sender): Promise<string> {
    await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: "door.open",
      target: { kind: "facility", id: this.config.defaultDoorDeviceId },
    });
    return "🔑 门锁指令已发送";
  }

  async powerOn(sender: Sender, rawDeviceId: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    if (!deviceId) return commandUsage("prism_on");
    return this.power(sender, deviceId, "on");
  }

  async powerOff(sender: Sender, rawDeviceId: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    if (!deviceId) return commandUsage("prism_off");
    return this.power(sender, deviceId, "off");
  }

  async coin(sender: Sender, rawDeviceId: string, rawCount: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    if (!deviceId) return commandUsage("prism_coin");
    const { value, error } = parsePositiveInt(rawCount, "prism_coin", "数量", 1);
    if (error) return error;
    await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: "coin",
      target: { kind: "game_machine", id: deviceId },
      payload: { count: value },
    });
    return `🪙 已为 ${deviceId} 投入 ${value} 个币`;
  }

  async scan(sender: Sender, rawDeviceId: string, rawSubject: string): Promise<string> {
    const deviceId = cleanText(rawDeviceId);
    const subject = cleanText(rawSubject);
    if (!deviceId || !subject) return commandUsage("prism_scan");
    await this.client.requestScanByIdentity(this.identity(sender), {
      deviceId,
      provider: this.config.defaultScanProvider || "aime",
      subject,
    });
    return `💳 使用尾号为 ${subject.slice(-4)} 的卡刷卡成功`;
  }

  async redeem(sender: Sender, rawCode: string): Promise<string> {
    const code = cleanText(rawCode);
    if (!code) return commandUsage("prism_redeem");
    const result = (await this.client.redeemCodeByIdentity(this.identity(sender), code)) as UncheckedRecord;
    const holdings = extractRows(result);
    if (holdings.length === 0) return "兑换成功，但没有获得任何物品。";
    return ["✅ 兑换成功！您获得了以下物品：", ...holdings.map(formatRedeemedItem)].join("\n");
  }

  async listActiveSessions(sender: Sender): Promise<string> {
    const result = (await this.client.listActiveSessions()) as UncheckedRecord;
    const sessions = (result?.sessions ?? []) as ActiveSessionListItem[];
    if (sessions.length === 0) return "🫥 窝里目前没有玩家呢";

    const lines = [`👥 窝里目前共有 ${sessions.length} 人`];
    for (const session of sessions) {
      const identitySubject = findSubjectForSession(session, this.config.provider);
      let display: string;
      if (identitySubject) {
        const platformName = await this.resolvePlatformName(identitySubject);
        if (platformName) {
          display = `${platformName} ( ${identitySubject} )`;
        } else {
          display = `${session.playerDisplayName || identitySubject} ( ${identitySubject} )`;
        }
      } else {
        display = session.playerDisplayName || session.playerId || "未知玩家";
      }
      const timeStr = formatDateTime(session.startedAt);
      lines.push(`玩家: ${display}\n入场时间: ${timeStr}`);
    }
    return lines.join("\n\n");
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

  async staffPlayers(sender: Sender): Promise<string> {
    const denied = this.staffDenied(sender);
    if (denied) return denied;
    const result = (await this.client.listStaffPlayers()) as UncheckedRecord;
    const players = (result?.players ?? []) as UncheckedRecord[];
    if (players.length === 0) return "🫥 窝里目前没有玩家呢";
    return [
      `👥 窝里目前共有 ${players.length} 人`,
      "",
      ...players.map((p) => {
        const lines = [`玩家: ${p?.displayName ?? p?.id ?? ""} (${p?.id ?? ""})`];
        if (p?.status) lines.push(`状态: ${p.status}`);
        if (p?.walletTotal != null) lines.push(`余额: ${p.walletTotal} ${this.config.currencyName}`);
        return lines.join("\n");
      }),
    ].join("\n");
  }

  async staffCreatePlayer(sender: Sender, rawDisplayName: string): Promise<string> {
    const displayName = cleanText(rawDisplayName);
    if (!displayName) return commandUsage("staff_create_player");
    const denied = this.staffDenied(sender);
    if (denied) return denied;
    const result = (await this.client.createStaffPlayer?.(displayName)) as UncheckedRecord;
    const player = result?.player ?? {};
    return `创建成功\n玩家: ${player?.displayName ?? displayName}\nID: ${player?.id ?? ""}`;
  }

  async staffGrantBalance(sender: Sender, rawPlayerId: string, rawAmount: string): Promise<string> {
    const playerId = cleanText(rawPlayerId);
    const amount = cleanText(rawAmount);
    if (!playerId || !amount) return commandUsage("staff_grant_balance");
    const denied = this.staffDenied(sender);
    if (denied) return denied;
    await this.client.grantStaffAssets?.(playerId, [
      {
        assetType: "currency",
        assetCode: "paid",
        amount: Number(amount),
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      },
    ]);
    return `✅ 已为玩家 ${playerId} 发放 ${amount} ${this.config.currencyName}`;
  }

  async staffRedeemCode(sender: Sender, rawCode: string, rawPresentId: string): Promise<string> {
    const code = cleanText(rawCode);
    const presentId = cleanText(rawPresentId);
    if (!code || !presentId) return commandUsage("staff_redeem_code");
    const denied = this.staffDenied(sender);
    if (denied) return denied;
    const result = (await this.client.createStaffRedeemCode?.({
      code,
      presentId,
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
    })) as UncheckedRecord;
    const redeemCode = result?.redeemCode?.code ?? code;
    return `成功生成 1 个兑换码:\n${redeemCode}`;
  }

  async staffCheckout(sender: Sender, rawPlayerId: string): Promise<string> {
    const playerId = cleanText(rawPlayerId);
    if (!playerId) return commandUsage("staff_checkout");
    const denied = this.staffDenied(sender);
    if (denied) return denied;
    const result = (await this.client.staffCheckout?.(playerId)) as UncheckedRecord;
    const settlement = result?.settlement ?? {};
    return `\n✅ 已为用户 ${playerId} 退场\n消费: ${formatNumber(settlement?.total ?? 0)} ${this.config.currencyName}`;
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

  private async power(sender: Sender, deviceId: string, state: string): Promise<string> {
    await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
      type: state === "on" ? "power.on" : "power.off",
      target: { kind: "facility", id: deviceId },
      payload: { state },
    });
    if (state === "on") return `✅ ${deviceId} 启动成功`;
    if (deviceId === "all") return `🛑 全部机器关闭成功`;
    return `🛑 ${deviceId} 关闭成功`;
  }

  private async resolvePlatformName(subject: string): Promise<string | null> {
    if (!this.config.resolveDisplayName) return null;
    try {
      return (await this.config.resolveDisplayName(subject)) ?? null;
    } catch {
      return null;
    }
  }

  private mahjongTableForPlayer(playerId: string): string | null {
    for (const [tableId, state] of this.mahjongTables) {
      if (state.activeSessions[playerId]) return tableId;
      if (state.waiting.some((seat) => seat.playerId === playerId)) return tableId;
    }
    return null;
  }

  private mahjongTableConfigs(): Map<string, MahjongTableConfig> {
    return parseMahjongTables(this.config.mahjongTables ?? "", this.config.mahjongLabelPrefix ?? "麻将桌");
  }

  private async resolvePlayer(sender: Sender): Promise<UncheckedRecord> {
    return (await this.client.resolveOrRegisterIdentity(this.identity(sender))) as UncheckedRecord;
  }

  private identity(sender: Sender): IdentityInput {
    return {
      provider: this.config.provider,
      subject: sender.id,
      autoRegister: this.config.autoRegister,
      displayName: sender.name || `${this.config.provider.toUpperCase()} ${sender.id}`,
    };
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

  private formatCheckoutPreview(
    result: UncheckedRecord,
    sender: Sender | null,
    title = "【结算账单】",
  ): string {
    if (result?.billing && result?.session) {
      return formatLegacyBilling(result, this.config.currencyName);
    }
    const currency = this.config.currencyName;
    const preview = result?.settlementPreview ?? result?.settlement ?? {};
    const playerId = preview?.playerId ?? "";
    const subtotal = firstDefined(preview, "subtotal", "originalCost", 0);
    const total = firstDefined(preview, "total", "finalCost", "amount", subtotal);
    const previewedAt = parseDateTime(preview?.previewedAt);
    let sessionPreviews = (result?.sessionPreviews ?? []) as UncheckedRecord[];
    if (sessionPreviews.length === 0 && (result?.chargeItems || result?.session)) {
      const session = result?.session ?? {};
      sessionPreviews = [
        {
          sessionId: session?.id ?? session?.sessionId,
          label: session?.label ?? "计时区间",
          startedAt: firstDefined(session, "startedAt", "createdAt"),
          endedAt: firstDefined(preview, "endedAt", "settledAt", "endTime"),
          status: session?.status ?? "active",
          subtotal,
          total,
          chargeItems: result?.chargeItems ?? [],
          adjustments: [],
        },
      ];
    }
    const adjustments = result?.adjustments ?? [];
    const assetHoldings = result?.assetHoldings ?? [];
    const lines: string[] = [];

    const headerParts: string[] = [title];
    if (playerId) {
      const identitySuffix = sender ? `（${this.config.provider.toUpperCase()}：${sender.id}）` : "";
      headerParts.push(`玩家ID：${playerId}${identitySuffix}`);
    } else if (sender) {
      headerParts.push(`玩家：${sender.name || sender.id}（${this.config.provider.toUpperCase()}：${sender.id}）`);
    }
    lines.push(headerParts.join("\n"));

    const validStarts = sessionPreviews.map((s) => parseDateTime(s?.startedAt)).filter(Boolean) as Date[];
    const validEnds = sessionPreviews.map((s) => sessionDisplayEnd(s, previewedAt)).filter(Boolean) as Date[];
    if (validStarts.length > 0) {
      const overallStart = minDate(validStarts);
      const overallEnd = validEnds.length > 0 ? maxDate(validEnds) : now(this.config);
      lines.push(`⏰全场到店时段：${formatHM(overallStart)}–${formatHM(overallEnd)}`);
    }
    lines.push("");

    for (const sPrev of sessionPreviews) {
      const label = sPrev?.label || "计时区间";
      const startDt = parseDateTime(sPrev?.startedAt);
      const endDt = sessionDisplayEnd(sPrev, previewedAt);
      const status = sPrev?.status ?? "active";
      const sTotal = toNumber(sPrev?.total ?? 0);
      lines.push(label);
      if (startDt && endDt) {
        lines.push(
          `游玩时段：${formatHM(startDt)}-${formatHM(endDt)}`,
        );
        lines.push(
          `游玩时长：${formatDurationValue(Math.floor((endDt.getTime() - startDt.getTime()) / 60_000))}　｜　消费：${formatNumber(sTotal)}${currency}`,
        );
      } else if (startDt) {
        lines.push(`入场：${formatHM(startDt)}  （${status === "active" ? "计费中" : "已关闭"}）`);
      }
      lines.push("");
    }
    lines.push("————————————");

    const balanceParts: string[] = [];
    for (const holding of assetHoldings) {
      const qty = toNumber(holding?.quantity ?? 0);
      const code = String(holding?.assetCode ?? "").toLowerCase();
      if (code.includes("paid") || code.includes("free") || code.includes("currency")) {
        balanceParts.push(`${formatNumber(qty)}${currency}`);
      }
    }
    if (balanceParts.length > 0) lines.push(`扣款后余额：${balanceParts.join("＋")}`);
    lines.push(`计费总价：${formatNumber(subtotal)}${currency}`);

    const hasDiscount = adjustments.some((adj: UncheckedRecord) => {
      const amount = toNumber(firstDefined(adj ?? {}, "amount", "saved", 0));
      return amount !== 0;
    });
    if (hasDiscount) lines.push(`优惠后价格：${formatNumber(total)}${currency}`);

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

export function parseMahjongTables(value: string, labelPrefix: string): Map<string, MahjongTableConfig> {
  const tables = new Map<string, MahjongTableConfig>();
  for (const item of value.replace(/\n/g, ";").split(";")) {
    const text = item.trim();
    if (!text) continue;
    let aliasPart: string;
    let rest: string;
    let displayName = "";
    if (text.includes(":")) {
      [aliasPart, rest] = splitOnce(text, ":");
      if (!rest.includes("=")) continue;
      [displayName, rest] = splitOnce(rest, "=");
      displayName = displayName.trim();
    } else {
      if (!text.includes("=")) continue;
      [aliasPart, rest] = splitOnce(text, "=");
    }
    const aliases = aliasPart.split(",").map((a) => a.trim()).filter(Boolean);
    const pricingConfigIds = rest.split("+").map((p) => p.trim()).filter(Boolean);
    if (aliases.length === 0 || pricingConfigIds.length === 0) continue;
    const tableId = aliases[0];
    const config: MahjongTableConfig = {
      tableId,
      displayName,
      aliases,
      pricingConfigIds,
    };
    for (const alias of aliases) tables.set(alias, config);
  }
  return tables;
}

function splitOnce(text: string, sep: string): [string, string] {
  const idx = text.indexOf(sep);
  if (idx === -1) return [text, ""];
  return [text.slice(0, idx), text.slice(idx + sep.length)];
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

function extractRows(value: any): UncheckedRecord[] {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === "object");
  if (!value || typeof value !== "object") return [];
  for (const key of ["holdings", "assets", "items", "wallet", "sessions"]) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows.filter((row) => row && typeof row === "object");
  }
  return [];
}

function rowQuantity(row: UncheckedRecord): number {
  return toNumber(firstDefined(row, "quantity", "amount", "count", 0));
}

function holdingName(row: UncheckedRecord): string {
  return (
    row.name ||
    row.assetName ||
    assetName(row) ||
    row.assetCode ||
    row.type ||
    "资产"
  );
}

function assetName(row: UncheckedRecord): string {
  const asset = row?.asset;
  if (asset && typeof asset === "object") {
    return asset.name || asset.code || "";
  }
  return row.assetName || row.name || row.assetCode || "资产";
}

function isPaidBalance(row: UncheckedRecord): boolean {
  const value = `${row?.assetCode ?? ""} ${row?.assetName ?? ""} ${row?.type ?? ""}`.toLowerCase();
  return value.includes("paid") || value.includes("充值");
}

function isFreeBalance(row: UncheckedRecord): boolean {
  const value = `${row?.assetCode ?? ""} ${row?.assetName ?? ""} ${row?.type ?? ""}`.toLowerCase();
  return value.includes("free") || value.includes("免费") || value.includes("赠送");
}

function firstDefined(mapping: any, ...keys: any[]): any {
  const last = keys[keys.length - 1];
  let keyList = keys;
  let fallback: any = undefined;
  if (typeof last !== "string") {
    fallback = last;
    keyList = keys.slice(0, -1);
  }
  for (const key of keyList) {
    if (mapping && typeof mapping === "object" && key in mapping && mapping[key] != null) return mapping[key];
  }
  return fallback;
}

function formatInventoryItem(row: UncheckedRecord): string {
  let line = `- ${holdingName(row)} (x${formatNumber(rowQuantity(row))})`;
  const expiresAt = row?.expireAt ?? row?.expiresAt;
  if (expiresAt) line += `\n  到期: ${formatDateTime(expiresAt)}`;
  return line;
}

function formatRedeemedItem(row: UncheckedRecord): string {
  let name = holdingName(row);
  const assetType = row?.assetType ?? row?.asset?.type;
  const durationMs = row?.durationMs;
  if (assetType === "PASS" && durationMs) {
    const days = Math.floor(toNumber(durationMs) / (1000 * 60 * 60 * 24));
    if (days > 0) name += ` (${days}天)`;
  }
  return `- ${name} x${formatNumber(rowQuantity(row))}`;
}

function formatWallet(result: any, currency: string): string {
  if (result && typeof result.total === "object") {
    return formatLegacyWallet(result, currency);
  }
  const rows = extractRows(result?.wallet ?? result);
  const paid = rows.filter(isPaidBalance).reduce((acc, row) => acc + rowQuantity(row), 0);
  const free = rows.filter(isFreeBalance).reduce((acc, row) => acc + rowQuantity(row), 0);
  const other = rows
    .filter((row) => !isPaidBalance(row) && !isFreeBalance(row))
    .reduce((acc, row) => acc + rowQuantity(row), 0);
  const total = paid + free + other;
  return [
    "💰 --- 钱包余额 ---",
    `可用: ${formatNumber(total)} ${currency} (共 ${formatNumber(total)})`,
    `  - 付费: ${formatNumber(paid)}`,
    `  - 免费: ${formatNumber(free)}`,
  ].join("\n");
}

function formatLegacyWallet(result: any, currency: string): string {
  const totalInfo = result?.total ?? {};
  const paidInfo = result?.paid ?? {};
  const freeInfo = result?.free ?? {};
  const available = firstDefined(totalInfo, "available", 0);
  const allBalance = firstDefined(totalInfo, "all", available);
  const paid = firstDefined(paidInfo, "available", 0);
  const free = firstDefined(freeInfo, "available", 0);

  const lines = [
    "💰 --- 钱包余额 ---",
    `可用: ${formatNumber(available)} ${currency} (共 ${formatNumber(allBalance)})`,
    `  - 付费: ${formatNumber(paid)}`,
    `  - 免费: ${formatNumber(free)}`,
  ];

  const unavailable = toNumber(allBalance) - toNumber(available);
  if (unavailable > 0) {
    lines.push(`\n您还有 ${formatNumber(unavailable)} ${currency}未到可用时间。`);
  }

  const expiringFree = availableDetails(freeInfo).filter((item) => item.expireAt);
  expiringFree.sort((a, b) => (parseDateTime(a.expireAt)?.getTime() ?? 0) - (parseDateTime(b.expireAt)?.getTime() ?? 0));
  if (expiringFree.length > 0) {
    const soonest = expiringFree[0];
    lines.push(`\n注意：您有 ${formatNumber(soonest.count ?? 0)} 免费${currency}将于 ${formatDateTime(soonest.expireAt)} 过期。`);
  }

  const passes = availableDetails(result?.passes);
  if (passes.length > 0) {
    lines.push(`\n--- 可用月卡 (${passes.length}) ---`);
    for (const item of passes) {
      lines.push(`- ${assetName(item)}`);
      lines.push(`  到期: ${formatDateTime(item?.expireAt ?? item?.expiresAt)}`);
    }
  }

  const tickets = availableDetails(result?.tickets);
  if (tickets.length > 0) {
    lines.push(`\n--- 可用优惠券 (${tickets.length}) ---`);
    for (const item of tickets) {
      lines.push(`- ${assetName(item)} (x${formatNumber(item?.count ?? rowQuantity(item))})`);
      lines.push(`  到期: ${formatDateTime(item?.expireAt ?? item?.expiresAt)}`);
    }
  }
  return lines.join("\n");
}

function availableDetails(value: any): UncheckedRecord[] {
  const details = value?.details ?? {};
  const rows = details?.available ?? [];
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
}

function formatHistory(result: any, currency: string): string {
  const sessions = extractRows(result?.sessions ?? result);
  if (sessions.length === 0) return "暂无历史记录";
  const lines = [`📜 最近 ${sessions.length} 条记录:`];
  for (const session of sessions) {
    const sessionId = firstDefined(session, "id", "sessionId", "");
    const start = formatDateTime(firstDefined(session, "createdAt", "startedAt", "startTime"));
    const endRaw = firstDefined(session, "closedAt", "endedAt", "endTime");
    const end = endRaw ? formatDateTime(endRaw) : "进行中";
    const finalCost = firstDefined(session, "finalCost", "total");
    const cost = finalCost == null ? "未结算" : `${formatNumber(finalCost)} ${currency}`;
    lines.push(`- [${sessionId}] ${start} -> ${end} (${cost})`);
  }
  return lines.join("\n");
}

function formatLegacyBilling(result: any, currency: string): string {
  const billing = result?.billing ?? {};
  const session = result?.session ?? {};
  const discount = result?.discount;
  const wallet = result?.wallet ?? {};
  const lines: string[] = ["--- 账单详情 ---"];
  const start = session.createdAt;
  const end = billing.endTime;
  lines.push(`入场: ${formatDateTime(start)}`);
  lines.push(`结算: ${formatDateTime(end)}`);
  lines.push(`时长: ${formatDurationMinutes(start, end)}`);
  lines.push("---");
  const originalCost = discount ? discount.originalCost : billing.totalCost ?? 0;
  let finalCost = discount ? discount.finalCost : billing.totalCost ?? 0;
  if (session.costOverwrite) finalCost = session.costOverwrite;
  lines.push(`计费价: ${formatNumber(originalCost)} ${currency}`);
  if (discount) {
    for (const log of discount.appliedLogs ?? []) {
      lines.push(`  -「${log?.asset ?? ""}」: -${formatNumber(log?.saved ?? 0)} ${currency}`);
    }
  }
  lines.push(`结算价: ${formatNumber(finalCost)} ${currency}`);

  const walletTotal = wallet?.total ?? {};
  if (walletTotal.available != null) {
    const currentBalance = walletTotal.available ?? 0;
    lines.push("---");
    lines.push(`当前余额: ${formatNumber(currentBalance)} ${currency}`);
    lines.push(`扣款后: ${formatNumber(toNumber(currentBalance) - toNumber(finalCost))} ${currency}`);
  }
  lines.push("---");
  lines.push("计费区间:");
  const segments = billing.segments ?? [];
  if (segments.length === 0) {
    lines.push("  (无)");
  }
  for (const segment of segments) {
    if (toNumber(segment?.cost ?? 0) < 0) continue;
    lines.push(`- ${segment?.ruleName ?? ""}`);
    if (segment?.startTime && segment?.endTime) {
      lines.push(`  时段: ${formatTimeRange(segment.startTime, segment.endTime)}`);
    }
    lines.push(`  时长: ${formatDurationValue(segment?.durationMinutes ?? 0)}`);
    const capped = segment?.isCapped ? " (已封顶)" : "";
    lines.push(`  费用: ${formatNumber(segment?.cost ?? 0)} ${currency}${capped}`.trim());
  }

  const monthlyPass = (wallet?.passes?.details?.available ?? [null])[0];
  if (monthlyPass && monthlyPass?.expireAt) {
    lines.push("---");
    lines.push(`您的月卡将于 ${formatDateTime(monthlyPass.expireAt)} 到期。`);
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
