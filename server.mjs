import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { access, appendFile, mkdir, open, readFile, readdir, readlink, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const distRoot = path.join(projectRoot, 'dist')
const storageRoot = path.resolve(process.env.H3_STORAGE_ROOT || path.join(projectRoot, 'server-storage'))
const dataRoot = path.resolve(process.env.H3_DATA_ROOT || path.join(projectRoot, 'data'))
const logRoot = path.resolve(process.env.H3_LOG_ROOT || path.join(projectRoot, 'logs'))
const jobStorePath = path.join(dataRoot, 'generations.json')
const environmentConfigPath = path.join(dataRoot, 'environment.json')
const workflowPath = path.resolve(process.env.H3_WORKFLOW_PATH || path.join(projectRoot, 'workflows', 'h3-api.json'))
const port = Number(process.env.H3_PORT || 12233)
const host = process.env.H3_HOST || '0.0.0.0'
let savedEnvironmentConfig = {}
try {
  savedEnvironmentConfig = JSON.parse(await readFile(environmentConfigPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn(`环境配置读取失败: ${error.message}`)
}
const configuredComfyUrl = process.env.COMFYUI_URL || savedEnvironmentConfig.comfyUrl || 'http://127.0.0.1:12234'
const comfyUrlLocked = Boolean(process.env.COMFYUI_URL)
let comfyUrl = configuredComfyUrl.replace(/\/+$/, '')
const configuredServiceName = process.env.COMFYUI_SERVICE_NAME || savedEnvironmentConfig.comfyServiceName || 'comfyui.service'
const comfyServiceName = /^[a-zA-Z0-9_.@-]+$/.test(configuredServiceName) ? configuredServiceName : 'comfyui.service'
const configuredServiceScope = process.env.COMFYUI_SERVICE_SCOPE || savedEnvironmentConfig.comfyServiceScope || 'system'
const comfyServiceScope = configuredServiceScope === 'user' ? 'user' : 'system'
let comfyRoot = process.env.COMFYUI_ROOT || savedEnvironmentConfig.comfyRoot || ''
let comfyPython = process.env.COMFYUI_PYTHON || savedEnvironmentConfig.comfyPython || ''
let comfyStartScript = process.env.COMFYUI_START_SCRIPT || savedEnvironmentConfig.comfyStartScript || ''
let comfyLaunchMode = savedEnvironmentConfig.comfyLaunchMode || ''
let comfyManagedPid = Number(savedEnvironmentConfig.comfyManagedPid || 0) || 0
const serviceControlEnabled = process.env.H3_ALLOW_SERVICE_CONTROL === '1'
const serviceControlUseSudo = process.env.H3_SERVICE_CONTROL_USE_SUDO === '1'
const autoStartComfy = process.env.H3_AUTO_START_COMFYUI !== '0'
const maxUploadBytes = Number(process.env.H3_MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024)
const comfyManagerLogPath = path.join(logRoot, 'comfy-manager.log')
const startedAt = new Date().toISOString()

await Promise.all([storageRoot, dataRoot, logRoot].map((directory) => mkdir(directory, { recursive: true })))
await Promise.all(['上传素材', '生成结果', '模型缓存'].map((name) => mkdir(path.join(storageRoot, name), { recursive: true })))

const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.webp': 'image/webp',
}

const dimensions = {
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1': { width: 768, height: 768 },
  '4:3': { width: 1024, height: 768 },
  '3:4': { width: 768, height: 1024 },
  '21:9': { width: 1344, height: 576 },
}

let jobs = []
let persistChain = Promise.resolve()
let comfyControlChain = Promise.resolve()
let shuttingDown = false

async function log(level, event, details = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...details }
  const line = `${JSON.stringify(entry)}\n`
  if (level === 'error') console.error(line.trim())
  else console.log(line.trim())
  try {
    await appendFile(path.join(logRoot, `h3-${new Date().toISOString().slice(0, 10)}.log`), line, 'utf8')
  } catch (error) {
    console.error('日志写入失败', error)
  }
}

async function atomicWrite(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, value, 'utf8')
  await rename(temporary, target)
}

let environmentConfigChain = Promise.resolve()
function persistEnvironmentConfig(patch = {}) {
  savedEnvironmentConfig = { ...savedEnvironmentConfig, ...patch, updatedAt: new Date().toISOString() }
  environmentConfigChain = environmentConfigChain
    .catch(() => undefined)
    .then(() => atomicWrite(environmentConfigPath, JSON.stringify(savedEnvironmentConfig, null, 2)))
  return environmentConfigChain
}

async function rememberComfyConfig(source) {
  await persistEnvironmentConfig({
    comfyUrl,
    comfyServiceName,
    comfyServiceScope,
    comfyRoot: comfyRoot || null,
    comfyPython: comfyPython || null,
    comfyStartScript: comfyStartScript || null,
    comfyLaunchMode: comfyLaunchMode || null,
    comfyManagedPid: comfyManagedPid || null,
    source,
  })
}

function persistJobs() {
  persistChain = persistChain
    .catch(() => undefined)
    .then(() => atomicWrite(jobStorePath, JSON.stringify({ version: 1, jobs }, null, 2)))
  return persistChain
}

