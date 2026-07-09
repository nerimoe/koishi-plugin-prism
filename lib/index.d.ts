import { Schema } from "koishi";
export declare const name = "prism";
export declare const Config: Schema<PrismKoishiPluginConfig>;
export declare function apply(ctx: any, config: PrismKoishiPluginConfig): void;
export declare class PrismBotClientError extends Error {
    readonly code: string;
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, code: string, status: number, body: unknown);
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
    logoutNotifyUserIds?: string[];
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
    baseUrl?: string;
    integrationToken?: string;
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
            getUser?(id: string): Promise<{
                name?: string;
            }>;
            broadcast?(userIds: string[], content: string): Promise<void>;
        };
    };
};
export declare function applyPrismKoishiPlugin(ctx: KoishiLikeContext, config: PrismKoishiPluginConfig): void;
export type Sender = {
    id: string;
    name: string;
};
export declare function humanReadableBotError(error: PrismBotClientError): string;
export declare function parseMahjongTables(value: string, labelPrefix: string): Map<string, MahjongTableConfig>;
declare const _default: {
    name: string;
    Config: Schema<PrismKoishiPluginConfig>;
    ConfigSchema: Schema<PrismKoishiPluginConfig>;
    apply: typeof apply;
};
export default _default;
