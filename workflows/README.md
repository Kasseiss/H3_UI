# H3 工作流接入

在 ComfyUI 中打开已经调通的 H3 工作流，选择“导出（API 格式）”，保存为本目录下的 `h3-api.json`。

需要由界面动态控制的节点值，请在导出的 JSON 中替换为以下占位符：

- `{{PROMPT}}`：提示词
- `{{WIDTH}}` / `{{HEIGHT}}`：768P 对应尺寸
- `{{DURATION}}`：5–15 秒
- `{{FRAMES}}`：H3 对应帧数
- `{{SEED}}`：随机种子
- `{{AUDIO}}`：是否启用原生音频
- `{{IMAGE_1}}` 至 `{{IMAGE_9}}`：已上传到 ComfyUI 的图片文件名
- `{{VIDEO_1}}` 至 `{{VIDEO_3}}`：已上传到 ComfyUI 的视频文件名
- `{{AUDIO_1}}` 至 `{{AUDIO_3}}`：已上传到 ComfyUI 的音频文件名
- `{{REFERENCE_1}}` 起：按用户添加顺序排列的通用参考素材文件名

若工作流位于其他路径，可通过 `H3_WORKFLOW_PATH` 指定。界面不会调用 2K 官方 API。