try {
  const stored = JSON.parse(await readFile(jobStorePath, 'utf8'))
  jobs = Array.isArray(stored.jobs) ? stored.jobs : []
  const now = new Date().toISOString()
  jobs = jobs.map((job) => ['queued', 'generating'].includes(job.status)
    ? { ...job, status: 'queued', updatedAt: now, note: '服务重启后已恢复监听' }
    : job)
  await persistJobs()
} catch (error) {
  if (error?.code !== 'ENOENT') await log('error', 'job_store_read_failed', { message: error.message })
  await persistJobs()
}

function setSecurityHeaders(res, requestId) {
  res.setHeader('X-Request-Id', requestId)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function safeResolve(root, relativePath = '') {
  const normalized = String(relativePath).replaceAll('\\', '/').replace(/^\/+/, '')
  const target = path.resolve(root, normalized)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('请求路径超出允许的目录')
  return target
}

function safeName(name) {
  const value = String(name || '').trim()
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('文件名不合法')
  }
  return value
}

function itemKind(entryName, isDirectory) {
  if (isDirectory) return 'folder'
  const ext = path.extname(entryName).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image'
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video'
  return 'file'
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new Error('JSON 内容不合法')
  }
}

async function listStorage(relativePath) {
  const directory = safeResolve(storageRoot, relativePath)
  const directoryStat = await stat(directory)
  if (!directoryStat.isDirectory()) throw new Error('目标不是文件夹')
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.'))
  const items = await Promise.all(entries.map(async (entry) => {
    const itemPath = path.join(directory, entry.name)
    const itemStat = await stat(itemPath)
    const relative = path.relative(storageRoot, itemPath).split(path.sep).join('/')
    return { id: relative, name: entry.name, path: relative, kind: itemKind(entry.name, entry.isDirectory()), size: entry.isDirectory() ? 0 : itemStat.size, modified: itemStat.mtime.toISOString() }
  }))
  items.sort((a, b) => a.kind === 'folder' && b.kind !== 'folder' ? -1 : a.kind !== 'folder' && b.kind === 'folder' ? 1 : b.modified.localeCompare(a.modified))
  const disk = await statfs(storageRoot)
  const total = Number(disk.blocks * disk.bsize)
  const free = Number(disk.bavail * disk.bsize)
  return { path: relativePath || '', items, storage: { total, free, used: Math.max(0, total - free) } }
}

async function probeComfyUrl(target, timeout = 1200) {
  const response = await fetch(`${target}/system_stats`, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`ComfyUI 状态异常 (${response.status})`)
  const data = await response.json()
  const device = Array.isArray(data.devices) ? data.devices[0] : undefined
  return { connected: true, url: target, device: device?.name || 'ComfyUI 运行中', vramTotal: device?.vram_total, vramFree: device?.vram_free }
}

function portFromArgs(args, fallback = 8188) {
  const inline = args.find((value) => value.startsWith('--port='))
  const index = args.indexOf('--port')
  const value = inline ? inline.slice(7) : index >= 0 ? args[index + 1] : fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

async function fileExists(target) {
  if (!target) return false
  try { return (await stat(target)).isFile() } catch { return false }
}

async function directoryExists(target) {
  if (!target) return false
  try { return (await stat(target)).isDirectory() } catch { return false }
}

async function inspectComfyProcesses() {
  if (process.platform !== 'linux') return []
  const matches = []
  let entries = []
  try { entries = await readdir('/proc', { withFileTypes: true }) } catch { return matches }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const args = (await readFile(`/proc/${entry.name}/cmdline`, 'utf8')).split('\0').filter(Boolean)
      const mainIndex = args.findIndex((value) => path.basename(value) === 'main.py')
      if (mainIndex < 0) continue
      const cwd = await readlink(`/proc/${entry.name}/cwd`)
      const root = path.dirname(path.resolve(cwd, args[mainIndex]))
      if (!await fileExists(path.join(root, 'main.py'))) continue
      matches.push({ pid: Number(entry.name), root, python: args[0], port: portFromArgs(args.slice(mainIndex + 1)) })
    } catch { /* process exited or is not readable */ }
  }
  return matches
}

function cleanShellValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '')
}

async function inspectStartScript(scriptPath) {
  if (!await fileExists(scriptPath)) return null
  try {
    const content = (await readFile(scriptPath, 'utf8')).slice(0, 128 * 1024)
    if (!/(^|[\s/])main\.py([\s]|$)/m.test(content)) return null
    const cdMatch = content.match(/^\s*cd\s+([^\n;&|]+)/m)
    const pythonMatch = content.match(/^\s*(?:PY|PYTHON)\s*=\s*([^\n]+)$/m)
    const portMatch = content.match(/--port(?:=|\s+)(\d+)/)
    const root = cdMatch ? path.resolve(path.dirname(scriptPath), cleanShellValue(cdMatch[1])) : ''
    const python = pythonMatch ? cleanShellValue(pythonMatch[1]) : ''
    return {
      script: path.resolve(scriptPath),
      root: await fileExists(path.join(root, 'main.py')) ? root : '',
      python: await fileExists(python) ? python : '',
      port: portMatch ? Number.parseInt(portMatch[1], 10) : 8188,
    }
  } catch { return null }
}

