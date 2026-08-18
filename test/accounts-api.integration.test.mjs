import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function waitFor(url) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    timer.unref()
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0]
}

test('accounts share the global queue while generation and storage APIs require a session', async () => {
  const h3PortServer = createServer()
  const h3Port = await listen(h3PortServer)
  await new Promise((resolve) => h3PortServer.close(resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'h3-accounts-integration-'))
  const base = `http://127.0.0.1:${h3Port}`
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'), stdio: 'ignore', env: {
      ...process.env, H3_HOST: '127.0.0.1', H3_PORT: String(h3Port), H3_AUTO_START_COMFYUI: '0', H3_MIN_FREE_BYTES: '0',
      H3_DATA_ROOT: path.join(root, 'data'), H3_LOG_ROOT: path.join(root, 'logs'), H3_STORAGE_ROOT: path.join(root, 'storage'),
      COMFYUI_URL: 'http://127.0.0.1:59999',
    },
  })
  try {
    await waitFor(`${base}/api/health`)
    assert.equal((await fetch(`${base}/api/generations`)).status, 401)

    const firstResponse = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'first', displayName: '第一个账号', password: 'password123' }) })
    assert.equal(firstResponse.status, 201)
    const firstCookie = cookieFrom(firstResponse)
    const secondResponse = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'second', displayName: '第二个账号', password: 'password123' }) })
    assert.equal(secondResponse.status, 201)
    const secondCookie = cookieFrom(secondResponse)

    const firstJobs = await fetch(`${base}/api/generations`, { headers: { Cookie: firstCookie } }).then((response) => response.json())
    const secondJobs = await fetch(`${base}/api/generations`, { headers: { Cookie: secondCookie } }).then((response) => response.json())
    assert.equal(firstJobs.jobs.length, 0)
    assert.equal(secondJobs.jobs.length, 0)
    assert.equal(firstJobs.queue.preview, 5)
    assert.equal(secondJobs.queue.preview, 5)

    const drive = await fetch(`${base}/api/storage/list?scope=server&path=%2F`, { headers: { Cookie: firstCookie } })
    assert.equal(drive.status, 200)
    assert.equal((await drive.json()).scope, 'server')
    assert.equal((await fetch(`${base}/api/storage/list?scope=server&path=%2F`)).status, 401)
  } finally {
    await stopChild(child)
    await rm(root, { recursive: true, force: true })
  }
})

test('dispatches the oldest queued generation when ComfyUI reports capacity', async () => {
  let promptCount = 0
  const comfy = createServer(async (req, res) => {
    if (req.url === '/system_stats') return res.end(JSON.stringify({ devices: [{ name: 'Mock GPU' }] }))
    if (req.url === '/queue') return res.end(JSON.stringify({ queue_running: promptCount ? [['running']] : [], queue_pending: [] }))
    if (req.url === '/object_info/UNETLoader') return res.end(JSON.stringify({ UNETLoader: { input: { required: { unet_name: [['minimax_h3_ref2va_int8.safetensors']] } } } }))
    if (req.url === '/object_info/CLIPLoader') return res.end(JSON.stringify({ CLIPLoader: { input: { required: { clip_name: [['minimax_h3_clip.safetensors']] } } } }))
    if (req.url === '/object_info/VAELoader') return res.end(JSON.stringify({ VAELoader: { input: { required: { vae_name: [['minimax_h3_video_vae.safetensors', 'minimax_h3_audio_vae.safetensors']] } } } }))
    if (req.url === '/prompt') { promptCount += 1; return res.end(JSON.stringify({ prompt_id: `mock-${promptCount}` })) }
    if (req.url?.startsWith('/history/')) return res.end(JSON.stringify({}))
    res.writeHead(404); return res.end()
  })
  const comfyPort = await listen(comfy)
  const h3PortServer = createServer()
  const h3Port = await listen(h3PortServer)
  await new Promise((resolve) => h3PortServer.close(resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'h3-queue-integration-'))
  const base = `http://127.0.0.1:${h3Port}`
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'), stdio: 'ignore', env: {
      ...process.env, H3_HOST: '127.0.0.1', H3_PORT: String(h3Port), H3_AUTO_START_COMFYUI: '0', H3_MIN_FREE_BYTES: '0', H3_MAX_CONCURRENT_JOBS: '1',
      H3_DATA_ROOT: path.join(root, 'data'), H3_LOG_ROOT: path.join(root, 'logs'), H3_STORAGE_ROOT: path.join(root, 'storage'), COMFYUI_URL: `http://127.0.0.1:${comfyPort}`,
    },
  })
  try {
    await waitFor(`${base}/api/health`)
    const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'queueuser', password: 'password123' }) })
    const cookie = cookieFrom(register)
    const queued = await fetch(`${base}/api/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ prompt: '测试队列分配', aspect: '16:9', duration: 5, sound: true }) }).then((response) => response.json())
    assert.equal(queued.job.status, 'queued')
    const deadline = Date.now() + 5000
    let jobs
    while (Date.now() < deadline) {
      jobs = await fetch(`${base}/api/generations`, { headers: { Cookie: cookie } }).then((response) => response.json())
      if (jobs.jobs[0]?.status === 'generating') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(promptCount, 1)
    assert.equal(jobs.jobs[0].status, 'generating')
  } finally {
    await stopChild(child)
    await new Promise((resolve) => comfy.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
