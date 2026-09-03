# H3 Media Board for ComfyUI

一个媒体收集节点和一个拆分输出节点：

- `H3 Media Board (9 Image / 3 Audio / 3 Video)`：9 张图、3 段音频、3 个视频、提示词，以及内嵌的 H3 时长、画幅、百万像素与倍数设置。可选择自动计算对齐帧数，或关闭后手动输入帧数；还可设置固定、每次排队随机或复用上次的 Noise 种子。
- `H3 Media Board Outputs`：接收上方节点唯一的 `media_board` 输出，提供参考图片、视频帧批次、视频音频、音频、提示词、`duration`、`width`、`height`、`frames`，以及可直接连接 `SamplerCustomAdvanced` 的 `noise` 输出；未放入媒体的位置返回空值，前端会标记为未激活。
- `获取 H3mb 内置变量`：无需从主节点拉长连线。下拉选择 `H3mb_noise`、`H3mb_upscale_factor`、`H3mb_video_name`、`H3mb_scheduler_steps`、`H3mb_high_frequency_sigmas` 或 `H3mb_sampler`，输出口会同步切换名称和类型，并在排队时读取同一工作流中的 H3 Media Board 当前值。
- `H3 条件与 Latent 切换`：同时接入 H3 图文/图生节点与 H3 多参参考节点各自的“正向条件 + Latent”。开关打开时仅执行并输出图文/图生分支，关闭时仅执行并输出多参参考分支；未选中的 H3 分支及其上游媒体拆分会被懒执行机制跳过。`external_switch` 接口可由上游布尔节点控制，并优先于本地开关。
- `H3 生视频模式控制`：紧凑的图文／图生、 多参参考双态控制节点。除“模式开关”外，它还提供 `media_board` 输入和原样转发的 `media_board` 输出；将其“模式开关”输出接到 **H3 条件与 Latent 切换** 的 `external_switch`，即可统一控制整套 H3 分支。
- `H3 二采准备（高分条件 / 注入帧）`：接收二采前已放大并重新合并的 H3 AV latent，自动按它的最终尺寸重建图文或多参条件，并输出专用的二采条件与 latent。接入图片、帧串或音频后会自动展开下一组时间点；最多 12 组，可在一个节点内完成多段关键帧／声音注入。
- `H3 多时间点引导帧`：原生 `Add Guide for MiniMax H3` 的多组版本。接收已有的 `positive + latent`，每组可在独立 `frame_idx` 注入图片、帧串和/或音频；接入一组后自动展开下一组，最多 12 组。
- `稳定版多 LoRA 加载器`：最多 16 条 LoRA 的固定序列加载器。将第一个节点的“LoRA 配置同步”输出接到第二个节点同名输入后，第二个节点会完全沿用第一个节点的 LoRA 数量、文件、模型强度、CLIP 强度和绕过状态；下游本地控件会灰显，断开连线后自动恢复原配置。

## 安装

将整个 `ComfyUI-H3-Media-Board` 文件夹复制到：

`ComfyUI/custom_nodes/ComfyUI-H3-Media-Board`

完全重启 ComfyUI，再在菜单的 `H3 / Media` 分类中添加节点。

## 使用方式

1. 添加 **H3 Media Board**，点击空卡片上传文件。
2. 图片双击可放大预览；音频与视频卡片内有原生播放控件；每个已有媒体可替换或删除。
3. 删除后使用连续编号，例如删除图片 2，原图片 3 会成为图片 2。
4. 将唯一的 `media_board` 输出连接到 **H3 Media Board Outputs**。
5. 将实际有内容的媒体输出连接到后续生成节点；`prompt`、`duration`、`width`、`height`、`frames` 可直接接入 H3 工作流对应插口，`noise` 可接到 `SamplerCustomAdvanced` 的 noise 输入。
6. 需要在图文/图生与多参参考两套 H3 条件之间切换时，添加 **H3 条件与 Latent 切换**。两组条件与 Latent 会成对切换，避免条件和 Latent 混接。
7. 需要把模式选择独立放在工作流中时，使用 **H3 生视频模式控制**；其输出接到上一步节点的 `external_switch`。
8. 二次采样时，将 **LTXVConcatAVLatent** 的 latent 接到 **H3 二采准备**，再将其“二采正向条件”接新建的 `BasicGuider`，其“二采 latent”接二采采样器。每接入一组注入图片/帧串或音频，会自动显示下一组及对应的 `frame_idx`。
9. 若只需要给任意 H3 正向条件叠加多段关键帧／声音，不必使用二采准备；改用 **H3 多时间点引导帧**。将它的 `positive` 输出继续接到 `BasicGuider` 或下一个 H3 引导节点。

上传的文件保存在 `ComfyUI/input/h3_media_board/`，工作流保存的是相对路径。

## 注意

- 图片输出是 ComfyUI 的 `IMAGE` 张量。
- 视频输出会解码为 ComfyUI `IMAGE` 帧批次，能接 H3 的参考视频图像输入；视频音轨和独立音频输出为 ComfyUI `AUDIO`。
- 来源节点固定为三列媒体卡片宽度，只允许纵向扩展；提示词编辑区随高度扩展。