async function scanComfyLocations() {
  const roots = new Set([
    homedir(),
    path.dirname(projectRoot),
    '/opt',
    '/srv',
    '/workspace',
    '/app',
    ...String(process.env.H3_COMFYUI_SEARCH_ROOTS || '').split(path.delimiter),
  ].filter(Boolean).map((value) => path.resolve(value)))
  if (comfyRoot) roots.add(path.dirname(path.resolve(comfyRoot)))
  if (comfyStartScript) roots.add(path.dirname(path.resolve(comfyStartScript)))
  const ignored = new Set(['.cache', '.git', '.npm', '.conda', 'node_modules', 'models', 'output', 'input', 'temp', 'venv', '.venv'])
  const locations = { roots: [], scripts: [] }
  let visited = 0
  for (const searchRoot of roots) {
    if (!await directoryExists(searchRoot)) continue
    const queue = [{ directory: searchRoot, depth: 0 }]
    while (queue.length && visited < 4000) {
      const current = queue.shift()
      visited += 1
      let entries = []
      try { entries = await readdir(current.directory, { withFileTypes: true }) } catch { continue }
      if (entries.some((entry) => entry.isFile() && entry.name === 'main.py') && entries.some((entry) => entry.isDirectory() && entry.name === 'comfy')) {
        locations.roots.push(current.directory)
        continue
      }
      for (const entry of entries) {
        const target = path.join(current.directory, entry.name)
        if (entry.isFile() && /^(?:start[-_])?comfy(?:ui)?[^/]*\.(?:sh|bat|cmd)$/i.test(entry.name)) locations.scripts.push(target)
        if (entry.isDirectory() && current.depth < 4 && !ignored.has(entry.name) && !entry.name.startsWith('.')) queue.push({ directory: target, depth: current.depth + 1 })
      }
    }
  }
  return { roots: [...new Set(locations.roots)], scripts: [...new Set(locations.scripts)] }
}

async function discoverComfyEnvironment({ persist = true } = {}) {
  const processes = await inspectComfyProcesses()
  const urls = []
  for (const item of processes) urls.push(`http://127.0.0.1:${item.port}`)
  urls.push(comfyUrl)
  if (!comfyUrlLocked) {
    const discoveryPorts = String(process.env.H3_COMFYUI_DISCOVERY_PORTS || '8188,12234,30010,51250')
      .split(',').map((value) => Number.parseInt(value.trim(), 10)).filter((value) => value > 0 && value < 65536)
    for (const candidatePort of discoveryPorts) urls.push(`http://127.0.0.1:${candidatePort}`)
  }
  for (const target of [...new Set(urls)]) {
    try {
      const status = await probeComfyUrl(target, 900)
      const matched = processes.find((item) => item.port === Number(new URL(target).port || 80))
      comfyUrl = target
      if (matched) {
        comfyRoot = matched.root
        comfyPython = matched.python
        comfyManagedPid = matched.pid
        comfyLaunchMode = 'process'
      }
      if (persist) await rememberComfyConfig(matched ? 'process-discovery' : 'port-discovery')
      return { ...status, discovered: true, root: comfyRoot || null, launchMode: comfyLaunchMode || null }
    } catch { /* try the next local candidate */ }
  }

  const locations = await scanComfyLocations()
  const scripts = []
  for (const scriptPath of [comfyStartScript, ...locations.scripts].filter(Boolean)) {
    const inspected = await inspectStartScript(scriptPath)
    if (inspected) scripts.push(inspected)
  }
  const script = scripts.find((item) => item.root) || scripts[0]
  if (script) {
    comfyStartScript = script.script
    if (script.root) comfyRoot = script.root
    if (script.python) comfyPython = script.python
    if (!comfyUrlLocked) comfyUrl = `http://127.0.0.1:${script.port}`
    comfyLaunchMode = 'script'
  } else if (!comfyRoot && locations.roots[0]) {
    comfyRoot = locations.roots[0]
    comfyLaunchMode = 'direct'
  }
  if (persist && (comfyRoot || comfyStartScript)) await rememberComfyConfig('filesystem-discovery')
  return { connected: false, discovered: Boolean(comfyRoot || comfyStartScript), url: comfyUrl, root: comfyRoot || null, startScript: comfyStartScript || null, launchMode: comfyLaunchMode || null }
}

async function comfyStatus(timeout = 2500) {
  try { return await probeComfyUrl(comfyUrl, timeout) } catch {
    const discovered = await discoverComfyEnvironment()
    if (discovered.connected) return discovered
    throw new Error(`未找到运行中的 ComfyUI（已检查 ${comfyUrl} 和本机进程）`)
  }
}

function runProcess(command, args, timeout = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, shell: false })
    let output = ''
    let errorOutput = ''
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, output: '', error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, output: output.trim(), error: errorOutput.trim() })
    })
  })
}

async function systemdServiceAvailable() {
  if (process.platform !== 'linux' || !await directoryExists('/run/systemd/system')) return false
  const args = [...(comfyServiceScope === 'user' ? ['--user'] : []), 'show', comfyServiceName, '--property=LoadState', '--value']
  const result = await runProcess('systemctl', args, 4000)
  return result.ok && result.output.trim() === 'loaded'
}

async function controlSystemdComfy(action) {
  if (!serviceControlEnabled) throw new Error('systemd 服务控制尚未启用，请设置 H3_ALLOW_SERVICE_CONTROL=1')
  const systemctlArgs = [...(comfyServiceScope === 'user' ? ['--user'] : []), action, comfyServiceName]
  const result = serviceControlUseSudo && comfyServiceScope === 'system'
    ? await runProcess('sudo', ['-n', 'systemctl', ...systemctlArgs], 30000)
    : await runProcess('systemctl', systemctlArgs, 30000)
  if (!result.ok) throw new Error(result.error || result.output || `ComfyUI ${action} 失败`)
  comfyLaunchMode = 'systemd'
  await log('info', 'comfy_service_control', { action, service: comfyServiceName, scope: comfyServiceScope })
  return { type: 'success', text: `ComfyUI 已执行 ${action}`, time: new Date().toISOString() }
}

