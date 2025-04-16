import {
  getOpenAIWebSearchParams,
  isHunyuanSearchModel,
  isOpenAIWebSearch,
  isZhipuModel
} from '@renderer/config/models'
import { SEARCH_SUMMARY_PROMPT } from '@renderer/config/prompts'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { setGenerating } from '@renderer/store/runtime'
import { Assistant, MCPTool, Message, Model, Provider, Suggestion, WebSearchResponse } from '@renderer/types'
import { formatMessageError, isAbortError } from '@renderer/utils/error'
import { fetchWebContents } from '@renderer/utils/fetch'
import { withGenerateImage } from '@renderer/utils/formats'
import {
  cleanLinkCommas,
  completeLinks,
  convertLinks,
  convertLinksToHunyuan,
  convertLinksToOpenRouter,
  convertLinksToZhipu,
  extractUrlsFromMarkdown
} from '@renderer/utils/linkConverter'
import { cloneDeep, findLast, isEmpty } from 'lodash'

import AiProvider from '../providers/AiProvider'
import {
  getAssistantProvider,
  getDefaultAssistant,
  getDefaultModel,
  getProviderByModel,
  getTopNamingModel,
  getTranslateModel
} from './AssistantService'
import { EVENT_NAMES, EventEmitter } from './EventService'
import { filterContextMessages, filterMessages, filterUsefulMessages } from './MessagesService'
import { estimateMessagesUsage } from './TokenService'
import WebSearchService from './WebSearchService'

