import {
  Activity,
  Archive,
  ArrowUp,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Clapperboard,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileVideo,
  Film,
  Folder,
  FolderOpen,
  Gauge,
  Grid2X2,
  HardDrive,
  Image,
  LayoutList,
  Maximize2,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { ChangeEvent, ClipboardEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'

type View = 'create' | 'drive' | 'deploy'
type GenerationStatus = 'queued' | 'generating' | 'done' | 'failed'

type Attachment = {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: globalThis.File
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  prompt?: string
  attachments?: Attachment[]
  status?: GenerationStatus
  progress?: number
  aspect?: string
  duration?: number
  createdAt?: string
  jobId?: string
  error?: string
  note?: string
  outputUrl?: string
  sound?: boolean
  samplingSteps?: number
  currentStep?: number
}

type Thread = {
  id: string
  title: string
  meta: string
  accent: string
}

type UserTask = {
  id: string
  conversationId: string
  title: string
  prompt: string
  aspect: string
  duration: number
  status: GenerationStatus
  progress: number
  videoUrl?: string
  videoName?: string
  createdAt: string
  jobId?: string
  error?: string
  samplingSteps?: number
  currentStep?: number
}

const TASKS_STORAGE_KEY = 'h3-user-tasks'

function loadUserTasks(userId: string): UserTask[] {
  try {
    const data = localStorage.getItem(`${TASKS_STORAGE_KEY}-${userId}`)
    return data ? JSON.parse(data) : []
  } catch { return [] }
}

function saveUserTasks(userId: string, tasks: UserTask[]) {
  localStorage.setItem(`${TASKS_STORAGE_KEY}-${userId}`, JSON.stringify(tasks))
}

type DriveItem = {
  id: string
  name: string
  kind: 'folder' | 'image' | 'video' | 'file'
  size: string
  modified: string
  url?: string
}

type StorageInfo = {
  total: number
  free: number
  used: number
}

type GpuStatus = {
  name: string
  utilization: number
  memoryUsed: number
  memoryTotal: number
  temperature: number
}

type ComfyStatus = {
  connected: boolean
  device?: string
  workflowConfigured?: boolean
  gpu?: GpuStatus
}

type ServerJob = {
  id: string
  conversationId: string
  prompt: string
  aspect: string
  duration: number
  sound?: boolean
  status: GenerationStatus
  progress: number
  error?: string
  note?: string
  outputs?: { kind: string; url: string }[]
  attachments?: { name: string; type: string; size: number; path?: string; comfyName?: string }[]
  createdAt: string
  samplingSteps?: number
  currentStep?: number
}

type EnvironmentComponent = {
  id: 'web' | 'comfy' | 'workflow' | 'ffmpeg' | 'storage' | 'service'
  name: string
  status: 'ready' | 'missing' | 'attention' | 'development'
  detail: string
}

type EnvironmentStatus = {
  ready: boolean
  platform: string
  comfyUrl?: string
  uptime: number
  checkedAt: string
  components: EnvironmentComponent[]
}

type TerminalLine = {
  type: 'command' | 'success' | 'warning' | 'error' | 'info'
  text: string
  time: string
}

type HarnessConfig = {
  configured: boolean
  model: string | null
  hasApiKey: boolean
  tools: { name: string; mutating: boolean }[]
}

type HarnessDetails = {
  apiBase: string
  model: string
  hasApiKey: boolean
}

type HarnessMessage = {
  role: 'user' | 'assistant'
  content: string
  tools?: string[]
}

type Account = {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  createdAt: string
}

const initialThreads: Thread[] = [
  { id: 'draft', title: '未命名创作', meta: '刚刚', accent: 'violet' },
]

const initialDriveItems: DriveItem[] = []

const aspectOptions = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, exponent)).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function fileKind(file: File): DriveItem['kind'] {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`)
  return body as T
}

function shortTitle(value: string) {
  const title = value.trim() || '素材生成视频'
  return title.length > 19 ? `${title.slice(0, 19)}…` : title
}

function serverMessage(job: ServerJob): Message {
  return {
    id: `assistant-${job.id}`,
    role: 'assistant',
    status: job.status,
    progress: job.progress,
    aspect: job.aspect,
    duration: job.duration,
    sound: job.sound !== false,
    createdAt: '已保存',
    jobId: job.id,
    error: job.error,
    note: job.note,
    outputUrl: job.outputs?.find((output) => ['videos', 'gifs'].includes(output.kind))?.url ?? job.outputs?.[0]?.url,
    samplingSteps: job.samplingSteps,
    currentStep: job.currentStep,
  }
}

function AuthView({ onAuthenticated }: { onAuthenticated: (account: Account) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [initialized, setInitialized] = useState(true)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/config').then((response) => response.json()).then((data) => {
      const hasAccounts = Boolean(data.initialized)
      setInitialized(hasAccounts)
      setMode(hasAccounts ? 'login' : 'register')
    }).catch(() => undefined)
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName }),
      })
      const data = await responseJson<{ account: Account }>(response)
      onAuthenticated(data.account)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账号操作失败')
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><Sparkles size={20} /></span><div><strong>H3 Studio</strong><small>Creative console</small></div></div>
        <div className="auth-heading"><span className="eyebrow"><ShieldCheck size={13} />多账号安全空间</span><h1>{mode === 'login' ? '登录你的工作台' : '创建第一个账号'}</h1><p>{mode === 'login' ? '每个账号共享服务器资源，但只显示自己的任务队列。' : '创建后即可管理生成任务、服务器云盘和环境。'}</p></div>
        <form className="auth-form" onSubmit={submit}>
          <label className="ui-field"><span>账号名</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如：studio-admin" autoComplete="username" required /></label>
          {mode === 'register' && <label className="ui-field"><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：我的工作台" autoComplete="name" /></label>}
          <label className="ui-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? '登录 H3 Studio' : '创建账号并进入'}</button>
        </form>
        {initialized ? <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>{mode === 'login' ? '创建新的账号' : '已有账号，返回登录'}</button> : <p className="auth-first-note">这是当前服务器的第一个账号，将自动成为管理员。</p>}
      </div>
    </div>
  )
}

function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [view, setView] = useState<View>('create')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [threads, setThreads] = useState<Thread[]>(initialThreads)
  const [activeThread, setActiveThread] = useState('draft')
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [aspect, setAspect] = useState('16:9')
  const [duration, setDuration] = useState(5)
  const [sound, setSound] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [driveItems, setDriveItems] = useState<DriveItem[]>(initialDriveItems)
  const [driveSearch, setDriveSearch] = useState('')
  const [driveLayout, setDriveLayout] = useState<'list' | 'grid'>('list')
  const [drivePath, setDrivePath] = useState('/')
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({ total: 0, used: 0, free: 0 })
  const [driveConnected, setDriveConnected] = useState(false)
  const [driveReload, setDriveReload] = useState(0)
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus>({ connected: false })
  const [toast, setToast] = useState('')
  const [toastLeaving, setToastLeaving] = useState(false)
  const [userTasks, setUserTasks] = useState<UserTask[]>([])
  const [deleteConfirm, setDeleteConfirm] = useState<{ taskId: string; deleteVideos: boolean } | null>(null)
  const toastTimersRef = useRef<number[]>([])
  const materialInputRef = useRef<HTMLInputElement>(null)
  const driveInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/auth/me').then(async (response) => response.ok ? (await response.json()).account as Account : null).then(setAccount).catch(() => setAccount(null))
  }, [])

  useEffect(() => {
    if (account?.id) {
      setUserTasks(loadUserTasks(account.id))
    }
  }, [account?.id])

  useEffect(() => {
    if (account?.id) {
      saveUserTasks(account.id, userTasks)
    }
  }, [userTasks, account?.id])

  const activeMessages = messages[activeThread] ?? []
  const activeTitle = threads.find((thread) => thread.id === activeThread)?.title ?? '未命名创作'

  useEffect(() => {
    let cancelled = false
    const checkComfy = () => {
      fetch('/api/comfy/status')
        .then(async (response) => {
          if (!response.ok) throw new Error('ComfyUI 未连接')
          return response.json()
        })
        .then((status) => {
          if (!cancelled) setComfyStatus({ connected: Boolean(status.connected), device: status.device, workflowConfigured: Boolean(status.workflowConfigured), gpu: status.gpu })
        })
        .catch(() => {
          if (!cancelled) setComfyStatus({ connected: false })
        })
    }
    checkComfy()
    const timer = window.setInterval(checkComfy, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [account?.id])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const syncJobs = async () => {
      let nextDelay = 30000
      try {
        const data = await responseJson<{ jobs: ServerJob[] }>(await fetch('/api/generations'))
        if (cancelled) return
        nextDelay = data.jobs.some((job) => ['queued', 'generating'].includes(job.status)) ? 4000 : 30000

        setUserTasks((current) => {
          const next = [...current]
          for (const job of data.jobs) {
            const existingIndex = next.findIndex((t) => t.jobId === job.id)
            if (existingIndex >= 0) {
              const videoUrl = job.outputs?.find((output) => ['videos', 'gifs'].includes(output.kind))?.url ?? job.outputs?.[0]?.url
              next[existingIndex] = {
                ...next[existingIndex],
                status: job.status,
                progress: job.progress,
                error: job.error,
                videoUrl: videoUrl || next[existingIndex].videoUrl,
                samplingSteps: job.samplingSteps,
                currentStep: job.currentStep,
              }
            }
          }
          return next
        })
      } catch {
        // 后端或 ComfyUI 短暂不可用时保留当前界面，下一轮自动恢复。
      }
      if (!cancelled) timer = window.setTimeout(syncJobs, nextDelay)
    }
    void syncJobs()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [account?.id])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/storage/list?scope=server&path=${encodeURIComponent(drivePath)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('云盘接口不可用')
        return response.json()
      })
      .then((data) => {
        if (cancelled) return
        setDriveItems(data.items.map((item: { id: string; name: string; kind: DriveItem['kind']; size: number; modified: string; url?: string }) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          size: item.kind === 'folder' ? '—' : formatBytes(item.size),
          modified: new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.modified)),
          url: item.url,
        })))
        setStorageInfo(data.storage)
        setDriveConnected(true)
      })
      .catch(() => {
        if (!cancelled) setDriveConnected(false)
      })
    return () => { cancelled = true }
  }, [drivePath, driveReload, account?.id])

  const showToast = (message: string) => {
    toastTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    setToastLeaving(false)
    setToast(message)
    toastTimersRef.current = [
      window.setTimeout(() => setToastLeaving(true), 1900),
      window.setTimeout(() => setToast(''), 2100),
    ]
  }

  const addMaterials = (files: File[]) => {
    if (!files.length) return
    const limits = { image: 9, video: 3, audio: 3 }
    const next = [...attachments]
    let added = 0
    let skipped = 0
    for (const file of files) {
      const category = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null
      if (!category || next.filter((item) => item.type.startsWith(`${category}/`)).length >= limits[category]) {
        skipped += 1
        continue
      }
      next.push({
        id: `${Date.now()}-${file.name}-${Math.random()}`,
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        file,
      })
      added += 1
    }
    setAttachments(next)
    showToast(skipped ? `已添加 ${added} 个素材，${skipped} 个不符合 H3 输入限制` : `已添加 ${added} 个素材`)
  }

  const handleMaterialChange = (event: ChangeEvent<HTMLInputElement>) => {
    addMaterials(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (pastedFiles.length) {
      event.preventDefault()
      addMaterials(pastedFiles)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    addMaterials(Array.from(event.dataTransfer.files))
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const patchMessage = (threadId: string, messageId: string, patch: Partial<Message>) => {
    setMessages((current) => ({
      ...current,
      [threadId]: (current[threadId] ?? []).map((message) =>
        message.id === messageId ? { ...message, ...patch } : message,
      ),
    }))
  }

  const submitGeneration = async () => {
    if (!prompt.trim() && !attachments.length) return
    const threadId = activeThread
    const submissionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userId = `user-pending-${submissionId}`
    const assistantId = `assistant-pending-${submissionId}`
    const submittedPrompt = prompt.trim()
    const submittedAttachments = [...attachments]
    const title = submittedPrompt || submittedAttachments[0]?.name || '新视频创作'
    const userMessage: Message = {
      id: userId,
      role: 'user',
      prompt: submittedPrompt,
      attachments: submittedAttachments,
      aspect,
      duration,
      createdAt: '刚刚',
    }
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      status: 'queued',
      progress: 8,
      aspect,
      duration,
      createdAt: '刚刚',
    }

    setMessages((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), userMessage, assistantMessage],
    }))
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? { ...thread, title: shortTitle(title), meta: '正在提交' }
          : thread,
      ),
    )
    setPrompt('')
    setAttachments([])

    try {
      const readiness = await responseJson<{ comfy: { connected: boolean }; workflowConfigured: boolean }>(await fetch('/api/health'))
      if (!readiness.workflowConfigured) throw new Error('尚未配置 H3 API 工作流，请先放入 workflows/h3-api.json')
      const uploaded = []
      for (const [index, attachment] of submittedAttachments.entries()) {
        if (!attachment.file) continue
        const storedName = `${submissionId}-${index}-${attachment.file.name}`
        const upload = await responseJson<{ path: string }>(await fetch(`/api/storage/upload?path=${encodeURIComponent('上传素材')}&name=${encodeURIComponent(storedName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': attachment.file.type || 'application/octet-stream' },
          body: attachment.file,
        }))
        const form = new FormData()
        form.append('image', attachment.file, storedName)
        form.append('type', 'input')
        form.append('overwrite', 'false')
        const comfyUpload = await responseJson<{ name: string }>(await fetch('/api/comfy/upload', { method: 'POST', body: form }))
        uploaded.push({ name: attachment.name, type: attachment.type, size: attachment.size, path: upload.path, comfyName: comfyUpload.name })
      }
      const data = await responseJson<{ job: ServerJob }>(await fetch('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: threadId,
          prompt: submittedPrompt,
          attachments: uploaded,
          aspect,
          duration,
          sound,
        }),
      }))
      patchMessage(threadId, assistantId, { ...serverMessage(data.job), id: assistantId })
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, meta: '生成中' } : thread))
      setUserTasks((current) => [{
        id: `task-${data.job.id}`,
        conversationId: threadId,
        title: shortTitle(title),
        prompt: submittedPrompt,
        aspect,
        duration,
        status: data.job.status,
        progress: data.job.progress,
        videoUrl: data.job.outputs?.find((output) => ['videos', 'gifs'].includes(output.kind))?.url ?? data.job.outputs?.[0]?.url,
        videoName: `${data.job.id}.mp4`,
        createdAt: new Date().toLocaleString('zh-CN'),
        jobId: data.job.id,
        samplingSteps: data.job.samplingSteps,
        currentStep: data.job.currentStep,
      }, ...current])
      showToast('任务已安全写入 ComfyUI 队列')
    } catch (error) {
      const message = error instanceof Error ? error.message : '任务提交失败'
      patchMessage(threadId, assistantId, { status: 'failed', progress: 0, error: message })
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, meta: '需要处理' } : thread))
      showToast(message)
    }
  }

  const createNewThread = () => {
    const id = `thread-${Date.now()}`
    setThreads((current) => [
      { id, title: '未命名创作', meta: '刚刚', accent: ['violet', 'blue', 'green'][current.length % 3] },
      ...current,
    ])
    setActiveThread(id)
    setView('create')
    setPrompt('')
    setAttachments([])
    setSidebarOpen(false)
  }

  const uploadToDrive = async (files: File[]) => {
    if (!files.length) return
    try {
      for (const file of files) {
        const response = await fetch(`/api/storage/upload?scope=server&path=${encodeURIComponent(drivePath)}&name=${encodeURIComponent(file.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!response.ok) throw new Error('上传失败')
      }
      setDriveReload((value) => value + 1)
      showToast(`已上传到 ${drivePath}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '服务器云盘上传失败')
    }
  }

  const handleDriveChange = (event: ChangeEvent<HTMLInputElement>) => {
    uploadToDrive(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const saveGeneration = async (message: Message) => {
    if (!message.jobId) return showToast('这个结果没有可保存的服务器任务')
    try {
      const data = await responseJson<{ path: string }>(await fetch(`/api/generations/${encodeURIComponent(message.jobId)}/save`, { method: 'POST' }))
      setDriveReload((value) => value + 1)
      showToast(`已保存到云盘：${data.path}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存到云盘失败')
    }
  }

  const downloadDriveItem = async (item: DriveItem) => {
    if (!item.url) return showToast('这个文件暂时没有可下载地址')
    try {
      const response = await fetch(item.url)
      if (!response.ok) throw new Error('文件下载失败')
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = item.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      showToast(`已开始下载：${item.name}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文件下载失败')
    }
  }

  const downloadGeneration = async () => {
    const result = [...activeMessages].reverse().find((message) => message.role === 'assistant' && message.status === 'done' && message.outputUrl)
    if (!result?.outputUrl) return showToast('这个结果还没有可下载的视频')
    try {
      const response = await fetch(result.outputUrl)
      if (!response.ok) throw new Error('视频下载失败')
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${result.jobId || 'h3-video'}.mp4`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      showToast('已开始下载视频')
    } catch (error) { showToast(error instanceof Error ? error.message : '视频下载失败') }
  }

  const downloadMessageVideo = async (message: Message) => {
    if (!message.outputUrl) return showToast('这个结果还没有可下载的视频')
    try {
      const response = await fetch(message.outputUrl)
      if (!response.ok) throw new Error('视频下载失败')
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${message.jobId || 'h3-video'}.mp4`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      showToast('已开始下载视频')
    } catch (error) { showToast(error instanceof Error ? error.message : '视频下载失败') }
  }

  const cancelGeneration = async (jobId: string, threadId: string, assistantMessageId: string) => {
    try {
      await fetch(`/api/generations/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
      patchMessage(threadId, assistantMessageId, { status: 'failed', progress: 0, note: '任务已取消' })
      setUserTasks((current) => current.map((t) => t.jobId === jobId ? { ...t, status: 'failed', progress: 0, error: '任务已取消' } : t))
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, meta: '需要处理' } : thread))
      showToast('任务已取消')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '取消任务失败')
    }
  }

  const deleteThread = async (threadId: string) => {
    try {
      await fetch(`/api/generations?conversationId=${encodeURIComponent(threadId)}`, { method: 'DELETE' })
    } catch { /* 后端可能不支持，静默处理 */ }
    setThreads((current) => current.filter((thread) => thread.id !== threadId))
    setMessages((current) => {
      const next = { ...current }
      delete next[threadId]
      return next
    })
    if (activeThread === threadId) {
      const remaining = threads.filter((t) => t.id !== threadId)
      setActiveThread(remaining[0]?.id ?? 'draft')
    }
    showToast('任务已删除')
  }

  const deleteTask = async (taskId: string, deleteVideos: boolean) => {
    const task = userTasks.find((t) => t.id === taskId)
    if (!task) return

    if (deleteVideos && task.videoUrl) {
      try {
        await fetch(`/api/storage/delete?url=${encodeURIComponent(task.videoUrl)}`, { method: 'DELETE' })
      } catch { /* 静默处理 */ }
    }

    if (task.jobId) {
      try {
        await fetch(`/api/generations/${encodeURIComponent(task.jobId)}`, { method: 'DELETE' })
      } catch { /* 静默处理 */ }
    }

    setUserTasks((current) => current.filter((t) => t.id !== taskId))
    showToast(deleteVideos ? '任务和视频已删除' : '任务已删除')
  }

  const deleteAllTasks = async (deleteVideos: boolean) => {
    for (const task of userTasks) {
      if (deleteVideos && task.videoUrl) {
        try {
          await fetch(`/api/storage/delete?url=${encodeURIComponent(task.videoUrl)}`, { method: 'DELETE' })
        } catch { /* 静默处理 */ }
      }
      if (task.jobId) {
        try {
          await fetch(`/api/generations/${encodeURIComponent(task.jobId)}`, { method: 'DELETE' })
        } catch { /* 静默处理 */ }
      }
    }
    setUserTasks([])
    showToast(deleteVideos ? '所有任务和视频已删除' : '所有任务已删除')
  }

  const downloadTaskVideo = async (task: UserTask) => {
    if (!task.videoUrl) return showToast('这个任务还没有视频')
    try {
      const response = await fetch(task.videoUrl)
      if (!response.ok) throw new Error('视频下载失败')
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = task.videoName || `${task.id}.mp4`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      showToast('已开始下载视频')
    } catch (error) { showToast(error instanceof Error ? error.message : '视频下载失败') }
  }

  const filteredDriveItems = useMemo(
    () => driveItems.filter((item) => item.name.toLowerCase().includes(driveSearch.toLowerCase())),
    [driveItems, driveSearch],
  )

  const openThread = (id: string) => {
    setActiveThread(id)
    setView('create')
    setSidebarOpen(false)
  }

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    setAccount(null)
  }

  const openTask = (task: UserTask) => {
    if (task.conversationId) {
      setActiveThread(task.conversationId)
    }
    setView('create')
    setSidebarOpen(false)
  }

  if (account === undefined) return <div className="auth-loading"><Sparkles size={20} /><span>正在连接 H3 Studio…</span></div>
  if (!account) return <AuthView onAuthenticated={setAccount} />

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        view={view}
        threads={threads}
        activeThread={activeThread}
        onClose={() => setSidebarOpen(false)}
        onViewChange={(nextView) => {
          setView(nextView)
          setSidebarOpen(false)
        }}
        onThreadOpen={openThread}
        onNewThread={createNewThread}
        onDeleteThread={deleteThread}
        userTasks={userTasks}
        onDeleteTask={deleteTask}
        onDeleteAllTasks={deleteAllTasks}
        onDownloadTask={downloadTaskVideo}
        onOpenTask={openTask}
        storageInfo={storageInfo}
        comfyStatus={comfyStatus}
      />

      <main className="main-panel">
        <Topbar
          view={view}
          title={view === 'create' ? activeTitle : view === 'drive' ? '服务器云盘' : '环境部署'}
          onMenu={() => setSidebarOpen(true)}
          comfyStatus={comfyStatus}
          account={account}
          onLogout={() => void logout()}
        />

        {view === 'create' && (
          <CreateView
            messages={activeMessages}
            prompt={prompt}
            attachments={attachments}
            dragActive={dragActive}
            aspect={aspect}
            duration={duration}
            sound={sound}
            advancedOpen={advancedOpen}
            materialInputRef={materialInputRef}
            onPromptChange={setPrompt}
            onPaste={handlePaste}
            onDragEnter={() => setDragActive(true)}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onMaterialChange={handleMaterialChange}
            onRemoveAttachment={removeAttachment}
            onAspectChange={setAspect}
            onDurationChange={setDuration}
            onSoundChange={setSound}
            onAdvancedToggle={() => setAdvancedOpen((open) => !open)}
            onSubmit={submitGeneration}
            onOpenPreview={() => setPreviewOpen(true)}
            onSaveGeneration={saveGeneration}
            onCancelGeneration={cancelGeneration}
            onDownloadMessage={downloadMessageVideo}
            threadId={activeThread}
          />
        )}

        {view === 'drive' && (
          <DriveView
            items={filteredDriveItems}
            search={driveSearch}
            layout={driveLayout}
            path={drivePath}
            storageInfo={storageInfo}
            connected={driveConnected}
            inputRef={driveInputRef}
            onSearch={setDriveSearch}
            onLayout={setDriveLayout}
            onInputChange={handleDriveChange}
            onUpload={(files) => uploadToDrive(files)}
            onFolderOpen={(name) => setDrivePath(`${drivePath}/${name}`)}
            onHome={() => setDrivePath('/')}
            onDownload={downloadDriveItem}
            onCreateFolder={async (name) => {
              try {
                const response = await fetch('/api/storage/folder', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ scope: 'server', path: drivePath, name }),
                })
                if (!response.ok) throw new Error('创建失败')
                setDriveReload((value) => value + 1)
                showToast('已在服务器创建文件夹')
              } catch (error) {
                showToast(error instanceof Error ? error.message : '文件夹创建失败')
              }
            }}
          />
        )}

        {view === 'deploy' && <EnvironmentView onToast={showToast} />}

      </main>

      {toast && (
        <div className={`toast ${toastLeaving ? 'leaving' : ''}`}>
          <Check size={16} />
          {toast}
        </div>
      )}

      {previewOpen && (
        <FocusPreview
          messages={activeMessages}
          prompt={prompt}
          aspect={aspect}
          duration={duration}
          onPromptChange={setPrompt}
          onSubmit={() => {
            setPreviewOpen(false)
            submitGeneration()
          }}
          onClose={() => setPreviewOpen(false)}
          onSave={async () => {
            const result = [...activeMessages].reverse().find((message) => message.role === 'assistant' && message.status === 'done')
            if (result) await saveGeneration(result)
            else showToast('当前没有可保存的已完成视频')
          }}
          onDownload={downloadGeneration}
        />
      )}
    </div>
  )
}

type SidebarProps = {
  open: boolean
  view: View
  threads: Thread[]
  activeThread: string
  onClose: () => void
  onViewChange: (view: View) => void
  onThreadOpen: (id: string) => void
  onNewThread: () => void
  onDeleteThread: (id: string) => void
  userTasks: UserTask[]
  onDeleteTask: (taskId: string, deleteVideos: boolean) => void
  onDeleteAllTasks: (deleteVideos: boolean) => void
  onDownloadTask: (task: UserTask) => void
  onOpenTask: (task: UserTask) => void
  storageInfo: StorageInfo
  comfyStatus: ComfyStatus
}

function Sidebar({
  open,
  view,
  threads,
  activeThread,
  onClose,
  onViewChange,
  onThreadOpen,
  onNewThread,
  onDeleteThread,
  userTasks,
  onDeleteTask,
  onDeleteAllTasks,
  onDownloadTask,
  onOpenTask,
  storageInfo,
  comfyStatus,
}: SidebarProps) {
  const storagePercent = storageInfo.total ? Math.round((storageInfo.used / storageInfo.total) * 100) : 0
  return (
    <>
      <button className={`sidebar-backdrop ${open ? 'visible' : ''}`} onClick={onClose} aria-label="关闭菜单" />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={19} /></div>
          <div>
            <div className="brand-name">H3 Studio</div>
            <div className="brand-subtitle">Creative console</div>
          </div>
          <button className="icon-button sidebar-close" onClick={onClose}><X size={18} /></button>
        </div>

        <button className="new-creation-button" onClick={onNewThread}>
          <MessageSquarePlus size={17} />
          新建创作
          <span className="shortcut">⌘ K</span>
        </button>

        <nav className="primary-nav" aria-label="主要功能">
          <button className={view === 'create' ? 'active' : ''} onClick={() => onViewChange('create')}>
            <WandSparkles size={18} />
            全能生成
          </button>
          <button className={view === 'drive' ? 'active' : ''} onClick={() => onViewChange('drive')}>
            <Cloud size={18} />
            服务器云盘
          </button>
          <button className={view === 'deploy' ? 'active' : ''} onClick={() => onViewChange('deploy')}>
            <Server size={18} />
            环境部署
          </button>
        </nav>

        <div className="sidebar-section-heading">
          <span>任务列表</span>
          {userTasks.length > 0 && (
            <button className="icon-button" title="清空所有任务" onClick={() => {
              if (confirm('确定要清空所有任务吗？')) {
                onDeleteAllTasks(false)
              }
            }}><Trash2 size={14} /></button>
          )}
        </div>
        <div className="thread-list">
          {userTasks.length === 0 ? (
            <div className="empty-tasks-hint">
              <Film size={20} />
              <span>暂无任务</span>
            </div>
          ) : (
            userTasks.map((task) => (
              <div
                key={task.id}
                className={`task-item ${task.status === 'generating' ? 'active' : ''}`}
                onClick={() => onOpenTask(task)}
              >
                <span className={`thread-icon ${task.status === 'done' ? 'green' : task.status === 'failed' ? 'orange' : 'blue'}`}>
                  {task.status === 'done' ? <Check size={14} /> : task.status === 'generating' ? <Sparkles size={14} /> : <Film size={14} />}
                </span>
                <span className="thread-copy">
                  <strong>{task.title}</strong>
                  <small>{task.status === 'done' ? '已完成' : task.status === 'generating' ? `生成中 ${task.progress}%` : task.status === 'failed' ? '失败' : '排队中'}</small>
                </span>
                <span className="thread-actions">
                  {task.videoUrl && (
                    <button className="task-action-btn" title="下载视频" onClick={(e) => { e.stopPropagation(); onDownloadTask(task) }}>
                      <Download size={12} />
                    </button>
                  )}
                  <button className="task-action-btn delete" title="删除任务" onClick={(e) => {
                    e.stopPropagation()
                    if (task.videoUrl) {
                      const shouldDeleteVideos = confirm('是否同时删除该任务的视频文件？')
                      onDeleteTask(task.id, shouldDeleteVideos)
                    } else {
                      onDeleteTask(task.id, false)
                    }
                  }}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="storage-mini">
            <div className="storage-mini-top">
              <span><HardDrive size={15} />服务器空间</span>
              <strong>{storagePercent}%</strong>
            </div>
            <div className="storage-track"><span style={{ width: `${storagePercent}%` }} /></div>
            <small>{storageInfo.total ? `${formatBytes(storageInfo.used)} / ${formatBytes(storageInfo.total)}` : '正在读取服务器空间'}</small>
          </div>
          <div className="profile-button comfy-profile">
            <span className="avatar">H3</span>
            <span><strong>本机 ComfyUI</strong><small>{comfyStatus.connected ? (comfyStatus.workflowConfigured ? (comfyStatus.device || '连接正常') : '待放入 H3 工作流') : '等待连接'}</small></span>
            <span className={`status-dot ${comfyStatus.connected ? 'online' : 'offline'}`} />
          </div>
          {comfyStatus.gpu && (
            <div className="gpu-status-card">
              <div className="gpu-status-header">
                <Cpu size={13} />
                <span>GPU 状态</span>
              </div>
              <div className="gpu-info-row">
                <span className="gpu-name">{comfyStatus.gpu.name}</span>
                <span className={`gpu-temp ${comfyStatus.gpu.temperature > 80 ? 'hot' : ''}`}>{comfyStatus.gpu.temperature}°C</span>
              </div>
              <div className="gpu-bar-row">
                <span>利用率</span>
                <div className="gpu-bar"><span style={{ width: `${comfyStatus.gpu.utilization}%` }} /></div>
                <span className="gpu-bar-value">{comfyStatus.gpu.utilization}%</span>
              </div>
              <div className="gpu-bar-row">
                <span>显存</span>
                <div className="gpu-bar"><span style={{ width: `${(comfyStatus.gpu.memoryUsed / comfyStatus.gpu.memoryTotal) * 100}%` }} /></div>
                <span className="gpu-bar-value">{comfyStatus.gpu.memoryUsed}/{comfyStatus.gpu.memoryTotal}MB</span>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

function Topbar({ view, title, onMenu, comfyStatus, account, onLogout }: { view: View; title: string; onMenu: () => void; comfyStatus: ComfyStatus; account: Account; onLogout: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="icon-button mobile-menu" onClick={onMenu}><Menu size={19} /></button>
        <div>
          <h1>{title}</h1>
          <p>{view === 'create' ? 'MiniMax H3 · 本地 768P' : view === 'drive' ? '服务器完整文件系统' : '本机服务 · 一站式接入'}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <span className={`server-online ${comfyStatus.connected ? '' : 'disconnected'}`}><span className="pulse" />{comfyStatus.connected ? (comfyStatus.workflowConfigured ? 'H3 就绪' : 'ComfyUI 已连接') : 'ComfyUI 未连接'}</span>
        <button className="account-pill" onClick={onLogout} title="退出登录"><span>{account.displayName.slice(0, 1).toUpperCase()}</span>{account.displayName}<small>退出</small></button>
      </div>
    </header>
  )
}

type CreateViewProps = {
  messages: Message[]
  prompt: string
  attachments: Attachment[]
  dragActive: boolean
  aspect: string
  duration: number
  sound: boolean
  advancedOpen: boolean
  materialInputRef: React.RefObject<HTMLInputElement>
  onPromptChange: (value: string) => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onDragEnter: () => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onMaterialChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRemoveAttachment: (id: string) => void
  onAspectChange: (value: string) => void
  onDurationChange: (value: number) => void
  onSoundChange: (value: boolean) => void
  onAdvancedToggle: () => void
  onSubmit: () => void
  onOpenPreview: () => void
  onSaveGeneration: (message: Message) => void
  onCancelGeneration: (jobId: string, threadId: string, assistantMessageId: string) => void
  onDownloadMessage: (message: Message) => void
  threadId: string
}

function CreateView(props: CreateViewProps) {
  const {
    messages,
    prompt,
    attachments,
    dragActive,
    aspect,
    duration,
    sound,
    advancedOpen,
    materialInputRef,
    onPromptChange,
    onPaste,
    onDragEnter,
    onDragLeave,
    onDrop,
    onMaterialChange,
    onRemoveAttachment,
    onAspectChange,
    onDurationChange,
    onSoundChange,
    onAdvancedToggle,
    onSubmit,
    onOpenPreview,
    onSaveGeneration,
    onCancelGeneration,
    onDownloadMessage,
    threadId,
  } = props

  return (
    <div
      className="create-view"
      onDragEnter={(event) => {
        event.preventDefault()
        onDragEnter()
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) onDragLeave()
      }}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="drop-overlay">
          <div><Upload size={30} /><strong>松开即可添加素材</strong><span>支持图片、视频和音频参考</span></div>
        </div>
      )}

      <div className={`conversation ${messages.length ? '' : 'empty'}`}>
        {!messages.length ? <EmptyState onExample={onPromptChange} /> : <MessageList messages={messages} onOpenPreview={onOpenPreview} onSave={onSaveGeneration} onCancel={onCancelGeneration} onDownload={onDownloadMessage} threadId={threadId} />}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((attachment) => (
                <div className="attachment-card" key={attachment.id}>
                  {attachment.type.startsWith('image/') ? (
                    <img src={attachment.url} alt={attachment.name} />
                  ) : attachment.type.startsWith('video/') ? (
                    <div className="attachment-file-icon video"><FileVideo size={21} /></div>
                  ) : (
                    <div className="attachment-file-icon"><File size={21} /></div>
                  )}
                  <div><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></div>
                  <button onClick={() => onRemoveAttachment(attachment.id)} aria-label={`移除 ${attachment.name}`}><X size={14} /></button>
                </div>
              ))}
              {attachments.length < 8 && (
                <button className="attachment-add" onClick={() => materialInputRef.current?.click()}>
                  <Plus size={17} />
                  再添加
                </button>
              )}
            </div>
          )}

          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSubmit()
              }
            }}
            placeholder="描述你想生成的视频，可以直接粘贴图片或拖入素材…"
            rows={3}
          />

          <div className="composer-toolbar">
            <div className="composer-tools-left">
              <button className="add-material-button" onClick={() => materialInputRef.current?.click()}>
                <Plus size={18} />
                <span>添加素材</span>
              </button>
              <input
                ref={materialInputRef}
                className="hidden-input"
                type="file"
                multiple
                accept="image/*,video/*,audio/*"
                onChange={onMaterialChange}
              />
              <span className="mode-pill"><Sparkles size={15} />H3 · 768P</span>
            </div>
            <div className="composer-tools-right">
              <button className={`settings-toggle ${advancedOpen ? 'active' : ''}`} onClick={onAdvancedToggle}>
                <SlidersHorizontal size={16} />
                <span>{aspect} · {duration}s</span>
                <ChevronDown className={advancedOpen ? 'rotated' : ''} size={14} />
              </button>
              <button className="send-button" onClick={onSubmit} disabled={!prompt.trim() && !attachments.length}>
                <ArrowUp size={20} />
              </button>
            </div>
          </div>

          {advancedOpen && (
            <div className="parameter-panel">
              <div className="parameter-group">
                <span className="parameter-label">画面比例</span>
                <div className="segmented compact">
                  {aspectOptions.map((option) => (
                    <button key={option} className={aspect === option ? 'active' : ''} onClick={() => onAspectChange(option)}>{option}</button>
                  ))}
                </div>
              </div>
              <div className="parameter-group duration-group">
                <span className="parameter-label">时长 <b>{duration}s</b></span>
                <input type="range" min="5" max="15" step="1" value={duration} onChange={(event) => onDurationChange(Number(event.target.value))} />
                <div className="range-labels"><span>5s</span><span>10s</span><span>15s</span></div>
              </div>
              <label className="sound-toggle">
                <span><Volume2 size={15} />原生音频</span>
                <input type="checkbox" checked={sound} onChange={(event) => onSoundChange(event.target.checked)} />
                <i />
              </label>
            </div>
          )}
        </div>
        <p className="composer-hint">Enter 发送 · Shift + Enter 换行 · 可拖拽或粘贴素材</p>
      </div>
    </div>
  )
}

function EmptyState({ onExample }: { onExample: (prompt: string) => void }) {
  const examples = [
    '让人物缓慢转身，镜头轻轻推进',
    '生成电影感的海边日落航拍镜头',
    '产品悬浮旋转，柔和光影，干净背景',
  ]
  return (
    <section className="empty-state">
      <div className="hero-orbit">
        <div className="hero-mark"><Clapperboard size={25} /></div>
        <span className="orbit-dot one" />
        <span className="orbit-dot two" />
      </div>
      <span className="eyebrow"><Sparkles size={14} />H3 CREATIVE ENGINE</span>
      <h2>一个入口，生成所有画面</h2>
      <p>加入图片、视频或灵感描述，从首帧到成片都在同一段对话里完成。</p>
      <div className="example-prompts">
        {examples.map((example) => (
          <button key={example} onClick={() => onExample(example)}>
            {example}<ArrowUp size={14} />
          </button>
        ))}
      </div>
    </section>
  )
}

function MessageList({ messages, onOpenPreview, onSave, onCancel, onDownload, threadId }: { messages: Message[]; onOpenPreview: () => void; onSave: (message: Message) => void; onCancel: (jobId: string, threadId: string, assistantMessageId: string) => void; onDownload: (message: Message) => void; threadId: string }) {
  return (
    <div className="message-list">
      {messages.map((message) => message.role === 'user' ? (
        <UserMessage key={message.id} message={message} />
      ) : (
        <AssistantMessage key={message.id} message={message} onOpenPreview={onOpenPreview} onSave={onSave} onCancel={onCancel} onDownload={onDownload} threadId={threadId} />
      ))}
    </div>
  )
}

function UserMessage({ message }: { message: Message }) {
  return (
    <article className="message-row user-row">
      <div className="user-message">
        {!!message.attachments?.length && (
          <div className="message-media-grid">
            {message.attachments.map((attachment) => (
              <div className="message-media" key={attachment.id}>
                {attachment.type.startsWith('image/') ? <img src={attachment.url} alt={attachment.name} /> : (
                  <span>{attachment.type.startsWith('video/') ? <FileVideo size={23} /> : <File size={23} />}<small>{attachment.name}</small></span>
                )}
              </div>
            ))}
          </div>
        )}
        {message.prompt && <p>{message.prompt}</p>}
        <div className="message-meta"><span>{message.aspect}</span><span>{message.duration}s</span><span>{message.createdAt}</span></div>
      </div>
    </article>
  )
}

function AssistantMessage({ message, onOpenPreview, onSave, onCancel, onDownload, threadId }: { message: Message; onOpenPreview: () => void; onSave: (message: Message) => void; onCancel: (jobId: string, threadId: string, assistantMessageId: string) => void; onDownload: (message: Message) => void; threadId: string }) {
  const done = message.status === 'done'
  const failed = message.status === 'failed'
  const currentProgress = done ? 100 : Math.min(96, Math.max(8, message.progress ?? 8))
  const stage = done ? 3 : message.status === 'queued' ? 0 : currentProgress < 60 ? 1 : 2
  const progressLabels = ['排队等待资源', '生成关键帧', '合成视频片段', '完成']
  return (
    <article className="message-row assistant-row">
      <div className="assistant-avatar"><Sparkles size={16} /></div>
      <div className="assistant-content">
        <div className="assistant-label"><strong>H3 Studio</strong><span>{done ? '生成完成' : failed ? '任务未提交' : message.status === 'queued' ? '正在准备任务' : '正在生成视频'}</span></div>
        {failed ? (
          <div className="generation-error-card">
            <span><X size={17} /></span>
            <div><strong>这次任务没有进入队列</strong><p>{message.error || 'ComfyUI 暂时不可用，请稍后重试。'}</p><small>提示词仍保留在本段对话中。</small></div>
          </div>
        ) : !done ? (
          <div className="generation-progress-card">
            <div className="render-preview loading-preview">
              <div className="render-grid" />
              <div className="render-center"><Film size={28} /><span>H3 正在构建画面</span></div>
              <span className="scan-line" />
            </div>
            <div className="progress-info">
              <div className="progress-head"><strong>{progressLabels[stage]}</strong><span>{currentProgress}%</span></div>
              <div className="progress-track"><span style={{ width: `${currentProgress}%` }} /></div>
              {message.samplingSteps && (
                <div className="sampling-steps-info">
                  <span>采样步数：{message.currentStep ?? 0} / {message.samplingSteps}</span>
                </div>
              )}
              <div className="progress-steps">{progressLabels.map((label, index) => <span className={index <= stage ? 'active' : ''} key={label}><i>{index < stage || done && index === 3 ? <Check size={9} /> : index + 1}</i>{label}</span>)}</div>
              <p>{message.note || '任务已持久化，你可以继续提交新的任务。'}</p>
              {message.jobId && (
                <button className="cancel-generation-button" onClick={() => onCancel(message.jobId!, threadId, message.id)}>
                  <Square size={13} />取消任务
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="result-card">
            <div className="render-preview finished-preview">
              {message.outputUrl ? <video src={message.outputUrl} muted={message.sound === false} playsInline preload="metadata" controls /> : <>
                <div className="moon" />
                <div className="city city-back" />
                <div className="city city-front" />
                <div className="road-light one" />
                <div className="road-light two" />
              </>}
              <button className="play-button" onClick={onOpenPreview} aria-label="打开沉浸预览"><Play fill="currentColor" size={19} /></button>
              <span className="duration-badge">00:{String(message.duration).padStart(2, '0')}</span>
            </div>
            <div className="result-bottom">
              <div><strong>视频已生成</strong><span>{message.aspect} · {message.duration}s · 768P</span></div>
              <div className="result-actions">
                <button><Copy size={15} />复制参数</button>
                <button><RotateCcw size={15} />再次生成</button>
                <button onClick={() => onDownload(message)}><Download size={15} />下载视频</button>
                <button className="primary-small" onClick={() => onSave(message)}>保存到云盘</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

type FocusPreviewProps = {
  messages: Message[]
  prompt: string
  aspect: string
  duration: number
  onPromptChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
  onSave: () => void | Promise<void>
  onDownload: () => void | Promise<void>
}

function FocusPreview({ messages, prompt, aspect, duration, onPromptChange, onSubmit, onClose, onSave, onDownload }: FocusPreviewProps) {
  const [playing, setPlaying] = useState(true)
  const [muted, setMuted] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [closing, setClosing] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastResult = [...messages].reverse().find((message) => message.role === 'assistant' && message.status === 'done')
  const outputUrl = lastResult?.outputUrl
  const referenceImage = lastUser?.attachments?.find((attachment) => attachment.type.startsWith('image/'))
  useEffect(() => {
    if (!videoRef.current) return
    if (playing) void videoRef.current.play().catch(() => setPlaying(false))
    else videoRef.current.pause()
  }, [playing, outputUrl])
  const leave = (action: () => void) => {
    if (closing) return
    setClosing(true)
    window.setTimeout(action, 190)
  }

  return (
    <div className={`focus-preview-shell ${closing ? 'closing' : ''}`}>
      <section className="focus-chat-panel">
        <header className="focus-panel-header">
          <div className="focus-header-left">
            <span className="focus-logo"><Sparkles size={16} /></span>
            <div><strong>生成工作台</strong><small>{aspect} · {duration}s · H3</small></div>
          </div>
          <div className="focus-header-actions">
            <button className="icon-button"><MoreHorizontal size={18} /></button>
            <button className="icon-button" onClick={() => leave(onClose)} aria-label="退出沉浸预览"><X size={18} /></button>
          </div>
        </header>

        <div className="focus-conversation">
          <div className="focus-thread-intro">
            <span className="focus-ai-dot"><Sparkles size={14} /></span>
            <div>
              <strong>H3 Studio</strong>
              <p>我会基于你的素材和描述生成视频，并保留当前角色、光线与画面风格。</p>
            </div>
          </div>

          {lastUser && (
            <div className="focus-user-request">
              {referenceImage && <img src={referenceImage.url} alt={referenceImage.name} />}
              <div>
                <span>你的描述</span>
                <p>{lastUser.prompt || '使用参考素材生成动态视频'}</p>
                <small>{aspect} · {duration}s · 768P</small>
              </div>
            </div>
          )}

          <div className="focus-process-line">
            <span className="process-check"><Check size={12} /></span>
            <div><strong>视频生成已完成</strong><small>本地 H3 · 768P · 原生立体声音频</small></div>
          </div>

          <div className="focus-assistant-copy">
            <p>你的视频已经生成好了。</p>
            <button className="focus-result-thumb" onClick={() => setPlaying((value) => !value)}>
              {referenceImage ? <img src={referenceImage.url} alt="生成结果预览" /> : (
                <span className="mini-scene"><i className="mini-moon" /><i className="mini-city" /></span>
              )}
              <span className="thumb-play">{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</span>
              <small>00:{String(duration).padStart(2, '0')}</small>
            </button>
            <div className="focus-feedback-row">
              <button><Copy size={14} /></button>
              <button onClick={() => setMuted((value) => !value)} aria-label={muted ? '打开声音' : '静音'}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
              <button><RotateCcw size={14} /></button>
              <button onClick={() => setMoreOpen((value) => !value)} aria-label="更多操作"><MoreHorizontal size={14} /></button>
              {moreOpen && <div className="focus-more-menu"><button onClick={() => void onDownload()}><Download size={14} />下载视频</button><button onClick={() => setMoreOpen(false)}><Copy size={14} />复制链接</button></div>}
            </div>
          </div>
        </div>

        <div className="focus-composer">
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                leave(onSubmit)
              }
            }}
            placeholder="继续描述要调整的内容…"
            rows={2}
          />
          <div>
            <span className="focus-quick-actions">
              <button><Plus size={17} /></button>
              <button><Zap size={14} />快速</button>
              <button><Video size={14} />视频生成</button>
              <button><Image size={14} />图像生成</button>
            </span>
            <button className="focus-send" onClick={() => leave(onSubmit)} disabled={!prompt.trim()}><ArrowUp size={18} /></button>
          </div>
        </div>
      </section>

      <section className="focus-stage-panel">
        <header className="stage-header">
          <div className="stage-tools">
            <button onClick={() => setZoom((value) => Math.max(.7, +(value - .1).toFixed(1)))} aria-label="缩小"><ZoomOut size={17} /></button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((value) => Math.min(1.3, +(value + .1).toFixed(1)))} aria-label="放大"><ZoomIn size={17} /></button>
            <button onClick={() => setZoom(1)} aria-label="适应画布"><Maximize2 size={16} /></button>
          </div>
          <div className="stage-actions">
            <span className="saved-state"><Check size={13} />已自动保存</span>
            <button className="stage-save" disabled={saveBusy} onClick={async () => { if (saveBusy) return; setSaveBusy(true); try { await onSave() } finally { setSaveBusy(false) } }}><Download size={15} />{saveBusy ? '保存中…' : '保存'}</button>
            <i />
            <button className="stage-close" onClick={() => leave(onClose)} aria-label="关闭"><X size={18} /></button>
          </div>
        </header>

        <div className="stage-canvas-wrap">
          <div className={`focus-video-canvas ${playing ? 'is-playing' : 'is-paused'}`} style={{ transform: `scale(${zoom})` }}>
            {outputUrl ? (
              <video ref={videoRef} className="focus-reference-image" src={outputUrl} muted={muted} playsInline loop />
            ) : referenceImage ? (
              <img className="focus-reference-image" src={referenceImage.url} alt="视频预览" />
            ) : (
              <>
                <div className="focus-sky-glow" />
                <div className="focus-moon" />
                <div className="focus-city focus-city-back" />
                <div className="focus-city focus-city-front" />
                <div className="focus-road-beam beam-one" />
                <div className="focus-road-beam beam-two" />
                <div className="focus-car"><i /><b /></div>
              </>
            )}
            <div className="focus-film-grain" />
            <div className="focus-video-controls">
              <button onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
              <span><Film size={15} />{aspect}</span>
              <span>00:{String(duration).padStart(2, '0')}</span>
            </div>
          </div>

          <aside className="focus-filmstrip">
            {[0, 1, 2].map((item) => (
              <button className={item === 0 ? 'active' : ''} key={item}>
                {referenceImage ? <img src={referenceImage.url} alt={`镜头 ${item + 1}`} /> : <span className={`filmstrip-scene scene-${item + 1}`}><i /><b /></span>}
                <small>{item === 0 ? '主镜头' : `镜头 ${item + 1}`}</small>
              </button>
            ))}
          </aside>
        </div>
      </section>
    </div>
  )
}

type DriveViewProps = {
  items: DriveItem[]
  search: string
  layout: 'list' | 'grid'
  path: string
  storageInfo: StorageInfo
  connected: boolean
  inputRef: React.RefObject<HTMLInputElement>
  onSearch: (value: string) => void
  onLayout: (value: 'list' | 'grid') => void
  onInputChange: (event: ChangeEvent<HTMLInputElement>) => void
  onUpload: (files: File[]) => void
  onFolderOpen: (name: string) => void
  onHome: () => void
  onDownload: (item: DriveItem) => void
  onCreateFolder: (name: string) => void | Promise<void>
}

function DriveView({ items, search, layout, path, storageInfo, connected, inputRef, onSearch, onLayout, onInputChange, onUpload, onFolderOpen, onHome, onDownload, onCreateFolder }: DriveViewProps) {
  const [driveDrag, setDriveDrag] = useState(false)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const usedPercent = storageInfo.total ? Math.round((storageInfo.used / storageInfo.total) * 100) : 0
  return (
    <div
      className="drive-view"
      onDragEnter={(event) => { event.preventDefault(); setDriveDrag(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDriveDrag(false) }}
      onDrop={(event) => {
        event.preventDefault()
        setDriveDrag(false)
        onUpload(Array.from(event.dataTransfer.files))
      }}
    >
      {driveDrag && <div className="drive-drop"><Upload size={26} /><strong>上传到当前目录</strong><span>{path}</span></div>}
      <section className="storage-overview">
        <div className="storage-icon"><HardDrive size={24} /></div>
        <div className="storage-summary">
          <span className="eyebrow">SERVER STORAGE <i className={connected ? 'connection-live' : 'connection-preview'}>{connected ? '实时连接' : '界面预览'}</i></span>
          <h2>服务器文件空间</h2>
          <p>模型、素材与生成结果都保存在同一台服务器，可直接用于视频生成。</p>
        </div>
        <div className="storage-meter-large">
          <div><strong>{formatBytes(storageInfo.used)}</strong><span>已使用，共 {formatBytes(storageInfo.total)}</span></div>
          <div className="storage-track"><span style={{ width: `${usedPercent}%` }} /></div>
          <small>剩余 {formatBytes(storageInfo.free)}</small>
        </div>
      </section>

      <section className="drive-panel">
        <div className="drive-toolbar">
          <div className="drive-actions">
            <button className="primary-button" onClick={() => inputRef.current?.click()}><Upload size={16} />上传文件</button>
            <input ref={inputRef} className="hidden-input" type="file" multiple onChange={onInputChange} />
            <button className="secondary-button" onClick={() => setFolderDialogOpen(true)}><Folder size={16} />新建文件夹</button>
          </div>
          <div className="drive-tools">
            <label className="search-field"><Search size={16} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索当前目录" /></label>
            <div className="layout-switch">
              <button className={layout === 'list' ? 'active' : ''} onClick={() => onLayout('list')}><LayoutList size={17} /></button>
              <button className={layout === 'grid' ? 'active' : ''} onClick={() => onLayout('grid')}><Grid2X2 size={16} /></button>
            </div>
          </div>
        </div>

        <div className="breadcrumb">
          <button onClick={onHome}><HardDrive size={14} />服务器根目录</button>
          {path.split(/[\\/]/).filter(Boolean).slice(-5).map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={14} />{part}</span>)}
        </div>

        {layout === 'list' ? (
          <div className="file-table">
            <div className="file-row file-header"><span>名称</span><span>大小</span><span>修改时间</span><span /></div>
            {items.map((item) => (
              <div className={`file-row ${menuId === item.id ? 'menu-open' : ''}`} key={item.id} onDoubleClick={() => item.kind === 'folder' && onFolderOpen(item.name)}>
                <span className="file-name">
                  <FileTypeIcon item={item} />
                  <span><strong>{item.name}</strong><small>{item.kind === 'folder' ? '文件夹' : item.kind === 'video' ? '视频' : item.kind === 'image' ? '图片' : '文件'}</small></span>
                </span>
                <span>{item.size}</span>
                <span>{item.modified}</span>
                <div className="file-row-actions">
                  <button className="icon-button" onClick={(event) => { event.stopPropagation(); setMenuId(menuId === item.id ? null : item.id) }} aria-label={`更多操作 ${item.name}`}><MoreHorizontal size={17} /></button>
                  {menuId === item.id && <div className="file-menu" onClick={(event) => event.stopPropagation()}>
                    {item.kind === 'folder' ? <button onClick={() => { setMenuId(null); onFolderOpen(item.name) }}><FolderOpen size={14} />打开</button> : <button onClick={() => { setMenuId(null); onDownload(item) }}><Download size={14} />下载</button>}
                  </div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="file-grid">
            {items.map((item) => (
              <button className="file-card" key={item.id} onDoubleClick={() => item.kind === 'folder' && onFolderOpen(item.name)}>
                <div className={`file-card-preview ${item.kind}`}>
                  {item.url && item.kind === 'image' ? <img src={item.url} alt="" /> : <FileTypeIcon item={item} large />}
                </div>
                <strong>{item.name}</strong><span>{item.kind === 'folder' ? item.modified : `${item.size} · ${item.modified}`}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <UnifiedModal
        open={folderDialogOpen}
        title="新建文件夹"
        description={`将在 ${path} 中创建`}
        confirmText="创建"
        confirmDisabled={!folderName.trim()}
        onClose={() => {
          setFolderDialogOpen(false)
          setFolderName('')
        }}
        onConfirm={() => {
          const name = folderName.trim()
          if (!name) return
          void onCreateFolder(name)
          setFolderDialogOpen(false)
          setFolderName('')
        }}
      >
        <label className="ui-field">
          <span>文件夹名称</span>
          <input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="例如：项目素材" />
        </label>
      </UnifiedModal>
    </div>
  )
}

type UnifiedModalProps = {
  open: boolean
  title: string
  description?: string
  className?: string
  confirmText?: string
  confirmDisabled?: boolean
  children: React.ReactNode
  onClose: () => void
  onConfirm: () => void
}

function UnifiedModal({ open, title, description, className = '', confirmText = '确定', confirmDisabled, children, onClose, onConfirm }: UnifiedModalProps) {
  const [closing, setClosing] = useState(false)
  if (!open) return null
  const leave = (action: () => void) => {
    if (closing) return
    setClosing(true)
    window.setTimeout(action, 160)
  }
  return (
    <div className={`ui-overlay ${closing ? 'closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) leave(onClose)
    }}>
      <section className={`ui-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby="ui-dialog-title">
        <header>
          <div><h2 id="ui-dialog-title">{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={() => leave(onClose)} aria-label="关闭弹窗"><X size={17} /></button>
        </header>
        <div className="ui-dialog-body">{children}</div>
        <footer>
          <button className="secondary-button" onClick={() => leave(onClose)}>取消</button>
          <button className="primary-button" disabled={confirmDisabled} onClick={() => leave(onConfirm)}>{confirmText}</button>
        </footer>
      </section>
    </div>
  )
}

function FileTypeIcon({ item, large = false }: { item: DriveItem; large?: boolean }) {
  const size = large ? 32 : 19
  if (item.kind === 'folder') return <span className="file-type-icon folder"><FolderOpen size={size} /></span>
  if (item.kind === 'image') return <span className="file-type-icon image"><FileImage size={size} /></span>
  if (item.kind === 'video') return <span className="file-type-icon video"><FileVideo size={size} /></span>
  return <span className="file-type-icon file"><File size={size} /></span>
}

function EnvironmentView({ onToast }: { onToast: (message: string) => void }) {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [serviceBusy, setServiceBusy] = useState(false)
  const [serviceAction, setServiceAction] = useState<'restart' | 'stop' | null>(null)
  const [command, setCommand] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [harnessConfig, setHarnessConfig] = useState<HarnessConfig | null>(null)
  const [harnessToken, setHarnessToken] = useState(() => window.sessionStorage.getItem('h3-harness-token') || '')
  const [harnessPrompt, setHarnessPrompt] = useState('')
  const [harnessBusy, setHarnessBusy] = useState(false)
  const [harnessMutations, setHarnessMutations] = useState(false)
  const [harnessMessages, setHarnessMessages] = useState<HarnessMessage[]>([])
  const [harnessSetupOpen, setHarnessSetupOpen] = useState(false)
  const [harnessSetupLoading, setHarnessSetupLoading] = useState(false)
  const [harnessSetupSaving, setHarnessSetupSaving] = useState(false)
  const [harnessSetupForm, setHarnessSetupForm] = useState({ apiBase: '', model: '', apiKey: '', clearApiKey: false })
  const [lines, setLines] = useState<TerminalLine[]>([
    { type: 'success', text: 'H3 环境终端已连接', time: new Date().toISOString() },
    { type: 'info', text: '输入 help 查看可用命令', time: new Date().toISOString() },
  ])
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalBootedRef = useRef(false)
  const autoStartRef = useRef(false)
  const comfyComponent = status?.components.find((component) => component.id === 'comfy')
  const comfyRunning = comfyComponent?.status === 'ready'
  const comfyAccessUrl = useMemo(() => {
    if (!status?.comfyUrl) return ''
    try {
      const target = new URL(status.comfyUrl)
      return `${window.location.protocol}//${window.location.hostname}${target.port ? `:${target.port}` : ''}`
    } catch { return '' }
  }, [status?.comfyUrl])

  const refreshStatus = async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const data = await responseJson<EnvironmentStatus>(await fetch('/api/environment/status'))
      setStatus(data)
    } catch (error) {
      if (!quiet) onToast(error instanceof Error ? error.message : '环境状态读取失败')
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  const refreshHarnessConfig = async () => {
    try { setHarnessConfig(await responseJson<HarnessConfig>(await fetch('/api/harness/config'))) }
    catch { setHarnessConfig(null) }
  }

  const openHarnessSetup = async () => {
    setHarnessSetupOpen(true)
    setHarnessSetupForm({ apiBase: '', model: harnessConfig?.model || '', apiKey: '', clearApiKey: false })
    if (!harnessConfig?.configured || !harnessToken.trim()) return
    setHarnessSetupLoading(true)
    try {
      const details = await responseJson<HarnessDetails>(await fetch('/api/harness/config/details', { headers: { Authorization: `Bearer ${harnessToken.trim()}` } }))
      setHarnessSetupForm({ apiBase: details.apiBase, model: details.model, apiKey: '', clearApiKey: false })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '服务器助手配置读取失败')
    } finally { setHarnessSetupLoading(false) }
  }

  const copyHarnessCommand = async () => {
    try {
      await navigator.clipboard.writeText('bash deploy/configure-harness.sh')
      onToast('配置命令已复制')
    } catch { onToast('请复制：bash deploy/configure-harness.sh') }
  }

  const saveHarnessSetup = async () => {
    if (!harnessToken.trim()) { onToast('请先输入服务器助手访问令牌'); return }
    if (!harnessSetupForm.apiBase.trim() || !harnessSetupForm.model.trim()) { onToast('请填写 API 地址和模型名称'); return }
    setHarnessSetupSaving(true)
    try {
      const config = await responseJson<HarnessConfig>(await fetch('/api/harness/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${harnessToken.trim()}` },
        body: JSON.stringify(harnessSetupForm),
      }))
      setHarnessConfig(config)
      setHarnessSetupOpen(false)
      onToast('服务器助手配置已保存')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '服务器助手配置保存失败')
    } finally { setHarnessSetupSaving(false) }
  }

  useEffect(() => {
    void refreshStatus()
    void refreshHarnessConfig()
    if (!terminalBootedRef.current) {
      terminalBootedRef.current = true
      window.setTimeout(() => void runTerminalCommand('status'), 120)
    }
    if (!autoStartRef.current) {
      autoStartRef.current = true
      window.setTimeout(() => void autoStartEnvironment(), 320)
    }
    const timer = window.setInterval(() => void refreshStatus(true), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines, terminalBusy])

  const appendWithMotion = async (nextLines: TerminalLine[]) => {
    for (const nextLine of nextLines) {
      setLines((current) => [...current.slice(-149), nextLine])
      await new Promise((resolve) => window.setTimeout(resolve, 65))
    }
  }

  const prepareEnvironment = async () => {
    if (deploying) return
    setDeploying(true)
    setLines((current) => [...current, { type: 'command', text: '$ deploy', time: new Date().toISOString() }])
    try {
      const data = await responseJson<{ lines: TerminalLine[]; status: EnvironmentStatus }>(await fetch('/api/environment/prepare', { method: 'POST' }))
      await appendWithMotion(data.lines)
      setStatus(data.status)
      onToast(data.status.ready ? 'H3 环境已经就绪' : '基础环境已接入，请处理黄色项目')
    } catch (error) {
      await appendWithMotion([{ type: 'error', text: error instanceof Error ? error.message : '环境接入失败', time: new Date().toISOString() }])
    } finally {
      setDeploying(false)
    }
  }

  const autoStartEnvironment = async () => {
    try {
      const data = await responseJson<{ lines: TerminalLine[]; status: EnvironmentStatus }>(await fetch('/api/environment/auto-start', { method: 'POST' }))
      await appendWithMotion(data.lines)
      setStatus(data.status)
    } catch (error) {
      await appendWithMotion([{ type: 'warning', text: error instanceof Error ? error.message : 'ComfyUI 自动启动失败', time: new Date().toISOString() }])
    }
  }

  const runTerminalCommand = async (requested = command) => {
    const value = requested.trim()
    if (!value || terminalBusy) return
    setCommand('')
    if (value.toLowerCase() === 'clear') {
      setLines([])
      return
    }
    setLines((current) => [...current, { type: 'command', text: `$ ${value}`, time: new Date().toISOString() }])
    setTerminalBusy(true)
    try {
      const data = await responseJson<{ lines: TerminalLine[] }>(await fetch('/api/environment/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: value }),
      }))
      await appendWithMotion(data.lines)
      if (['status', 'deploy'].includes(value.toLowerCase())) void refreshStatus(true)
    } catch (error) {
      await appendWithMotion([{ type: 'error', text: error instanceof Error ? error.message : '终端命令执行失败', time: new Date().toISOString() }])
    } finally {
      setTerminalBusy(false)
    }
  }

  const controlComfyService = async (action: 'start' | 'restart' | 'stop') => {
    if (serviceBusy) return
    setServiceAction(null)
    setServiceBusy(true)
    setLines((current) => [...current, { type: 'command', text: `$ comfy ${action}`, time: new Date().toISOString() }])
    try {
      const data = await responseJson<{ lines: TerminalLine[]; status: EnvironmentStatus }>(await fetch('/api/environment/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }))
      await appendWithMotion(data.lines)
      setStatus(data.status)
      onToast('ComfyUI 服务状态已更新')
    } catch (error) {
      await appendWithMotion([{ type: 'error', text: error instanceof Error ? error.message : '服务操作失败', time: new Date().toISOString() }])
    } finally {
      setServiceBusy(false)
    }
  }

  const sendHarnessMessage = async (requested = harnessPrompt) => {
    const value = requested.trim()
    if (!value || harnessBusy) return
    if (!harnessToken.trim()) { onToast('请输入服务器助手访问令牌'); return }
    const allowMutations = harnessMutations
    setHarnessMutations(false)
    setHarnessPrompt('')
    const history = harnessMessages.slice(-10).map(({ role, content }) => ({ role, content }))
    setHarnessMessages((current) => [...current, { role: 'user', content: value }])
    setHarnessBusy(true)
    try {
      const data = await responseJson<{ reply: string; toolResults: { name: string; ok: boolean; summary: string }[] }>(await fetch('/api/harness/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${harnessToken.trim()}` },
        body: JSON.stringify({ message: value, history, allowMutations }),
      }))
      setHarnessMessages((current) => [...current, { role: 'assistant' as const, content: data.reply, tools: data.toolResults.map((item) => item.name) }].slice(-30))
      if (data.toolResults.some((item) => ['comfy_control'].includes(item.name) && item.ok)) void refreshStatus(true)
    } catch (error) {
      setHarnessMessages((current) => [...current, { role: 'assistant' as const, content: error instanceof Error ? error.message : '服务器助手请求失败' }].slice(-30))
    } finally { setHarnessBusy(false) }
  }

  return (
    <div className="environment-view">
      <section className={`environment-hero ${status?.ready ? 'ready' : ''}`}>
        <div>
          <span className="eyebrow"><span className="pulse" />ONE-CLICK ENVIRONMENT</span>
          <h2>{status?.ready ? 'H3 运行环境已经就绪' : '一站式接入本机 H3 环境'}</h2>
          <p>网页、ComfyUI、工作流、视频工具和服务器云盘统一检查，不需要 SSH 中转。</p>
          <div className="environment-meta"><span>{status?.platform || '正在识别服务器'}</span><i /><span>{status ? `服务已运行 ${Math.floor(status.uptime / 60)} 分钟` : '读取中'}</span></div>
        </div>
        <div className="environment-hero-actions">
          <button className="secondary-button harness-hero-button" onClick={() => void openHarnessSetup()}><Settings size={15} />{harnessConfig?.configured ? '助手设置' : '配置服务器助手'}</button>
          <button className="secondary-button" onClick={() => void refreshStatus()} disabled={loading}><RotateCcw size={15} className={loading ? 'spin' : ''} />刷新</button>
          <button className="primary-button deploy-button" onClick={() => void prepareEnvironment()} disabled={deploying}><Zap size={16} />{deploying ? '正在接入…' : '一键部署并检查'}</button>
        </div>
      </section>

      <section className="environment-components">
        <div className="environment-section-title"><div><h3>部署环境</h3><p>所有状态均来自当前服务器</p></div><span className={status?.ready ? 'all-ready' : ''}>{status?.ready ? '全部就绪' : '等待完成'}</span></div>
        <div className="environment-grid">
          {(status?.components || []).map((component, index) => (
            <article className={`environment-card ${component.status}`} key={component.id} style={{ animationDelay: `${index * 45}ms` }}>
              <span className="environment-card-icon">{environmentIcon(component.id)}</span>
              <div><strong>{component.name}</strong><small>{component.detail}</small></div>
              <span className="component-state">{component.status === 'ready' ? <Check size={13} /> : component.status === 'development' ? <Activity size={13} /> : <X size={13} />}</span>
            </article>
          ))}
          {!status && Array.from({ length: 6 }).map((_, index) => <div className="environment-card skeleton" key={index} />)}
        </div>
      </section>

      <section className="ui-terminal-panel">
        <header>
          <div className="terminal-title"><span className="terminal-dots"><i /><i /><i /></span><div><strong>ComfyUI / H3 实例终端</strong><small>受控运维通道 · 本机执行</small></div><span className={`terminal-runtime ${comfyRunning ? 'online' : ''}`}><i />{comfyRunning ? '实例运行中' : '等待实例'}</span></div>
          <div className="terminal-header-actions">
            {comfyRunning && comfyAccessUrl && <a href={comfyAccessUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开 ComfyUI</a>}
            {!comfyRunning && <button onClick={() => void controlComfyService('start')} disabled={serviceBusy}><Play size={14} />启动</button>}
            {comfyRunning && <button onClick={() => setServiceAction('restart')} disabled={serviceBusy}><RotateCcw size={14} />重启</button>}
            {comfyRunning && <button className="danger" onClick={() => setServiceAction('stop')} disabled={serviceBusy}><Square size={13} />停止</button>}
            <button className="terminal-clear" onClick={() => setLines([])}><Trash2 size={14} />清空</button>
          </div>
        </header>
        <div className="terminal-shortcuts">
          {['status', 'health', 'queue', 'storage', 'logs', 'comfy-logs'].map((item) => <button key={item} onClick={() => void runTerminalCommand(item)} disabled={terminalBusy}>{item}</button>)}
        </div>
        <div className="terminal-output" ref={terminalRef} aria-live="polite">
          {lines.map((item, index) => (
            <p className={item.type} key={`${item.time}-${index}`}><time>{new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{item.text}</span></p>
          ))}
          {terminalBusy && <p className="terminal-wait"><time>··:··:··</time><span><i /><i /><i /></span></p>}
        </div>
        <form className="terminal-input-row" onSubmit={(event) => { event.preventDefault(); void runTerminalCommand() }}>
          <span>h3@server:~$</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入 help 查看命令" autoComplete="off" spellCheck={false} />
          <button disabled={!command.trim() || terminalBusy} aria-label="执行终端命令"><ArrowUp size={15} /></button>
        </form>
      </section>

      <section className="server-harness-panel">
        <header>
          <div className="harness-title"><span><Bot size={18} /></span><div><strong>服务器助手</strong><small>{harnessConfig?.configured ? `${harnessConfig.model} · 安全工具模式` : '等待接入你的 API'}</small></div></div>
          <div className="harness-header-actions"><button className="harness-config-button" onClick={() => void openHarnessSetup()}><Settings size={13} />配置</button><span className={`harness-state ${harnessConfig?.configured ? 'online' : ''}`}><i />{harnessConfig?.configured ? '已配置' : '未配置'}</span></div>
        </header>
        {!harnessConfig?.configured ? (
          <div className="harness-empty"><ShieldCheck size={21} /><div><strong>先在服务器完成一次安全配置</strong><p>运行 <code>bash deploy/configure-harness.sh</code>，填写 API 地址、模型和密钥。API Key 不会发送到浏览器。</p></div></div>
        ) : (
          <>
            <div className="harness-access-row">
              <label><span>访问令牌</span><input type="password" value={harnessToken} onChange={(event) => {
                setHarnessToken(event.target.value)
                window.sessionStorage.setItem('h3-harness-token', event.target.value)
              }} placeholder="配置脚本生成的网页令牌" autoComplete="off" /></label>
              <label className="harness-permission"><input type="checkbox" checked={harnessMutations} onChange={(event) => setHarnessMutations(event.target.checked)} /><span><ShieldCheck size={13} />允许本次执行 ComfyUI 服务操作</span></label>
            </div>
            <div className="harness-quick-actions">
              {['检查服务器整体状态', '为什么当前不能生成视频？', '查看 GPU 和磁盘资源', '分析最近的 H3 日志'].map((item) => <button key={item} disabled={harnessBusy} onClick={() => void sendHarnessMessage(item)}>{item}</button>)}
            </div>
            <div className="harness-messages" aria-live="polite">
              {!harnessMessages.length && <div className="harness-welcome"><Bot size={20} /><p>可以询问服务器状态、磁盘、GPU、进程、端口、日志和 ComfyUI。默认只读。</p></div>}
              {harnessMessages.map((message, index) => <article className={message.role} key={`${message.role}-${index}`}><strong>{message.role === 'user' ? '你' : '助手'}</strong><p>{message.content}</p>{Boolean(message.tools?.length) && <small>已使用：{message.tools?.join('、')}</small>}</article>)}
              {harnessBusy && <article className="assistant thinking"><strong>助手</strong><p><i /><i /><i /></p></article>}
            </div>
            <form className="harness-input" onSubmit={(event) => { event.preventDefault(); void sendHarnessMessage() }}>
              <textarea value={harnessPrompt} onChange={(event) => setHarnessPrompt(event.target.value)} placeholder="例如：检查磁盘为什么满了，并告诉我应该怎么处理" rows={2} />
              <button disabled={!harnessPrompt.trim() || harnessBusy} aria-label="发送给服务器助手"><ArrowUp size={16} /></button>
            </form>
          </>
        )}
      </section>
      <UnifiedModal
        open={harnessSetupOpen}
        className="harness-dialog"
        title={harnessConfig?.configured ? '服务器助手设置' : '配置服务器助手'}
        description={harnessConfig?.configured ? '修改后立即对当前 H3 服务生效。' : '首次接入需要在服务器上运行一次配置命令。'}
        confirmText={harnessConfig?.configured ? (harnessSetupSaving ? '保存中…' : '保存配置') : '复制配置命令'}
        confirmDisabled={harnessConfig?.configured ? harnessSetupLoading || harnessSetupSaving || !harnessToken.trim() || !harnessSetupForm.apiBase.trim() || !harnessSetupForm.model.trim() : false}
        onClose={() => setHarnessSetupOpen(false)}
        onConfirm={() => { if (harnessConfig?.configured) void saveHarnessSetup(); else void copyHarnessCommand() }}
      >
        {!harnessConfig?.configured ? (
          <div className="harness-setup-guide">
            <div className="harness-command-card"><div><span>在服务器项目目录执行</span><code>bash deploy/configure-harness.sh</code></div><button onClick={() => void copyHarnessCommand()}><Copy size={14} />复制</button></div>
            <ol><li>填写你的 API 基础地址、模型名称和 API Key。</li><li>脚本会生成网页访问令牌并自动重启 H3。</li><li>回到这里刷新页面，再输入访问令牌即可使用。</li></ol>
            <p className="harness-setup-note"><ShieldCheck size={14} />API Key 只保存在服务器，不会写入浏览器或日志。</p>
          </div>
        ) : (
          <div className="harness-config-form">
            {harnessSetupLoading ? <div className="harness-config-loading">正在读取当前配置…</div> : <>
              <label className="ui-field"><span>网页访问令牌</span><input type="password" value={harnessToken} onChange={(event) => { setHarnessToken(event.target.value); window.sessionStorage.setItem('h3-harness-token', event.target.value) }} placeholder="配置脚本生成的令牌" autoComplete="off" /></label>
              <label className="ui-field"><span>API 基础地址</span><input value={harnessSetupForm.apiBase} onChange={(event) => setHarnessSetupForm((current) => ({ ...current, apiBase: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
              <label className="ui-field"><span>模型名称</span><input value={harnessSetupForm.model} onChange={(event) => setHarnessSetupForm((current) => ({ ...current, model: event.target.value }))} placeholder="例如：ops-model" /></label>
              <label className="ui-field"><span>API Key <em>留空保持现有密钥</em></span><input type="password" value={harnessSetupForm.apiKey} onChange={(event) => setHarnessSetupForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={harnessSetupForm.clearApiKey ? '已选择清除密钥' : '不会回显现有密钥'} autoComplete="new-password" /></label>
              <label className="harness-clear-key"><input type="checkbox" checked={harnessSetupForm.clearApiKey} onChange={(event) => setHarnessSetupForm((current) => ({ ...current, clearApiKey: event.target.checked, apiKey: '' }))} /><span>清除当前 API Key（仅无鉴权内网 API 使用）</span></label>
              <p className="harness-setup-note"><ShieldCheck size={14} />保存写入服务器 .h3.env，API Key 不会返回到页面。</p>
            </>}
          </div>
        )}
      </UnifiedModal>
      <UnifiedModal
        open={Boolean(serviceAction)}
        title={serviceAction === 'stop' ? '停止 ComfyUI？' : '重启 ComfyUI？'}
        description={serviceAction === 'stop' ? '正在执行的生成任务可能会中断。' : '当前生成任务会短暂暂停，服务恢复后可继续检查。'}
        confirmText={serviceAction === 'stop' ? '确认停止' : '确认重启'}
        onClose={() => setServiceAction(null)}
        onConfirm={() => { if (serviceAction) void controlComfyService(serviceAction) }}
      >
        <div className="service-confirm-copy"><Server size={19} /><span><strong>本机 ComfyUI</strong><small>{comfyComponent?.detail || '读取服务状态中'}</small></span></div>
      </UnifiedModal>
    </div>
  )
}

function environmentIcon(id: EnvironmentComponent['id']) {
  if (id === 'web') return <Activity size={19} />
  if (id === 'comfy') return <Server size={19} />
  if (id === 'workflow') return <WandSparkles size={19} />
  if (id === 'ffmpeg') return <Film size={19} />
  if (id === 'storage') return <HardDrive size={19} />
  return <CircleGauge size={19} />
}

export default App