async function resolveComfyPython() {
  const candidates = [
    comfyPython,
    comfyRoot && path.join(comfyRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    comfyRoot && path.join(comfyRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.env.PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (path.isAbsolute(candidate) && !await fileExists(candidate)) continue
    const result = await runProcess(candidate, ['--version'], 5000)
    if (result.ok) return candidate
  }
  throw new Error('已找到 ComfyUI，但没有可用的 Python；请设置 COMFYUI_PYTHON')
}

async function launchDetached(command, args, cwd) {
  const output = await open(comfyManagerLogPath, 'a')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', output.fd, output.fd],
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    child.once('error', (error) => { void output.close(); reject(error) })
    child.once('spawn', () => {
      comfyManagedPid = child.pid || 0
      child.unref()
      void output.close()
      resolve(child.pid)
    })
  })
}

async function startManagedComfy() {
  await discoverComfyEnvironment()
  if (serviceControlEnabled && await systemdServiceAvailable()) return controlSystemdComfy('start')
  if (comfyStartScript && await fileExists(comfyStartScript)) {
    const command = process.platform === 'win32' ? comfyStartScript : 'bash'
    const args = process.platform === 'win32' ? [] : [comfyStartScript]
    await launchDetached(command, args, path.dirname(comfyStartScript))
    comfyLaunchMode = 'script'
    await rememberComfyConfig('script-started')
    await log('info', 'comfy_script_started', { script: comfyStartScript, pid: comfyManagedPid, url: comfyUrl })
    return { type: 'success', text: `已通过发现的启动脚本拉起 ComfyUI（${comfyStartScript}）`, time: new Date().toISOString() }
  }
  if (!comfyRoot || !await fileExists(path.join(comfyRoot, 'main.py'))) {
    throw new Error('未发现 ComfyUI 安装目录；可设置 COMFYUI_ROOT，或先运行一键安装脚本')
  }
  comfyPython = await resolveComfyPython()
  const parsedUrl = new URL(comfyUrl)
  const comfyPort = Number.parseInt(parsedUrl.port, 10) || 8188
  const listenAddress = process.env.H3_COMFYUI_LISTEN || '0.0.0.0'
  await launchDetached(comfyPython, ['main.py', '--listen', listenAddress, '--port', String(comfyPort)], comfyRoot)
  comfyLaunchMode = 'direct'
  await rememberComfyConfig('direct-started')
  await log('info', 'comfy_direct_started', { root: comfyRoot, python: comfyPython, pid: comfyManagedPid, url: comfyUrl })
  return { type: 'success', text: `已从自动发现的目录启动 ComfyUI（${comfyRoot}）`, time: new Date().toISOString() }
}

async function stopManagedComfy() {
  if (serviceControlEnabled && await systemdServiceAvailable() && comfyLaunchMode === 'systemd') return controlSystemdComfy('stop')
  const processes = await inspectComfyProcesses()
  const targetPort = Number.parseInt(new URL(comfyUrl).port, 10) || 8188
  const targets = processes.filter((item) => (comfyRoot && path.resolve(item.root) === path.resolve(comfyRoot)) || item.port === targetPort)
  if (!targets.length) return { type: 'info', text: 'ComfyUI 当前没有运行', time: new Date().toISOString() }
  for (const item of targets) {
    try { process.kill(item.pid, 'SIGTERM') } catch (error) { if (error?.code !== 'ESRCH') throw error }
  }
  comfyManagedPid = 0
  await rememberComfyConfig('stopped')
  await log('info', 'comfy_process_stopped', { pids: targets.map((item) => item.pid), root: comfyRoot, url: comfyUrl })
  return { type: 'success', text: `ComfyUI 已停止（${targets.length} 个进程）`, time: new Date().toISOString() }
}

async function executeComfyControl(action) {
  if (!['start', 'restart', 'stop'].includes(action)) throw new Error('不支持的服务操作')
  if (action === 'stop') return stopManagedComfy()
  if (action === 'restart') {
    await stopManagedComfy()
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  try {
    await comfyStatus(1000)
    return { type: 'success', text: 'ComfyUI 已在运行', time: new Date().toISOString() }
  } catch {
    const started = await startManagedComfy()
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        await probeComfyUrl(comfyUrl, 1500)
        await rememberComfyConfig('started-and-connected')
        return { ...started, text: `${started.text}，已经连接并保存配置` }
      } catch { /* keep waiting for the discovered service */ }
    }
    return { type: 'warning', text: `${started.text}，但 45 秒内尚未响应，请查看 comfy-logs`, time: new Date().toISOString() }
  }
}

function controlComfyService(action) {
  const operation = comfyControlChain.catch(() => undefined).then(() => executeComfyControl(action))
  comfyControlChain = operation.then(() => undefined, () => undefined)
  return operation
}

async function autoStartComfyService() {
  if (!autoStartComfy) return { type: 'info', text: '当前环境未启用自动启动', time: new Date().toISOString() }
  try {
    await comfyStatus(1200)
    await rememberComfyConfig('connected')
    return { type: 'success', text: 'ComfyUI 已在运行，配置已保存', time: new Date().toISOString() }
  } catch {
    try {
      return await controlComfyService('start')
    } catch (error) {
      return { type: 'warning', text: error instanceof Error ? error.message : 'ComfyUI 自动启动失败', time: new Date().toISOString() }
    }
  }
}