export async function fetchChatCompletion({
  message,
  messages,
  assistant,
  onResponse
}: {
  message: Message
  messages: Message[]
  assistant: Assistant
  onResponse: (message: Message) => void
}) {
  const provider = getAssistantProvider(assistant)
  const webSearchProvider = WebSearchService.getWebSearchProvider()
  const AI = new AiProvider(provider)

  const searchTheWeb = async () => {
    if (WebSearchService.isWebSearchEnabled() && assistant.enableWebSearch && assistant.model) {
      let query = ''
      let webSearchResponse: WebSearchResponse = {
        results: []
      }
      const webSearchParams = getOpenAIWebSearchParams(assistant, assistant.model)
      if (isEmpty(webSearchParams) && !isOpenAIWebSearch(assistant.model)) {
        const lastMessage = findLast(messages, (m) => m.role === 'user')
        const lastAnswer = findLast(messages, (m) => m.role === 'assistant')
        const hasKnowledgeBase = !isEmpty(lastMessage?.knowledgeBaseIds)

        if (lastMessage) {
          if (hasKnowledgeBase) {
            window.message.info({
              content: i18n.t('message.ignore.knowledge.base'),
              key: 'knowledge-base-no-match-info'
            })
          }

          // 更新消息状态为搜索中
          onResponse({ ...message, status: 'searching' })

          try {
            // 等待关键词生成完成
            const searchSummaryAssistant = getDefaultAssistant()
            searchSummaryAssistant.model = assistant.model || getDefaultModel()
            searchSummaryAssistant.prompt = SEARCH_SUMMARY_PROMPT

            // 如果启用搜索增强模式，则使用搜索增强模式
            if (WebSearchService.isEnhanceModeEnabled()) {
              const keywords = await fetchSearchSummary({
                messages: lastAnswer ? [lastAnswer, lastMessage] : [lastMessage],
                assistant: searchSummaryAssistant
              })

              try {
                const result = WebSearchService.extractInfoFromXML(keywords || '')
                if (result.question === 'not_needed') {
                  // 如果不需要搜索，则直接返回
                  console.log('No need to search')
                  return
                } else if (result.question === 'summarize' && result.links && result.links.length > 0) {
                  const contents = await fetchWebContents(result.links)
                  webSearchResponse = {
                    query: 'summaries',
                    results: contents
                  }
                } else {
                  query = result.question
                  webSearchResponse = await WebSearchService.search(webSearchProvider, query)
                }
              } catch (error) {
                console.error('Failed to extract info from XML:', error)
              }
            } else {
              query = lastMessage.content
            }

            // 处理搜索结果
            message.metadata = {
              ...message.metadata,
              webSearch: webSearchResponse
            }

            window.keyv.set(`web-search-${lastMessage?.id}`, webSearchResponse)
          } catch (error) {
            console.error('Web search failed:', error)
          }
        }
      }
    }
  }

  try {
    let _messages: Message[] = []
    let isFirstChunk = true

    // Search web
    await searchTheWeb()

    const lastUserMessage = findLast(messages, (m) => m.role === 'user')
    // Get MCP tools
    const mcpTools: MCPTool[] = []
    const enabledMCPs = lastUserMessage?.enabledMCPs

    if (enabledMCPs && enabledMCPs.length > 0) {
      for (const mcpServer of enabledMCPs) {
        const tools = await window.api.mcp.listTools(mcpServer)
        const availableTools = tools.filter((tool: any) => !mcpServer.disabledTools?.includes(tool.name))
        mcpTools.push(...availableTools)
      }
    }

    await AI.completions({
      messages: filterUsefulMessages(filterContextMessages(messages)),
      assistant,
      onFilterMessages: (messages) => (_messages = messages),
      onChunk: ({
        text,
        reasoning_content,
        usage,
        metrics,
        webSearch,
        search,
        annotations,
        citations,
        mcpToolResponse,
        generateImage
      }) => {
        if (assistant.model) {
          if (isOpenAIWebSearch(assistant.model)) {
            text = convertLinks(text || '', isFirstChunk)
          } else if (assistant.model.provider === 'openrouter' && assistant.enableWebSearch) {
            text = convertLinksToOpenRouter(text || '', isFirstChunk)
          } else if (assistant.enableWebSearch) {
            if (isZhipuModel(assistant.model)) {
              text = convertLinksToZhipu(text || '', isFirstChunk)
            } else if (isHunyuanSearchModel(assistant.model)) {
              text = convertLinksToHunyuan(text || '', webSearch || [], isFirstChunk)
            }
          }
        }
        if (isFirstChunk) {
          isFirstChunk = false
        }
        message.content = message.content + text || ''
        message.usage = usage
        message.metrics = metrics

        if (reasoning_content) {
          message.reasoning_content = (message.reasoning_content || '') + reasoning_content
        }

        if (mcpToolResponse) {
          message.metadata = { ...message.metadata, mcpTools: cloneDeep(mcpToolResponse) }
        }

        if (generateImage && generateImage.images.length > 0) {
          const existingImages = message.metadata?.generateImage?.images || []
          generateImage.images = [...existingImages, ...generateImage.images]
          console.log('generateImage', generateImage)
          message.metadata = {
            ...message.metadata,
            generateImage: generateImage
          }
        }

        // Handle citations from Perplexity API
        if (citations) {
          message.metadata = {
            ...message.metadata,
            citations
          }
        }

        // Handle web search from Gemini
        if (search) {
          message.metadata = { ...message.metadata, groundingMetadata: search }
        }

        // Handle annotations from OpenAI
        if (annotations) {
          message.metadata = {
            ...message.metadata,
            annotations: annotations
          }
        }

        // Handle web search from Zhipu or Hunyuan
        if (webSearch) {
          message.metadata = {
            ...message.metadata,
            webSearchInfo: webSearch
          }
        }

        // Handle citations from Openrouter
        if (assistant.model?.provider === 'openrouter' && assistant.enableWebSearch) {
          const extractedUrls = extractUrlsFromMarkdown(message.content)
          if (extractedUrls.length > 0) {
            message.metadata = {
              ...message.metadata,
              citations: extractedUrls
            }
          }
        }
        if (assistant.enableWebSearch) {
          message.content = cleanLinkCommas(message.content)
          if (webSearch && isZhipuModel(assistant.model)) {
            message.content = completeLinks(message.content, webSearch)
          }
        }

        onResponse({ ...message, status: 'pending' })
      },
      mcpTools: mcpTools
    })

    message.status = 'success'
    message = withGenerateImage(message)

    if (!message.usage || !message?.usage?.completion_tokens) {
      message.usage = await estimateMessagesUsage({
        assistant,
        messages: [..._messages, message]
      })
      // Set metrics.completion_tokens
      if (message.metrics && message?.usage?.completion_tokens) {
        if (!message.metrics?.completion_tokens) {
          message = {
            ...message,
            metrics: {
              ...message.metrics,
              completion_tokens: message.usage.completion_tokens
            }
          }
        }
      }
    }
    // console.log('message', message)
  } catch (error: any) {
    if (isAbortError(error)) {
      message.status = 'paused'
    } else {
      message.status = 'error'
      message.error = formatMessageError(error)
    }
  }

  // Emit chat completion event
  EventEmitter.emit(EVENT_NAMES.RECEIVE_MESSAGE, message)
  onResponse(message)

  // Reset generating state
  store.dispatch(setGenerating(false))
  return message
}

