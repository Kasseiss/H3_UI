import assert from 'node:assert/strict'
import test from 'node:test'
import { createServerHarness } from '../lib/server-harness.mjs'

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('sends an OpenAI-compatible request without leaking config into the result', async () => {
  let request
  const harness = createServerHarness({
    config: { apiBase: 'https://example.test/v1/', model: 'private-model', apiKey: 'secret-key' },
    tools: [],
    fetchImpl: async (url, options) => {
      request = { url, options }
      return response({ choices: [{ message: { role: 'assistant', content: '服务器正常。' } }] })
    },
  })
  const result = await harness.chat({ message: '检查服务器' })
  assert.equal(result.reply, '服务器正常。')
  assert.equal(request.url, 'https://example.test/v1/chat/completions')
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key')
  assert.equal(JSON.parse(request.options.body).model, 'private-model')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('executes a read-only tool and feeds its result back to the model', async () => {
  const requests = []
  let executions = 0
  const harness = createServerHarness({
    config: { apiBase: 'https://example.test/v1', model: 'ops-model' },
    tools: [{
      name: 'server_resources', description: 'resources', mutating: false,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { executions += 1; return { diskFreeGb: 12 } },
    }],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      if (requests.length === 1) return response({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'server_resources', arguments: '{}' } }] } }] })
      return response({ choices: [{ message: { role: 'assistant', content: '磁盘剩余 12 GB。' } }] })
    },
  })
  const result = await harness.chat({ message: '磁盘还有多少？' })
  assert.equal(executions, 1)
  assert.equal(result.reply, '磁盘剩余 12 GB。')
  assert.deepEqual(result.toolResults, [{ name: 'server_resources', ok: true, summary: '执行完成' }])
  assert.equal(requests[1].messages.at(-1).role, 'tool')
})

test('does not expose mutating tools unless explicitly allowed', async () => {
  const offered = []
  const mutatingTool = {
    name: 'comfy_control', description: 'control', mutating: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({}),
  }
  const harness = createServerHarness({
    config: { apiBase: 'https://example.test/v1', model: 'ops-model' },
    tools: [mutatingTool],
    fetchImpl: async (_url, options) => {
      offered.push(JSON.parse(options.body).tools)
      return response({ choices: [{ message: { role: 'assistant', content: '只读检查完成。' } }] })
    },
  })
  await harness.chat({ message: '检查', allowMutations: false })
  await harness.chat({ message: '重启 ComfyUI', allowMutations: true })
  assert.equal(offered[0].length, 0)
  assert.equal(offered[1][0].function.name, 'comfy_control')
})

test('surfaces compatible API errors without exposing the key', async () => {
  const harness = createServerHarness({
    config: { apiBase: 'https://example.test/v1', model: 'ops-model', apiKey: 'never-show-me' },
    tools: [], fetchImpl: async () => response({ error: { message: 'model unavailable' } }, 503),
  })
  await assert.rejects(() => harness.chat({ message: '检查' }), /model unavailable/)
})

test('turns network failures into an actionable message', async () => {
  const harness = createServerHarness({
    config: { apiBase: 'https://example.test/v1', model: 'ops-model' },
    tools: [], fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  await assert.rejects(
    () => harness.chat({ message: '检查' }),
    /无法连接 Harness API，请检查 API 地址和服务状态/,
  )
})

test('rejects unsupported API URL schemes before sending a request', async () => {
  const harness = createServerHarness({
    config: { apiBase: 'file:///tmp/private', model: 'ops-model' },
    tools: [], fetchImpl: async () => { throw new Error('should not run') },
  })
  await assert.rejects(() => harness.chat({ message: '检查' }), /仅支持 HTTP 或 HTTPS/)
})