async function environmentStatus() {
  const hasSystemd = process.platform === 'linux' && await directoryExists('/run/systemd/system')
  const [workflow, ffmpeg, service] = await Promise.all([
    workflowAvailable(),
    runProcess('ffmpeg', ['-version'], 3500),
    hasSystemd
      ? runProcess('systemctl', ['is-active', 'h3-studio'], 3000)
      : Promise.resolve({ ok: true, output: process.platform === 'linux' ? '容器进程模式' : '开发模式', error: '' }),
  ])
  let comfy = { connected: false }
  try { comfy = await comfyStatus(3000) } catch { /* reported as disconnected */ }
  let storageWritable = true
  try { await access(storageRoot, fsConstants.R_OK | fsConstants.W_OK) } catch { storageWritable = false }
  const disk = await statfs(storageRoot)
  const freeBytes = Number(disk.bavail * disk.bsize)
  const components = [
    { id: 'web', name: 'H3 网页服务', status: 'ready', detail: `Node ${process.version} · ${host}:${port}` },
    { id: 'comfy', name: '本机 ComfyUI', status: comfy.connected ? 'ready' : 'missing', detail: comfy.connected ? `${comfy.device || '运行中'} · ${comfyUrl}` : comfyRoot || comfyStartScript ? `已发现，等待启动 · ${comfyUrl}` : `未发现 · 已检查 ${comfyUrl}` },
    { id: 'workflow', name: 'H3 API 工作流', status: workflow ? 'ready' : 'missing', detail: workflow ? '已载入 768P 工作流' : '等待 h3-api.json' },
    { id: 'ffmpeg', name: 'FFmpeg 视频工具', status: ffmpeg.ok ? 'ready' : 'missing', detail: ffmpeg.ok ? (ffmpeg.output.split('\n')[0] || '可用') : '未检测到 FFmpeg' },
    { id: 'storage', name: '服务器文件空间', status: storageWritable ? 'ready' : 'missing', detail: storageWritable ? `可读写 · 剩余 ${Math.round(freeBytes / 1024 / 1024 / 1024)} GB` : '目录不可写' },
    { id: 'service', name: '运行方式', status: process.platform !== 'linux' ? 'development' : service.ok ? 'ready' : 'attention', detail: process.platform !== 'linux' ? '当前为开发模式' : hasSystemd ? (service.ok ? 'systemd 正在守护' : '等待启用 h3-studio.service') : '已适配无 systemd 的容器环境' },
  ]
  return {
    ready: comfy.connected && workflow && ffmpeg.ok && storageWritable,
    platform: `${process.platform} ${process.arch}`,
    uptime: Math.floor(process.uptime()),
    checkedAt: new Date().toISOString(),
    components,
  }
}

async function environmentLines(command) {
  const normalized = String(command || '').trim().toLowerCase()
  const line = (type, text) => ({ type, text, time: new Date().toISOString() })
  if (normalized === 'help' || normalized === '?') return [
    line('info', '可用命令：status、deploy、health、queue、storage、logs、comfy-logs、help、clear'),
    line('info', '终端使用受控命令，不会把任意系统 Shell 暴露到网页。'),
  ]
  if (normalized === 'status') {
    const status = await environmentStatus()
    return status.components.map((component) => line(component.status === 'ready' ? 'success' : component.status === 'development' ? 'info' : 'warning', `${component.name}  ${component.detail}`))
  }
  if (normalized === 'deploy') {
    await Promise.all([storageRoot, dataRoot, logRoot].map((directory) => mkdir(directory, { recursive: true })))
    await Promise.all(['上传素材', '生成结果', '模型缓存'].map((name) => mkdir(path.join(storageRoot, name), { recursive: true })))
    const status = await environmentStatus()
    const lines = [line('info', '正在接入本机 H3 运行环境…'), line('success', '运行目录与服务器云盘已准备完成')]
    if (!status.components.find((component) => component.id === 'comfy' && component.status === 'ready')) lines.push(await autoStartComfyService())
    for (const component of status.components) lines.push(line(component.status === 'ready' ? 'success' : component.status === 'development' ? 'info' : 'warning', `${component.name}  ${component.detail}`))
    lines.push(line(status.ready ? 'success' : 'warning', status.ready ? '环境已就绪，可以提交 H3 任务' : '基础环境已部署，黄色项目处理后即可生成'))
    return lines
  }
  if (normalized === 'health') {
    let comfy = { connected: false }
    try { comfy = await comfyStatus() } catch { /* reported below */ }
    return [line('success', `网页服务正常 · 已运行 ${Math.floor(process.uptime())} 秒`), line(comfy.connected ? 'success' : 'warning', comfy.connected ? 'ComfyUI 连接正常' : 'ComfyUI 当前未连接')]
  }
  if (normalized === 'queue') {
    const active = jobs.filter((job) => ['queued', 'generating'].includes(job.status))
    return active.length ? active.map((job) => line('info', `${job.status.padEnd(10)} ${job.id.slice(0, 8)}  ${job.prompt.slice(0, 42)}`)) : [line('success', '当前没有等待中的生成任务')]
  }
  if (normalized === 'storage') {
    const storage = (await listStorage('')).storage
    return [line('info', `总空间 ${Math.round(storage.total / 1024 / 1024 / 1024)} GB`), line('info', `已使用 ${Math.round(storage.used / 1024 / 1024 / 1024)} GB · 剩余 ${Math.round(storage.free / 1024 / 1024 / 1024)} GB`)]
  }
  if (normalized === 'logs') {
    try {
      const content = await readFile(path.join(logRoot, `h3-${new Date().toISOString().slice(0, 10)}.log`), 'utf8')
      return content.trim().split('\n').slice(-30).map((entry) => {
        try {
          const parsed = JSON.parse(entry)
          return line(parsed.level === 'error' ? 'error' : 'info', `${parsed.event}${parsed.message ? ` · ${parsed.message}` : ''}`)
        } catch { return line('info', entry) }
      })
    } catch { return [line('info', '当前还没有运行日志')] }
  }
  if (normalized === 'comfy-logs') {
    if (serviceControlEnabled && await systemdServiceAvailable()) {
      const args = [...(comfyServiceScope === 'user' ? ['--user'] : []), '-u', comfyServiceName, '-n', '80', '--no-pager', '--output=short-iso']
      const result = await runProcess('journalctl', args, 7000)
      if (result.ok) return (result.output || 'ComfyUI 暂无日志').split('\n').map((entry) => line('info', entry))
    }
    try {
      const content = await readFile(comfyManagerLogPath, 'utf8')
      return content.trim().split('\n').slice(-80).map((entry) => line('info', entry))
    } catch { return [line('info', 'ComfyUI 暂无启动日志')] }
  }
  return [line('error', `不支持命令“${normalized || '(空)'}”`), line('info', '输入 help 查看可用命令')]
}

