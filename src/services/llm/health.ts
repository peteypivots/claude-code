/**
 * LLM Provider Health Monitoring
 * Tracks provider availability and performance
 */

import { logError, logForDebugging } from 'src/utils/log.js'
import type { LLMProvider } from './types.js'

export interface HealthCheckConfig {
  interval: number // milliseconds between checks
  timeout: number // milliseconds before considering check failed
  alertThreshold: number // number of consecutive failures before alert
  logMetrics: boolean
}

export interface ProviderHealthStatus {
  provider: LLMProvider
  available: boolean
  lastChecked: Date
  consecutiveFailures: number
  uptime: number // percentage
  latency: number // average latency in ms
}

export interface HealthMetrics {
  timestamp: Date
  provider: LLMProvider
  latency: number
  available: boolean
  error?: string
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  interval: 30000, // 30 seconds
  timeout: 5000, // 5 seconds
  alertThreshold: 3,
  logMetrics: process.env.LLM_LOG_PROVIDER === 'true',
}

/**
 * Provider health monitor
 */
export class ProviderHealthMonitor {
  private config: HealthCheckConfig
  private statuses: Map<LLMProvider, ProviderHealthStatus> = new Map()
  private metrics: HealthMetrics[] = []
  private checkIntervals: Map<LLMProvider, NodeJS.Timeout> = new Map()
  private started = false

  constructor(config: Partial<HealthCheckConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start monitoring providers
   */
  start(providers: Map<LLMProvider, import('./types.js').ILLMProvider>): void {
    if (this.started) return

    this.started = true

    for (const [name] of providers) {
      this.initializeStatus(name)

      // Start periodic health checks
      const interval = setInterval(async () => {
        await this.checkProviderHealth(name, providers.get(name)!)
      }, this.config.interval)

      this.checkIntervals.set(name, interval)

      // Do first check immediately
      this.checkProviderHealth(name, providers.get(name)!).catch((error) => {
        if (this.config.logMetrics) {
          logError(`Initial health check failed for ${name}: ${error}`)
        }
      })
    }
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.started) return

    for (const interval of this.checkIntervals.values()) {
      clearInterval(interval)
    }
    this.checkIntervals.clear()
    this.started = false
  }

  /**
   * Get current status of all providers
   */
  getStatus(): Map<LLMProvider, ProviderHealthStatus> {
    return new Map(this.statuses)
  }

  /**
   * Get status of a specific provider
   */
  getProviderStatus(provider: LLMProvider): ProviderHealthStatus | undefined {
    return this.statuses.get(provider)
  }

  /**
   * Get recent metrics
   */
  getMetrics(
    provider?: LLMProvider,
    limit = 100,
  ): HealthMetrics[] {
    let metrics = this.metrics

    if (provider) {
      metrics = metrics.filter((m) => m.provider === provider)
    }

    return metrics.slice(-limit)
  }

  /**
   * Get average latency for a provider
   */
  getAverageLatency(provider: LLMProvider): number {
    const metrics = this.metrics.filter((m) => m.provider === provider)
    if (metrics.length === 0) return 0

    const total = metrics.reduce((sum, m) => sum + m.latency, 0)
    return total / metrics.length
  }

  /**
   * Get provider uptime percentage
   */
  getUptime(provider: LLMProvider): number {
    const status = this.statuses.get(provider)
    return status?.uptime ?? 0
  }

  private async checkProviderHealth(
    provider: LLMProvider,
    llmProvider: import('./types.js').ILLMProvider,
  ): Promise<void> {
    const startTime = Date.now()
    const status = this.statuses.get(provider)!

    try {
      const available = await Promise.race([
        llmProvider.isAvailable(),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), this.config.timeout),
        ),
      ])

      const latency = Date.now() - startTime

      this.recordMetric(provider, latency, available)

      if (available) {
        status.available = true
        status.consecutiveFailures = 0
        status.latency = latency
      } else {
        status.available = false
        status.consecutiveFailures++

        if (
          status.consecutiveFailures >= this.config.alertThreshold &&
          this.config.logMetrics
        ) {
          logError(
            `Provider ${provider} has been unavailable for ${status.consecutiveFailures} checks`,
          )
        }
      }

      status.lastChecked = new Date()
    } catch (error) {
      status.available = false
      status.consecutiveFailures++

      const latency = Date.now() - startTime
      this.recordMetric(provider, latency, false, error as Error)

      if (
        status.consecutiveFailures >= this.config.alertThreshold &&
        this.config.logMetrics
      ) {
        logError(
          `Provider ${provider} health check failed: ${(error as Error).message}`,
        )
      }

      status.lastChecked = new Date()
    }
  }

  private initializeStatus(provider: LLMProvider): void {
    this.statuses.set(provider, {
      provider,
      available: false,
      lastChecked: new Date(),
      consecutiveFailures: 0,
      uptime: 0,
      latency: 0,
    })
  }

  private recordMetric(
    provider: LLMProvider,
    latency: number,
    available: boolean,
    error?: Error,
  ): void {
    const metric: HealthMetrics = {
      timestamp: new Date(),
      provider,
      latency,
      available,
      error: error?.message,
    }

    this.metrics.push(metric)

    // Keep only last 1000 metrics
    if (this.metrics.length > 1000) {
      this.metrics = this.metrics.slice(-1000)
    }

    // Update uptime
    const status = this.statuses.get(provider)!
    const recent = this.metrics
      .filter((m) => m.provider === provider)
      .slice(-100)
    const uptime =
      (recent.filter((m) => m.available).length / recent.length) * 100
    status.uptime = Math.round(uptime)

    if (this.config.logMetrics) {
      logForDebugging(
        `[${provider}] Health check: ${available ? '✓' : '✗'} (${latency}ms)`,
        { level: 'debug' },
      )
    }
  }
}

/**
 * Format health status for display
 */
export function formatHealthStatus(status: ProviderHealthStatus): string {
  const symbol = status.available ? '✓' : '✗'
  const lastChecked = formatTime(status.lastChecked)

  return (
    `${symbol} ${status.provider.padEnd(12)} ` +
    `${status.available ? 'UP' : 'DOWN'} ` +
    `(${status.uptime.toFixed(0)}%) ` +
    `[${status.latency}ms] ` +
    `checked ${lastChecked}`
  )
}

/**
 * Format relative time
 */
function formatTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 1000) return 'just now'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return `${Math.floor(diff / 3600000)}h ago`
}

/**
 * Global health monitor instance
 */
let globalMonitor: ProviderHealthMonitor | undefined

/**
 * Get or create global health monitor
 */
export function getGlobalHealthMonitor(
  config?: Partial<HealthCheckConfig>,
): ProviderHealthMonitor {
  if (!globalMonitor) {
    globalMonitor = new ProviderHealthMonitor(config)
  }
  return globalMonitor
}

/**
 * Reset global monitor (for testing)
 */
export function resetGlobalHealthMonitor(): void {
  const monitor = globalMonitor
  if (monitor) {
    monitor.stop()
  }
  globalMonitor = undefined
}
