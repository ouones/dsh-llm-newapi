/**
 * Web-profile routes for the llm-newapi Settings section. The browser never
 * sees credential values; it reads and rewrites the redacted configuration the
 * same settings seam already holds. Model candidates come straight from the
 * gateway's own `/v1/models` listing, exactly as the models page interrogates
 * a draft endpoint.
 *
 * @module dsh-llm-newapi/web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { discoverModelApi, type NewApiDiscoveredModel } from './catalog.ts'

/** Exact namespace the settings panel edits. */
export const NS = 'llm-newapi'
/** The branded namespace the settings seam addresses. */
export const NS_SCHEMA = settingsNamespace(NS)

/** Exact routes the bundled Web settings panel calls. */
export const SETTINGS_ROUTE = '/_dsh/llm-newapi/settings'
export const MODELS_ROUTE = '/_dsh/llm-newapi/models'

/** Handlers the Web panel needs that live outside this module's seams. */
export interface LlmNewapiWebDeps {
  /** Resolve the credential a draft names no key for, mirroring the models page. */
  storedApiKey?: (provider: string | undefined) => Promise<string | undefined>
  /** Interrogate one gateway endpoint for its advertised models. */
  discover: (baseURL: string, apiKey: string | undefined, provider: string | undefined) => Promise<readonly NewApiDiscoveredModel[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The settings seam's descriptor for this plugin's namespace. */
function descriptorOf(ctx: Context): {
  value: unknown
  base: unknown
  user: unknown
  revision: number
} {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new LlmError('llm-newapi settings seam is unavailable', 'UNAVAILABLE')
  const rows = settings.describe() as Array<{
    ns: string
    value: unknown
    base?: unknown
    user?: unknown
    revision: number
  }>
  const descriptor = rows.find(row => row.ns === NS)
  if (descriptor === undefined) throw new LlmError('llm-newapi settings namespace is not registered', 'UNAVAILABLE')
  return { value: descriptor.value, base: descriptor.base, user: descriptor.user, revision: descriptor.revision }
}

type Res = {
  setHeader: (name: string, value: string) => void
  writeHead: (status: number) => void
  end: (body: string | Uint8Array) => void
}

function responseJson(res: Res, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

function requestError(res: Res, status: number, code: string, message: string): void {
  responseJson(res, status, { error: { code, message } })
}

/** Accept state-changing requests only from the DSH Web application's origin. */
function sameOriginPost(req: IncomingMessage): boolean {
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '')
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  const rawHost = req.headers.host
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  if (rawHost === undefined) return false
  try {
    const parsed = new URL(String(origin))
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A settings snapshot view returned to the panel. */
function settingsView(ctx: Context): Record<string, unknown> {
  const d = descriptorOf(ctx)
  const settings = ctx.get('settings')
  return {
    writable: settings?.writable === true,
    value: d.value,
    ...d.base === undefined ? {} : { base: d.base },
    ...d.user === undefined ? {} : { user: d.user },
    revision: d.revision,
  }
}

/** Fill a SAME-ORIGIN exact route the model/base secret never crosses in the clear. */
async function handleSettings(req: IncomingMessage, res: Res, ctx: Context): Promise<void> {
  if (req.method === 'GET') {
    responseJson(res, 200, settingsView(ctx))
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
    return
  }
  if (!sameOriginPost(req)) {
    requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
    return
  }
  const settings = ctx.get('settings')
  if (settings === undefined || settings.writable !== true) {
    requestError(res, 400, 'settings-conflict', 'settings provider is read-only')
    return
  }
  let parsed: unknown
  try {
    parsed = await readJson(req)
  } catch (error) {
    requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
    return
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.ops)) {
    requestError(res, 400, 'invalid-request', 'ops must be an array')
    return
  }
  let expectedRevision: number | undefined
  if (Number.isSafeInteger(parsed.expectedRevision) && (parsed.expectedRevision as number) >= 0) {
    expectedRevision = parsed.expectedRevision as number
  }
  try {
    await settings.mutate(NS_SCHEMA, parsed.ops as readonly SettingsPathOp[], expectedRevision)
    responseJson(res, 200, settingsView(ctx))
  } catch (error) {
    const conflict = /changed since it was read/.test(publicMessage(error))
    requestError(res, conflict ? 409 : 400, conflict ? 'settings-conflict' : 'settings-rejected', publicMessage(error))
  }
}

/** Interrogate one draft gateway for its advertised models. */
async function handleModels(req: IncomingMessage, res: Res, ctx: Context, deps: LlmNewapiWebDeps): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    requestError(res, 405, 'method-not-allowed', 'Use POST')
    return
  }
  if (!sameOriginPost(req)) {
    requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
    return
  }
  let parsed: unknown
  try {
    parsed = await readJson(req)
  } catch (error) {
    requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
    return
  }
  if (!isRecord(parsed) || typeof parsed.baseURL !== 'string' || parsed.baseURL.length === 0) {
    requestError(res, 400, 'invalid-request', 'baseURL is required')
    return
  }
  if (parsed.apiKey !== undefined && typeof parsed.apiKey !== 'string') {
    requestError(res, 400, 'invalid-request', 'apiKey must be a string')
    return
  }
  const baseURL = parsed.baseURL
  const provider = typeof parsed.provider === 'string' ? parsed.provider : undefined
  try {
    let apiKey: string | undefined
    if (typeof parsed.apiKey === 'string') {
      const check = normalizeApiKey(parsed.apiKey)
      if (!check.ok) throw new LlmError('this gateway\'s API key cannot be carried by an HTTP header', 'INVALID_CREDENTIAL')
      apiKey = check.value
    } else {
      apiKey = await deps.storedApiKey?.(provider)
    }
    const models = await deps.discover(baseURL, apiKey, provider)
    responseJson(res, 200, { models: models.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      // Carry the gateway's endpoint-derived wire protocol so the panel can
      // persist it per model. A model the gateway did not route carries none.
      ...discoverModelApi(model.endpoints) === undefined ? {} : { api: discoverModelApi(model.endpoints) },
    })) })
  } catch (error) {
    ctx.logger.warn('llm-newapi models interrogation failed: %s', publicMessage(error))
    requestError(res, 400, 'models-failed', publicMessage(error))
  }
}