function videoFrames(duration) {
  const target = duration * 24
  return Math.max(5, Math.round((target - 5) / 17) * 17 + 5)
}

function fillWorkflow(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => fillWorkflow(item, replacements))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillWorkflow(item, replacements)]))
  if (typeof value !== 'string') return value
  if (Object.hasOwn(replacements, value)) return replacements[value]
  return Object.entries(replacements).reduce((result, [token, replacement]) => result.replaceAll(token, String(replacement)), value)
}

async function workflowAvailable() {
  try {
    const file = await stat(workflowPath)
    return file.isFile()
  } catch {
    return false
  }
}

async function submitGeneration(body) {
  const prompt = String(body.prompt || '').trim()
  const aspect = Object.hasOwn(dimensions, body.aspect) ? body.aspect : '16:9'
  const duration = Math.min(15, Math.max(5, Number.parseInt(body.duration, 10) || 5))
  if (!prompt && (!Array.isArray(body.attachments) || body.attachments.length === 0)) throw new Error('请输入提示词或添加参考素材')
  if (!await workflowAvailable()) {
    const error = new Error('尚未配置 H3 API 工作流，请将 ComfyUI API 格式工作流放到 workflows/h3-api.json')
    error.code = 'WORKFLOW_NOT_CONFIGURED'
    throw error
  }
  await comfyStatus(4000)
  const workflowFile = JSON.parse(await readFile(workflowPath, 'utf8'))
  const size = dimensions[aspect]
  const seed = Number.isSafeInteger(body.seed) ? body.seed : Math.floor(Math.random() * 2_147_483_647)
  const replacements = {
    '{{PROMPT}}': prompt,
    '{{WIDTH}}': size.width,
    '{{HEIGHT}}': size.height,
    '{{DURATION}}': duration,
    '{{FRAMES}}': videoFrames(duration),
    '{{SEED}}': seed,
    '{{AUDIO}}': body.sound !== false,
  }
  const attachmentGroups = { image: [], video: [], audio: [] }
  for (const attachment of Array.isArray(body.attachments) ? body.attachments : []) {
    const kind = String(attachment.type || '').split('/')[0]
    if (Object.hasOwn(attachmentGroups, kind)) attachmentGroups[kind].push(attachment)
  }
  for (const [kind, attachments] of Object.entries(attachmentGroups)) {
    attachments.forEach((attachment, index) => {
      replacements[`{{${kind.toUpperCase()}_${index + 1}}}`] = attachment.comfyName || attachment.name || ''
    })
  }
  ;(Array.isArray(body.attachments) ? body.attachments : []).forEach((attachment, index) => {
    replacements[`{{REFERENCE_${index + 1}}}`] = attachment.comfyName || attachment.name || ''
  })
  const graph = fillWorkflow(workflowFile.prompt || workflowFile, replacements)
  const response = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'h3-studio' }),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`ComfyUI 拒绝任务 (${response.status})`)
  const result = await response.json()
  if (!result.prompt_id) throw new Error('ComfyUI 未返回任务编号')
  const now = new Date().toISOString()
  const job = {
    id: randomUUID(), promptId: result.prompt_id, conversationId: String(body.conversationId || `conversation-${Date.now()}`),
    prompt, aspect, duration, sound: body.sound !== false, seed, status: 'queued', progress: 8,
    attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 15) : [], outputs: [], createdAt: now, updatedAt: now,
  }
  jobs.unshift(job)
  jobs = jobs.slice(0, 500)
  await persistJobs()
  await log('info', 'generation_submitted', { jobId: job.id, promptId: job.promptId, aspect, duration })
  return job
}

