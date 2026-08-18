const DEFAULT_SYSTEM_PROMPT = `你是 H3 Studio 的服务器运维助手。你只能依据工具返回的真实数据回答，不能假装执行过操作。
优先使用简洁中文说明当前状态、原因和下一步。不要索取或输出 API 密钥、访问令牌等秘密。
只管理 H3 Studio、ComfyUI 及它们使用的服务器资源。禁止建议绕过权限、安全控制或磁盘保护。`

function chatEndpoint(apiBase) {
  const normalized = String(apiBase || '').trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('Harness API 地址尚未配置')
  const endpoint = normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
  let parsed
  try { parsed = new URL(endpoint) } catch { throw new Error('Harness API 地址无效，请填写完整的 HTTP 或 HTTPS 地址') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Harness API 仅支持 HTTP 或 HTTPS 地址')
  return parsed.toString()
}

function textContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n').trim()
}

function parseArguments(value) {
  if (!value) return {}
  let parsed
  try { parsed = JSON.parse(value) } catch { throw new Error('模型返回了无效的工具参数') }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('工具参数必须是 JSON 对象')
  return parsed
}

function toolDefinition(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false },
    },
  }
}

function safeHistory(history) {
  if (!Array.isArray(history)) return []
  return history.slice(-12).flatMap((item) => {
    if (!['user', 'assistant'].includes(item?.role)) return []
    const content = String(item.content || '').trim().slice(0, 6000)
    return content ? [{ role: item.role, content }] : []
  })
}

export function createServerHarness({ config, tools, fetchImpl = fetch, systemPrompt = DEFAULT_SYSTEM_PROMPT }) {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))

  async function requestModel(messages, enabledTools) {
    const controller = new AbortController()
    const timeoutMs = Math.min(120000, Math.max(5000, Number(config.timeoutMs) || 45000))
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
      const response = await fetchImpl(chatEndpoint(config.apiBase), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: enabledTools.map(toolDefinition),
          tool_choice: 'auto',
        }),
        signal: controller.signal,
      })
      const raw = await response.text()
      let data
      try { data = JSON.parse(raw) } catch { throw new Error(`Harness API 返回了非 JSON 内容 (${response.status})`) }
      if (!response.ok) throw new Error(data?.error?.message || `Harness API 请求失败 (${response.status})`)
      const message = data?.choices?.[0]?.message
      if (!message) throw new Error('Harness API 没有返回有效消息')
      return message
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Harness API 响应超时')
      if (error instanceof TypeError) throw new Error('无法连接 Harness API，请检查 API 地址和服务状态')
      throw error
    } finally { clearTimeout(timer) }
  }

  return {
    async chat({ message, history = [], allowMutations = false }) {
      const userMessage = String(message || '').trim().slice(0, 8000)
      if (!userMessage) throw new Error('请输入服务器管理问题')
      if (!config.apiBase || !config.model) throw new Error('Harness 尚未配置 API 地址和模型')
      const enabledTools = tools.filter((tool) => allowMutations || !tool.mutating)
      const messages = [{ role: 'system', content: systemPrompt }, ...safeHistory(history), { role: 'user', content: userMessage }]
      const toolResults = []

      for (let round = 0; round < 5; round += 1) {
        const assistant = await requestModel(messages, enabledTools)
        const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls.slice(0, 6) : []
        if (!calls.length) {
          const reply = textContent(assistant.content)
          if (!reply) throw new Error('Harness API 返回了空回复')
          return { reply, toolResults }
        }
        messages.push({ role: 'assistant', content: assistant.content ?? null, tool_calls: calls })
        for (const call of calls) {
          const name = String(call?.function?.name || '')
          const tool = toolMap.get(name)
          let result
          let ok = true
          try {
            if (!tool || !enabledTools.includes(tool)) throw new Error(`工具 ${name || '(空)'} 未授权`)
            result = await tool.execute(parseArguments(call.function.arguments))
          } catch (error) {
            ok = false
            result = { error: error instanceof Error ? error.message : '工具执行失败' }
          }
          const content = JSON.stringify(result).slice(0, 16000)
          toolResults.push({ name, ok, summary: ok ? '执行完成' : result.error })
          messages.push({ role: 'tool', tool_call_id: String(call.id || `tool-${round}`), content })
        }
      }
      throw new Error('Harness 工具调用轮次过多，已安全停止')
    },
  }
}

export { chatEndpoint }
