# koishi-plugin-w-squad

[![npm](https://img.shields.io/npm/v/koishi-plugin-w-squad?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-w-squad)

WillBot: Squad function

内置 `zh-CN` 和 `en-US` 本地化，命令说明、选项、响应、校验错误和免打扰规则解释会跟随 Koishi 会话语言。

## 小队标识

每个小队使用创建时随机生成的 8 位 ID，并以 `名称#ID` 的形式显示。命令中可以使用小队名称、`#ID` 或完整的 `名称#ID`；其中 ID 与名称无关，小队改名后保持不变。

公开查询可以按公开小队名称查找。其他操作按名称查找时，只会在当前用户已加入的小队中匹配；接受或拒绝邀请时，则只在本人收到邀请的小队中匹配。如果有多个可见的同名小队，命令会提示改用 `#ID`。

## 从 v1 迁移

首次启动此版本时，插件会将 `w-squad`、`w-squad-member` 和 `w-squad-invitation` 中的数据复制到对应的 `-v2` 表，并在校验关联数据后写入迁移完成标记。旧表不会被修改或删除，可用于人工核对和紧急回退；但 v2 启用后的更改不会回写旧表，回退时需要人工处理这部分差异。

迁移是幂等的，意外中断后可以再次启动继续执行。第一次升级期间不要让旧版和新版机器人实例同时写入同一个数据库；迁移完成后，插件只读写 v2 表，旧版实例的新数据不会自动同步。
