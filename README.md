# koishi-plugin-prism

[![npm](https://img.shields.io/npm/v/koishi-plugin-prism.svg)](https://www.npmjs.com/package/koishi-plugin-prism)

**koishi-plugin-prism** 是用于连接 **PRiSM Next** 计费与设备管理系统的 Koishi 机器人插件。它可以替代旧版 `plugin-prism-neo-koishi`，为玩家和店员提供便捷的群内与私聊机器人交互指令。

## 🌟 功能特性

* 🎮 **玩家入场与结算**：通过 `/login` 和 `/logout` 指令开启或结算计费场次，支持 `/入场` 别名。
* 💳 **账户钱包与资产管理**：支持查询钱包余额（`/wallet`）和持有的道具资产（`/items`）。
* 🀄 **麻将桌位集成**：包含 `/mahjong <tableId>` 以及便捷的 `/上桌` / `/下桌` 控制。
* 🔌 **硬件设备状态与电源管理**：可直接在聊天中查看设备状态（`/show`）、远程开启/关闭电源（`/on`、`/off`）、远程投币（`/coin`）和模拟刷卡（`/scan`）。
* 🎟️ **礼物兑换码**：使用 `/redeem <code>` 兑换系统发放的福利礼包。
* 🛠️ **管理员高级指令**：允许管理员在聊天中查看玩家（`/admin.players`）、创建新玩家账户（`/admin.create-player`）、充值余额（`/admin.grant-balance`）、手动结账（`/admin.checkout`）以及制作礼包兑换码（`/admin.redeem-code`）。

## ⚙️ 配置说明

在 Koishi WebUI 的插件配置页面中，填入以下选项：

| 配置项 | 类型 | 默认值 | 描述 |
| :--- | :---: | :---: | :--- |
| `baseUrl` | `string` | - | **必填**。PRiSM Next Server 的访问基准 URL（如 `https://prism-mmw.neri.moe`）。 |
| `integrationToken` | `string` | - | **必填**。从 PRiSM 网页后台生成的 Integration API 令牌。 |
| `provider` | `string` | `"qq"` | 当前绑定的账号提供商平台名称（如 `"qq"`，`"discord"`）。 |
| `autoRegister` | `boolean` | `true` | 当玩家未注册时，是否在首次操作（如入场/查钱包）时自动在 PRiSM 中创建新玩家。 |
| `loginPricingConfigIds` | `string[]` | `[]` | 默认入场计费规则 ID 列表。 |
| `loginSessionLabel` | `string` | `"音游区间"` | 默认入场会话的标签文本。后端会按该标签对同一玩家的活跃会话去重，重复入场会被拒绝并提示。留空则不启用去重。 |
| `defaultDoorDeviceId` | `string` | - | 默认门锁设备的 ID，用于开门指令。 |
| `defaultScanProvider` | `string` | `"aime"` | 默认模拟刷卡时的读卡器协议提供商（如 `"aime"`）。 |
| `currencyName` | `string` | `"金币"` | 账户货币在显示时的自定义单位名称。 |
| `resolveDisplayName` | `function` | - | 可选。自定义用于获取群内昵称作为玩家注册名的异步逻辑。 |
| `enableStaffCommands` | `boolean` | `false` | 是否开启管理员/店员的高级控制指令。 |
| `staffUserIds` | `string[]` | `[]` | 允许执行管理员指令的平台用户 ID（如 QQ 号）白名单。 |

## 📝 机器人指令列表

### 玩家指令
* `register` - 绑定或注册当前平台账号到 PRiSM 账户。
* `login` / `入场` - 开启当前玩家的计费场次。
* `logout` - 结算当前玩家的计费场次。
* `billing` - 预览当前玩家本场计费的消费费用。
* `wallet` - 查看当前玩家的钱包余额。
* `items` - 查看当前玩家持有的道具或资产。
* `list` - 查看当前在线/在店游玩玩家的列表。
* `show [deviceId]` - 查看设备电源与连接状态。
* `history` - 查看自己的历史游玩记录。
* `lock` - 发送开门指令。
* `on <deviceId>` - 请求启动指定设备电源。
* `off <deviceId|all>` - 请求关闭指定设备电源；传入 `all` 时关闭后台配置的所有 Home Assistant 设备。
* `coin <deviceId> [count]` - 请求向指定设备投币指定枚数。
* `scan <deviceId> <subject>` - 请求向设备发送模拟刷卡。
* `redeem <code>` - 兑换礼物码。
* `mahjong <tableId>` / `上桌 <tableId>` - 加入指定麻将桌。
* `下桌 <tableId>` - 离开指定麻将桌。

### 管理员指令 (需在白名单内并开启)
* `admin.players` - 列出系统内注册的所有玩家。
* `admin.create-player <displayName>` - 创建一个新的 PRiSM 玩家。
* `admin.grant-balance <playerId> <amount>` - 为指定玩家发放充值余额。
* `admin.redeem-code <code> <presentId>` - 快速创建单次使用的兑换码。
* `admin.checkout <playerId>` - 代替并强制为指定玩家结账。

## 🛠️ 本地开发与构建

1. 确保已安装 Node.js 和 `bun`。
2. 克隆本仓库：
   ```bash
   git clone https://github.com/nerimoe/koishi-plugin-prism.git
   cd koishi-plugin-prism
   ```
3. 安装依赖并执行编译：
   ```bash
   bun install
   bun run build
   ```
4. 运行单元测试：
   ```bash
   bun run test
   ```

## 📄 开源协议

[MIT License](LICENSE)
