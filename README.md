# koishi-plugin-prism

[![npm](https://img.shields.io/npm/v/koishi-plugin-prism.svg)](https://www.npmjs.com/package/koishi-plugin-prism)

**koishi-plugin-prism** 是用于连接 **PRiSM Next** 计费与设备管理系统的 Koishi 机器人插件。它可以替代旧版 `plugin-prism-neo-koishi`，为玩家和店员提供便捷的群内与私聊机器人交互指令。

## 🌟 功能特性

* 🎮 **玩家入场与结算**：通过 `/login` 和 `/logout` 指令开启或结算计费场次，支持 `/入场` 别名；命令回复会引用触发消息，结账账单可私聊通知管理员与指定用户。
* 💳 **账户钱包与资产管理**：支持查询钱包余额（`/wallet`）和持有的道具资产（`/items`）。
* 🀄 **麻将桌位集成**：包含 `/mahjong <tableId>` 以及便捷的 `/上桌` / `/下桌` 控制。`上桌` 仅允许已通过 `login`/`入场` 开启默认入场会话的玩家使用。`list` 按 session 标签分组：有非音乐游戏 session 的玩家归入最新的非音乐标签，纯音乐玩家归入音乐标签；麻将桌额外显示当前人数和容量。已开局桌位会从后端活跃 session 自动恢复，未满桌候座仍由机器人进程暂存，重启后不会保留。
* 🔌 **硬件设备状态与电源管理**：可直接在聊天中查看设备状态（`/show`）、远程开启/关闭电源（`/on`、`/off`）、远程投币（`/coin`）和模拟刷卡（`/scan`）。
* 🎟️ **礼物兑换码**：使用 `/redeem <code>` 兑换系统发放的福利礼包。
* 🛠️ **管理员快捷指令**：允许管理员为指定平台用户增加或扣除余额，并覆盖结账金额后立即结账。

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
| `enableStaffCommands` | `boolean` | `false` | 是否开启管理员快捷指令。 |
| `staffUserIds` | `string[]` | `[]` | 允许执行管理员快捷指令的平台用户 ID（如 QQ 号）白名单。空列表不授予目标用户操作权限。 |
| `logoutNotifyUserIds` | `string[]` | `[]` | 结账成功后额外私聊完整账单的平台用户 ID。通知收件人为该列表与 `staffUserIds` 的去重并集。 |

管理员快捷指令必须同时配置 `enableStaffCommands: true` 与 `staffUserIds`。它们使用现有 `integrationToken` 调用受限的余额调整和立即结账接口；目标用户参数使用 Koishi 的 `user` 选择器，只有白名单内的管理员可以操作其他用户。

## 📝 机器人指令列表

### 玩家指令
* `register` - 绑定或注册当前平台账号到 PRiSM 账户。
* `login` / `入场` - 开启当前玩家的计费场次。
* `logout` - 结算当前玩家的计费场次。
玩家在未产生任何费用时退场，机器人会简洁显示“本次未产生费用”和当前余额；存在收费或优惠明细时仍显示完整结算账单。
结账成功后，机器人会向 `staffUserIds` 与 `logoutNotifyUserIds` 中的用户私聊同一份账单，账单会明确显示结账玩家身份。
* `billing` - 预览当前玩家本场计费的消费费用。
* `wallet` - 查看当前玩家的钱包余额。
* `items` - 查看当前玩家持有的道具或资产。
* `list` - 查看当前在线/在店游玩玩家的列表，按 session 标签分组并对同一玩家去重；存在非音乐游戏 session 时取最新的非音乐标签，麻将桌显示当前人数和容量。已开局桌位由后端 session 恢复；未满桌候座由机器人进程暂存，机器人重启后不会保留。
* `show [deviceId]` - 查看设备电源与连接状态。
* `history` - 查看自己的历史游玩记录。
* `lock` - 发送开门指令。
* `on <deviceId>` - 请求启动指定设备电源。
* `off <deviceId>` - 请求关闭指定设备电源。
* `coin <deviceId> [count]` - 请求向指定设备投币指定枚数。
* `scan <deviceId> <subject>` - 请求向设备发送模拟刷卡。
* `redeem <code>` - 兑换礼物码。
* `mahjong <tableId>` / `上桌 <tableId>` - 加入指定麻将桌；仅允许已通过 `login`/`入场` 开启默认入场会话的玩家使用。
* `下桌 <tableId>` - 离开指定麻将桌。

### 管理员快捷指令
启用 `enableStaffCommands`、配置 `staffUserIds` 白名单与 `staffSessionToken` 后可使用：
* `add <target:user> <amount:number>` - 为目标用户增加余额。
* `del <target:user> <amount:number>` - 从目标用户扣除余额。
* `overwrite <target:user> <amount:number> [reason:text]` - 覆盖目标用户本次结账金额，并立即执行结账；未填写原因时使用默认管理员调价原因。

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