function collectOutputs(history) {
  const result = []
  for (const node of Object.values(history?.outputs || {})) {
    for (const key of ['videos', 'gifs', 'images', 'audio']) {
      for (const file of node?.[key] || []) {
        if (!file?.filename) continue
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' })
        result.push({ kind: key, filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output', url: `/api/comfy/view?${query}` })
      }
    }
  }
  return result
}

async function refreshJob(job) {
  if (!['queued', 'generating'].includes(job.status)) return job
  try {
    const response = await fetch(`${comfyUrl}/history/${encodeURIComponent(job.promptId)}`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) throw new Error(`history ${response.status}`)
    const data = await response.json()
    const history = data[job.promptId]
    if (history) {
      const failed = Array.isArray(history.status?.messages) && history.status.messages.some((message) => message?.[0] === 'execution_error')
      job.status = failed ? 'failed' : 'done'
      job.progress = failed ? job.progress : 100
      job.error = failed ? 'ComfyUI 执行失败，请查看服务日志' : undefined
      job.outputs = collectOutputs(history)
    } else if (Date.now() - Date.parse(job.createdAt) > 2500) {
      job.status = 'generating'
      job.progress = Math.min(92, Math.max(job.progress || 8, 24))
    }
    job.updatedAt = new Date().toISOString()
    await persistJobs()
  } catch {
    job.note = 'ComfyUI 暂时不可达，任务仍在等待恢复'
    job.updatedAt = new Date().toISOString()
  }
  return job
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    let comfy = { connected: false }
    try { comfy = await comfyStatus() } catch { /* health remains available */ }
    return json(res, 200, {
      ok: true, startedAt, uptime: Math.floor(process.uptime()), shuttingDown, comfy,
      workflowConfigured: await workflowAvailable(), queue: jobs.filter((job) => ['queued', 'generating'].includes(job.status)).length,
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/environment/status') {
    return json(res, 200, await environmentStatus())
  }

  if (req.method === 'GET' && url.pathname === '/api/environment/config') {
    return json(res, 200, {
      comfyUrl,
      comfyServiceName,
      comfyServiceScope,
      comfyRoot: comfyRoot || null,
      comfyPython: comfyPython || null,
      comfyStartScript: comfyStartScript || null,
      comfyLaunchMode: comfyLaunchMode || null,
      autoStartComfy,
      savedAt: savedEnvironmentConfig.updatedAt || null,
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/environment/discover') {
    const discovery = await discoverComfyEnvironment()
    return json(res, 200, { discovery, status: await environmentStatus() })
  }

  if (req.method === 'POST' && url.pathname === '/api/environment/prepare') {
    const lines = await environmentLines('deploy')
    await log('info', 'environment_prepare', { ready: lines.at(-1)?.type === 'success' })
    return json(res, 200, { lines, status: await environmentStatus() })
  }

  if (req.method === 'POST' && url.pathname === '/api/environment/terminal') {
    const body = await readJson(req)
    const command = String(body.command || '').slice(0, 80)
    const lines = command.trim().toLowerCase() === 'clear' ? [] : await environmentLines(command)
    return json(res, 200, { lines })
  }

  if (req.method === 'POST' && url.pathname === '/api/environment/service') {
    const body = await readJson(req)
    const action = String(body.action || '')
    try {
      const lines = [await controlComfyService(action)]
      return json(res, 200, { lines, status: await environmentStatus() })
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务操作失败'
      return json(res, 400, { error: message, lines: [{ type: 'error', text: message, time: new Date().toISOString() }] })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/environment/auto-start') {
    const line = await autoStartComfyService()
    return json(res, 200, { lines: [line], status: await environmentStatus() })
  }

  if (req.method === 'GET' && url.pathname === '/api/comfy/status') {
    try { return json(res, 200, { ...await comfyStatus(), workflowConfigured: await workflowAvailable() }) }
    catch { return json(res, 503, { connected: false, workflowConfigured: await workflowAvailable() }) }
  }

  if (req.method === 'GET' && url.pathname === '/api/generations') {
    await Promise.all(jobs.filter((job) => ['queued', 'generating'].includes(job.status)).slice(0, 12).map(refreshJob))
    return json(res, 200, { jobs })
  }

  if (req.method === 'POST' && url.pathname === '/api/generations') {
    return json(res, 202, { job: await submitGeneration(await readJson(req)) })
  }

  const jobMatch = url.pathname.match(/^\/api\/generations\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.find((item) => item.id === jobMatch[1])
    if (!job) return json(res, 404, { error: '任务不存在' })
    return json(res, 200, { job: await refreshJob(job) })
  }

  const saveMatch = url.pathname.match(/^\/api\/generations\/([^/]+)\/save$/)
  if (req.method === 'POST' && saveMatch) {
    const job = jobs.find((item) => item.id === saveMatch[1])
    if (!job || job.status !== 'done') return json(res, 404, { error: '已完成任务不存在' })
    const output = job.outputs?.find((item) => ['videos', 'gifs'].includes(item.kind)) || job.outputs?.[0]
    if (!output) throw new Error('任务没有可保存的输出文件')
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' })
    const response = await fetch(`${comfyUrl}/view?${query}`, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!response.ok || !response.body) throw new Error('无法从 ComfyUI 读取生成结果')
    const outputDirectory = path.join(storageRoot, '生成结果')
    const targetName = safeName(`${job.id.slice(0, 8)}-${path.basename(output.filename)}`)
    const target = path.join(outputDirectory, targetName)
    const temporary = path.join(outputDirectory, `.${targetName}.${randomUUID()}.saving`)
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }))
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    const relative = path.relative(storageRoot, target).split(path.sep).join('/')
    await log('info', 'generation_saved', { jobId: job.id, path: relative })
    return json(res, 201, { ok: true, path: relative })
  }

  if (req.method === 'GET' && url.pathname === '/api/comfy/view') {
    const query = new URLSearchParams()
    for (const key of ['filename', 'subfolder', 'type']) query.set(key, url.searchParams.get(key) || '')
    const response = await fetch(`${comfyUrl}/view?${query}`, { signal: AbortSignal.timeout(10000) })
    if (!response.ok || !response.body) throw new Error('生成结果不可读取')
    res.writeHead(200, { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
    return pipeline(Readable.fromWeb(response.body), res)
  }

  if (req.method === 'POST' && url.pathname === '/api/comfy/upload') {
    const contentType = String(req.headers['content-type'] || '')
    const declaredSize = Number(req.headers['content-length'] || 0)
    if (!contentType.startsWith('multipart/form-data')) throw new Error('素材上传格式不合法')
    if (declaredSize > maxUploadBytes) return json(res, 413, { error: '文件超过服务器上传限制' })
    let received = 0
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length
        callback(received > maxUploadBytes ? new Error('文件超过服务器上传限制') : null, chunk)
      },
    })
    const response = await fetch(`${comfyUrl}/upload/image`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Readable.toWeb(req.pipe(limiter)),
      duplex: 'half',
      signal: AbortSignal.timeout(15 * 60_000),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `ComfyUI 素材上传失败 (${response.status})`)
    return json(res, 201, result)
  }

  if (req.method === 'GET' && url.pathname === '/api/storage/list') return json(res, 200, await listStorage(url.searchParams.get('path') || ''))

  if (req.method === 'POST' && url.pathname === '/api/storage/folder') {
    const body = await readJson(req)
    const parent = safeResolve(storageRoot, body.path || '')
    const folder = safeResolve(parent, safeName(body.name))
    await mkdir(folder, { recursive: false })
    return json(res, 201, { ok: true })
  }

  if (req.method === 'PUT' && url.pathname === '/api/storage/upload') {
    const declaredSize = Number(req.headers['content-length'] || 0)
    if (declaredSize > maxUploadBytes) return json(res, 413, { error: '文件超过服务器上传限制' })
    const parent = safeResolve(storageRoot, url.searchParams.get('path') || '')
    const target = safeResolve(parent, safeName(url.searchParams.get('name')))
    if (path.dirname(target) !== parent) throw new Error('上传路径不合法')
    const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.uploading`)
    let received = 0
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length
        callback(received > maxUploadBytes ? new Error('文件超过服务器上传限制') : null, chunk)
      },
    })
    try {
      await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx' }))
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await log('info', 'storage_upload', { path: path.relative(storageRoot, target), bytes: received })
    return json(res, 201, { ok: true, bytes: received, path: path.relative(storageRoot, target).split(path.sep).join('/') })
  }

  if (req.method === 'GET' && url.pathname === '/api/storage/download') {
    const target = safeResolve(storageRoot, url.searchParams.get('path') || '')
    const fileStat = await stat(target)
    if (!fileStat.isFile()) throw new Error('目标不是文件')
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
    })
    return pipeline(createReadStream(target), res)
  }

  return json(res, 404, { error: '接口不存在' })
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname
  let target = safeResolve(distRoot, requested)
  try {
    const targetStat = await stat(target)
    if (targetStat.isDirectory()) target = path.join(target, 'index.html')
  } catch {
    target = path.join(distRoot, 'index.html')
  }
  const targetStat = await stat(target)
  res.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': targetStat.size,
    'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  return pipeline(createReadStream(target), res)
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID()
  const requestStarted = Date.now()
  setSecurityHeaders(res, requestId)
  try {
    if (shuttingDown) return json(res, 503, { error: '服务正在安全重启，请稍后重试' })
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url)
    else await serveStatic(req, res, url)
    const quietPoll = req.method === 'GET' && ['/api/generations', '/api/comfy/status'].includes(url.pathname)
    if (url.pathname.startsWith('/api/') && !quietPoll) void log('info', 'request', { requestId, method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - requestStarted })
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务器内部错误'
    const code = error?.code
    const status = code === 'WORKFLOW_NOT_CONFIGURED' ? 503 : message.includes('不存在') ? 404 : message.includes('超过') ? 413 : 400
    if (!res.headersSent) json(res, status, { error: message, code, requestId })
    else res.destroy()
    void log('error', 'request_failed', { requestId, method: req.method, path: req.url, status, message, durationMs: Date.now() - requestStarted })
  }
})

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.requestTimeout = 15 * 60_000

server.listen(port, host, () => {
  void log('info', 'server_started', { url: `http://${host}:${port}`, storageRoot, comfyUrl, workflowPath })
  if (autoStartComfy) setTimeout(() => void autoStartComfyService(), 1500).unref()
})

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  await log('info', 'server_shutdown', { signal })
  server.close(async () => {
    await persistJobs().catch(() => undefined)
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => void log('error', 'unhandled_rejection', { message: String(reason) }))
process.on('uncaughtException', (error) => {
  void log('error', 'uncaught_exception', { message: error.message, stack: error.stack }).finally(() => void shutdown('uncaughtException'))
})
