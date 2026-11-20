# Themes

主题相关文件全部放在 `plugins/themes/`。

```text
plugins/themes/
  README.md
  templates/theme.json   ← 模板，不会被自动加载
  *.json                 ← 用户主题包
```

把主题 JSON 放在本目录（不要放进 `templates/`），回到游戏的「主题设置」重新进入主题菜单即可看到。

要求：

- 扩展名 `.json`
- 一个文件一个主题
- 单个文件不超过 64KB
- 只接受数据，不执行脚本
- 颜色必须是 `#rrggbb`

模板见：

```text
plugins/themes/templates/theme.json
```

## 字段

- `id`：2~24 位小写字母/数字/连字符，不能和内置主题重复
- `label`：主题菜单显示名
- `tone`：`dark` 或 `light`，影响鱼标签、水面和爱心配色
- `shell.background`：外壳底色
- `shell.menu`：菜单底色、边框、文字、强调色（可省略）
- `shell.tag`：鱼头标签边框（可省略）
- `scene.palette`：实体调色板，可只写部分实体

主题包不控制效果；扫描线等效果在游戏内独立开关。

## 实体调色板

当前可用 key：

```text
fish / crab / plants / bubbles / pellets / dust / sand / hearts
```

新增生物类型后，主题包可以在 `scene.palette` 里继续增加同名 key；未知 key 会被忽略。
