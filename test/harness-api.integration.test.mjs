import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await close(server)
  return port
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return

  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 3000)
    forceTimer.unref()
    child.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

test('HTTP harness endpoint requires its access token and keeps the API key server-side', async () => {
  let upstreamRequest
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    upstreamRequest = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '模拟服务器检查完成。' } }] }))
  })
  const upstreamPort = await listen(upstream)
  const h3Port = await freePort()
  const root = await mkdtemp(path.join(tmpdir(), 'h3-harness-integration-'))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    stdio: 'ignore',
    env: {
      ...process.env,
      H3_HOST: '127.0.0.1', H3_PORT: String(h3Port), H3_AUTO_START_COMFYUI: '0', H3_MIN_FREE_BYTES: '0',
      H3_DATA_ROOT: path.join(root, 'data'), H3_LOG_ROOT: path.join(root, 'logs'), H3_STORAGE_ROOT: path.join(root, 'storage'),
      H3_ENV_FILE: path.join(root, '.h3.env'),
      H3_HARNESS_API_BASE: `http://127.0.0.1:${upstreamPort}/v1`, H3_HARNESS_MODEL: 'mock-ops-model',
      H3_HARNESS_API_KEY: 'upstream-secret', H3_HARNESS_ACCESS_TOKEN: 'browser-access-token',
    },
  })

  try {
    await waitFor(`http://127.0.0.1:${h3Port}/api/health`)
    const config = await fetch(`http://127.0.0.1:${h3Port}/api/harness/config`).then((response) => response.json())
    assert.equal(config.configured, true)
    assert.equal(config.hasApiKey, true)
    assert.equal(JSON.stringify(config).includes('upstream-secret'), false)
    assert.equal(JSON.stringify(config).includes(`127.0.0.1:${upstreamPort}`), false)

    const detailsUnauthorized = await fetch(`http://127.0.0.1:${h3Port}/api/harness/config/details`)
    assert.equal(detailsUnauthorized.status, 401)

    const details = await fetch(`http://127.0.0.1:${h3Port}/api/harness/config/details`, { headers: { Authorization: 'Bearer browser-access-token' } }).then((response) => response.json())
    assert.equal(details.apiBase, `http://127.0.0.1:${upstreamPort}/v1`)
    assert.equal(details.hasApiKey, true)
    assert.equal(JSON.stringify(details).includes('upstream-secret'), false)

    const updated = await fetch(`http://127.0.0.1:${h3Port}/api/harness/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-access-token' },
      body: JSON.stringify({ apiBase: `http://127.0.0.1:${upstreamPort}/v1`, model: 'updated-ops-model', apiKey: 'updated-secret' }),
    })
    assert.equal(updated.status, 200)
    assert.equal(JSON.stringify(await updated.json()).includes('updated-secret'), false)
    assert.match(await readFile(path.join(root, '.h3.env'), 'utf8'), /H3_HARNESS_MODEL='updated-ops-model'/)

    const unauthorized = await fetch(`http://127.0.0.1:${h3Port}/api/harness/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '检查服务器' }),
    })
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`http://127.0.0.1:${h3Port}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-access-token' },
      body: JSON.stringify({ message: '检查服务器', allowMutations: false }),
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).reply, '模拟服务器检查完成。')
    assert.equal(upstreamRequest.url, '/v1/chat/completions')
    assert.equal(upstreamRequest.authorization, 'Bearer updated-secret')
    assert.equal(upstreamRequest.body.model, 'updated-ops-model')
  } finally {
    await stopChild(child)
    upstream.closeAllConnections?.()
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})
