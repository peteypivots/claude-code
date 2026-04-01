/**
 * SearXNG client for local web search
 * Used as a fallback when Anthropic's web_search tool is unavailable (e.g., Ollama)
 */

import { logError } from '../../utils/log.js'

export interface SearxngResult {
  url: string
  title: string
  content?: string
  engine?: string
  score?: number
}

export interface SearxngResponse {
  query: string
  number_of_results: number
  results: SearxngResult[]
  answers?: string[]
  infoboxes?: Array<{
    infobox: string
    content: string
    urls?: Array<{ title: string; url: string }>
  }>
}

export interface SearchOutput {
  query: string
  results: Array<{
    tool_use_id: string
    content: Array<{ title: string; url: string; snippet?: string }>
  } | string>
  durationSeconds: number
}

/**
 * Get SearXNG URL from environment, with sensible defaults for Docker
 */
export function getSearxngUrl(): string | null {
  // Check for explicit env var first
  if (process.env.SEARXNG_URL) {
    return process.env.SEARXNG_URL
  }
  
  // Docker container default - SearXNG on ollama_default network
  if (process.env.OLLAMA_BASE_URL?.includes('ollama')) {
    return 'http://searxng:8080'
  }
  
  // Local development fallback
  return 'http://localhost:18001'
}

/**
 * Perform a web search using SearXNG
 */
export async function searchWithSearxng(
  query: string,
  options?: {
    allowedDomains?: string[]
    blockedDomains?: string[]
    maxResults?: number
    signal?: AbortSignal
  }
): Promise<SearchOutput> {
  const startTime = performance.now()
  const baseUrl = getSearxngUrl()
  
  if (!baseUrl) {
    throw new Error('SearXNG URL not configured. Set SEARXNG_URL environment variable.')
  }

  // Build search URL
  const params = new URLSearchParams({
    q: query,
    format: 'json',
  })

  // SearXNG doesn't directly support domain filtering in URL params,
  // but we can filter results after fetching
  const maxResults = options?.maxResults ?? 10

  const url = `${baseUrl}/search?${params.toString()}`
  console.log(`[SearXNG] Searching: ${query}`)

  try {
    const response = await fetch(url, {
      signal: options?.signal,
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`)
    }

    const data: SearxngResponse = await response.json()
    
    // Filter by domains if specified
    let filteredResults = data.results
    
    if (options?.allowedDomains?.length) {
      filteredResults = filteredResults.filter(r => {
        try {
          const hostname = new URL(r.url).hostname
          return options.allowedDomains!.some(d => hostname.includes(d))
        } catch {
          return false
        }
      })
    }
    
    if (options?.blockedDomains?.length) {
      filteredResults = filteredResults.filter(r => {
        try {
          const hostname = new URL(r.url).hostname
          return !options.blockedDomains!.some(d => hostname.includes(d))
        } catch {
          return true
        }
      })
    }

    // Limit results
    filteredResults = filteredResults.slice(0, maxResults)

    const endTime = performance.now()
    const durationSeconds = (endTime - startTime) / 1000

    console.log(`[SearXNG] Found ${filteredResults.length} results in ${durationSeconds.toFixed(2)}s`)

    // Format results with full information including snippets
    const searchResults = filteredResults.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content || '',  // Include the content/snippet for context
    }))

    // Build output matching the expected format
    const output: SearchOutput = {
      query,
      results: [
        {
          tool_use_id: `searxng-${Date.now()}`,
          content: searchResults,
        },
      ],
      durationSeconds,
    }

    // Prepend a clear summary of findings if we have snippets
    const summarySnippets = filteredResults
      .filter(r => r.content && r.content.length > 20)
      .slice(0, 3)  // Top 3 with content
      .map(r => `- ${r.content}`)
      .join('\n')
    
    if (summarySnippets) {
      output.results.unshift(`Key information found:\n${summarySnippets}`)
    }

    // Add summary text from answers/infoboxes if available
    if (data.answers?.length) {
      output.results.push(`Quick answer: ${data.answers[0]}`)
    }
    
    if (data.infoboxes?.length) {
      const infobox = data.infoboxes[0]
      output.results.push(`${infobox.infobox}: ${infobox.content}`)
    }

    return output
  } catch (error) {
    const endTime = performance.now()
    const durationSeconds = (endTime - startTime) / 1000
    
    logError(error as Error, { context: 'SearXNG search failed', query })
    
    return {
      query,
      results: [`Search error: ${error instanceof Error ? error.message : String(error)}`],
      durationSeconds,
    }
  }
}

/**
 * Check if SearXNG is available
 */
export async function isSearxngAvailable(): Promise<boolean> {
  const baseUrl = getSearxngUrl()
  if (!baseUrl) return false
  
  try {
    const response = await fetch(`${baseUrl}/search?q=test&format=json`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}
