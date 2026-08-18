# H3 Studio

MiniMax H3 单机一体化创作界面。管理页面、任务服务、ComfyUI 与服务器云盘按部署在同一台服务器设计，不使用 SSH 中转。

## 已实现

- 极简对话式视频生成界面
- 点击、拖拽、剪贴板粘贴添加图片、视频和音频素材
- H3 本地 768P；16:9、9:16、1:1、4:3、3:4、21:9；5–15 秒；原生音频开关
- 生成任务真实提交到 ComfyUI，不伪造完成状态
- 任务队列持久化，服务重启后自动恢复追踪
- 生成完成后的双栏沉浸预览
- 服务器云盘真实目录浏览、上传、新建文件夹和下载
- 上传临时文件与原子落盘，避免生成残缺文件
- 健康检查、请求编号、结构化日志、优雅退出
- 统一弹窗、Toast、面板切换和沉浸预览动效
- systemd 常驻与异常自动重启配置
- 可视化一站式环境接入与大屏实例终端
- 受控的 ComfyUI 启动、重启、停止和日志命令
- H3 服务启动及“环境部署”页面打开时自动拉起 ComfyUI

## 本地运行

```bash
npm install
npm run start
```

正式部署服务监听：`0.0.0.0:12233`，访问地址使用服务器 IP 或域名，例如 `http://服务器IP:12233`。

ComfyUI 只在服务器内部监听 `127.0.0.1:12234`，由 H3 Studio 转发调用，不建议直接开放到公网。

如果服务器启用了 UFW，需要放行 H3 端口：

```bash
sudo ufw allow 12233/tcp
```

更安全的生产方式是让 Nginx/Caddy 代理到 `127.0.0.1:12233`，公网只开放 80/443。

开发时分别运行：

```bash
npm run server
npm run dev
```

开发页面：`http://127.0.0.1:3000`

## 接入已有 ComfyUI

1. 在 ComfyUI 中打开已经调通的 H3 工作流。
2. 导出 API 格式工作流。
3. 按 [workflows/README.md](workflows/README.md) 替换需要动态控制的值。
4. 保存为 `workflows/h3-api.json`，或设置 `H3_WORKFLOW_PATH`。

默认连接 `http://127.0.0.1:12234`。可用环境变量覆盖：

你的 ComfyUI 启动服务也需要监听 `12234`，例如启动参数使用 `--port 12234`；否则 H3 页面会显示 ComfyUI 未连接。

```bash
COMFYUI_URL=http://127.0.0.1:12234 \
H3_WORKFLOW_PATH=/opt/h3-studio/workflows/h3-api.json \
npm run start
```

本项目只接本地 768P，不实现依赖官方 API 的 2K 路径。

## 稳定运行

运行数据分别保存在：

- `server-storage`：素材、模型缓存和生成结果
- `data/generations.json`：持久化任务状态
- `data/environment.json`：首次找到或自动启动 ComfyUI 后保存的连接地址与服务配置，重启后自动复用
- `logs/h3-YYYY-MM-DD.log`：JSON 行格式运行日志

健康检查：`GET /api/health`

服务器部署可使用 [deploy/h3-studio.service](deploy/h3-studio.service)。先按实际用户和目录修改文件，再安装：

```bash
sudo install -d -o h3studio -g h3studio /data/h3-studio /var/lib/h3-studio /var/log/h3-studio
sudo install -m 0440 deploy/h3-studio-sudoers /etc/sudoers.d/h3-studio
sudo cp deploy/h3-studio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now h3-studio
```

查看状态：

```bash
systemctl status h3-studio
journalctl -u h3-studio -f
```

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `H3_HOST` | `0.0.0.0` | 监听地址 |
| `H3_PORT` | `12233` | 页面与接口端口 |
| `COMFYUI_URL` | `http://127.0.0.1:12234` | 本机 ComfyUI 地址 |
| `H3_WORKFLOW_PATH` | `workflows/h3-api.json` | H3 API 工作流 |
| `H3_STORAGE_ROOT` | `server-storage` | 服务器云盘目录 |
| `H3_DATA_ROOT` | `data` | 任务状态目录 |
| `H3_LOG_ROOT` | `logs` | 日志目录 |
| `H3_MAX_UPLOAD_BYTES` | `4294967296` | 单文件上传上限 |
| `COMFYUI_SERVICE_NAME` | `comfyui.service` | systemd 中的 ComfyUI 服务名 |
| `COMFYUI_SERVICE_SCOPE` | `system` | `system` 或 `user` 服务 |
| `H3_ALLOW_SERVICE_CONTROL` | 未启用 | 设为 `1` 后显示真实服务控制能力 |
| `H3_SERVICE_CONTROL_USE_SUDO` | 未启用 | 设为 `1` 后使用受限 sudoers 控制系统服务 |
| `H3_AUTO_START_COMFYUI` | `1` | H3 启动及环境页打开时自动启动 ComfyUI |
