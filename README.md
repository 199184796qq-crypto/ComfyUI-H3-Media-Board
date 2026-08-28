# H3 Media Board for ComfyUI

一个媒体收集节点和一个拆分输出节点：

- `H3 Media Board (9 Image / 3 Audio / 3 Video)`：9 张图、3 段音频、3 个视频、提示词，以及内嵌的 H3 时长、画幅、百万像素与倍数设置。可选择自动计算对齐帧数，或关闭后手动输入帧数。
- `H3 Media Board Outputs`：接收上方节点唯一的 `media_board` 输出，提供参考图片、视频帧批次、视频音频、音频、提示词，以及 `duration`、`width`、`height`、`frames` 参数输出；未放入媒体的位置返回空值，前端会标记为未激活。

## 安装

将整个 `ComfyUI-H3-Media-Board` 文件夹复制到：

`ComfyUI/custom_nodes/ComfyUI-H3-Media-Board`

完全重启 ComfyUI，再在菜单的 `H3 / Media` 分类中添加节点。

## 使用方式

1. 添加 **H3 Media Board**，点击空卡片上传文件。
2. 图片双击可放大预览；音频与视频卡片内有原生播放控件；每个已有媒体可替换或删除。
3. 删除后使用连续编号，例如删除图片 2，原图片 3 会成为图片 2。
4. 将唯一的 `media_board` 输出连接到 **H3 Media Board Outputs**。
5. 将实际有内容的媒体输出连接到后续生成节点；`prompt`、`duration`、`width`、`height`、`frames` 可直接接入 H3 工作流对应插口。

上传的文件保存在 `ComfyUI/input/h3_media_board/`，工作流保存的是相对路径。

## 注意

- 图片输出是 ComfyUI 的 `IMAGE` 张量。
- 视频输出会解码为 ComfyUI `IMAGE` 帧批次，能接 H3 的参考视频图像输入；视频音轨和独立音频输出为 ComfyUI `AUDIO`。
- 来源节点固定为三列媒体卡片宽度，只允许纵向扩展；提示词编辑区随高度扩展。