/**
 * Attach the Web routes a bundled Settings panel depends on. Mounts whenever a
 * `webServer` service is present (Web profile); absent in headless runs.
 * @param ctx - plugin context.
 * @param deps - model-discovery and credential seams.
 */
export function installLlmNewapiWeb(ctx: Context, deps: LlmNewapiWebDeps): void {
  ctx.inject(['webServer', 'settings'], (seam) => {
    seam.effect(() => {
      const webServer = seam.get('webServer')
      const disposeSettings = webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: async (req: IncomingMessage, res: Res) => {
          try {
            await handleSettings(req, res, seam as Context)
          } catch (error: unknown) {
            seam.logger.warn('llm-newapi settings route failed: %s', publicMessage(error))
            try {
              requestError(res, 400, 'settings-rejected', publicMessage(error))
            } catch {
              // The response may already be committed.
            }
          }
        },
      })
      const disposeModels = webServer.register({
        kind: 'exact',
        path: MODELS_ROUTE,
        handler: async (req: IncomingMessage, res: Res) => {
          try {
            await handleModels(req, res, seam as Context, deps)
          } catch (error: unknown) {
            seam.logger.warn('llm-newapi models route failed: %s', publicMessage(error))
            try {
              requestError(res, 400, 'models-failed', publicMessage(error))
            } catch {
              // The response may already be committed.
            }
          }
        },
      })
      return () => {
        disposeModels?.()
        disposeSettings?.()
      }
    }, 'llm-newapi: Web routes')
  })
}