interface FetchTranslateProps {
  message: Message
  assistant: Assistant
  onResponse?: (text: string) => void
}

export async function fetchTranslate({ message, assistant, onResponse }: FetchTranslateProps) {
  const model = getTranslateModel()

  if (!model) {
    throw new Error(i18n.t('error.provider_disabled'))
  }

  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    throw new Error(i18n.t('error.no_api_key'))
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.translate(message, assistant, onResponse)
  } catch (error: any) {
    return ''
  }
}

export async function fetchMessagesSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
  const model = getTopNamingModel() || assistant.model || getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return null
  }

  const AI = new AiProvider(provider)

  try {
    const text = await AI.summaries(filterMessages(messages), assistant)
    // Remove all quotes from the text
    return text?.replace(/["']/g, '') || null
  } catch (error: any) {
    return null
  }
}

export async function fetchSearchSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
  const model = assistant.model || getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return null
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.summaryForSearch(messages, assistant)
  } catch (error: any) {
    return null
  }
}

export async function fetchGenerate({ prompt, content }: { prompt: string; content: string }): Promise<string> {
  const model = getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.generateText({ prompt, content })
  } catch (error: any) {
    return ''
  }
}

export async function fetchSuggestions({
  messages,
  assistant
}: {
  messages: Message[]
  assistant: Assistant
}): Promise<Suggestion[]> {
  const model = assistant.model
  if (!model) {
    return []
  }

  if (model.id.endsWith('global')) {
    return []
  }

  const provider = getAssistantProvider(assistant)
  const AI = new AiProvider(provider)

  try {
    return await AI.suggestions(filterMessages(messages), assistant)
  } catch (error: any) {
    return []
  }
}

// Helper function to validate provider's basic settings such as API key, host, and model list
export function checkApiProvider(provider: Provider): {
  valid: boolean
  error: Error | null
} {
  const key = 'api-check'
  const style = { marginTop: '3vh' }

  if (provider.id !== 'ollama' && provider.id !== 'lmstudio') {
    if (!provider.apiKey) {
      window.message.error({ content: i18n.t('message.error.enter.api.key'), key, style })
      return {
        valid: false,
        error: new Error(i18n.t('message.error.enter.api.key'))
      }
    }
  }

  if (!provider.apiHost) {
    window.message.error({ content: i18n.t('message.error.enter.api.host'), key, style })
    return {
      valid: false,
      error: new Error(i18n.t('message.error.enter.api.host'))
    }
  }

  if (isEmpty(provider.models)) {
    window.message.error({ content: i18n.t('message.error.enter.model'), key, style })
    return {
      valid: false,
      error: new Error(i18n.t('message.error.enter.model'))
    }
  }

  return {
    valid: true,
    error: null
  }
}

export async function checkApi(provider: Provider, model: Model) {
  const validation = checkApiProvider(provider)
  if (!validation.valid) {
    return {
      valid: validation.valid,
      error: validation.error
    }
  }

  const AI = new AiProvider(provider)

  const { valid, error } = await AI.check(model)

  return {
    valid,
    error
  }
}

function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (provider.id === 'ollama' || provider.id === 'lmstudio') return true
  return !isEmpty(provider.apiKey)
}

export async function fetchModels(provider: Provider) {
  const AI = new AiProvider(provider)

  try {
    return await AI.models()
  } catch (error) {
    return []
  }
}

/**
 * Format API keys
 * @param value Raw key string
 * @returns Formatted key string
 */
export const formatApiKeys = (value: string) => {
  return value.replaceAll('，', ',').replaceAll(' ', ',').replaceAll(' ', '').replaceAll('\n', ',')
}
