/**
 * Answering "which models can this gateway serve?" for the configuration
 * surface's "fetch available models" action. A New API gateway is interrogated
 * over the wire — unlike pi-ai, this adapter ships no registry, so the
 * gateway's own `/v1/models` listing is the only authority for its models.
 *
 * Nothing here is stored: the request carries a draft the user is still
 * editing, and the reply is candidate metadata the surface offers for
 * adoption. `settings.yaml` remains the only thing that decides what a route
 * serves.
 *
 * Only the OpenAI-compatible listing shape is read: it is the one dialect New
 * API speaks for model discovery, and it carries the endpoint types
 * (`supported_endpoint_types`) this adapter needs to route each model onto a
 * wire protocol. Cost ratios and protocol routing are deliberately absent —
 * the former was cut from the design, and the latter lives in
 * `catalog.ts`'s {@link routeModelApi}.
 *
 * @module dsh-llm-newapi/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { NewApiDiscoveredModel, NewApiModality } from './catalog.ts'

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  name?: unknown
  /** New API's display-name extension; absent from the official listings. */
  display_name?: unknown
  /** New API's endpoint-type extension; absent from the official listings. */
  supported_endpoint_types?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  /** New API's modality extension; absent from the official listings. */
  input_modalities?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The endpoint types a listing entry advertises. A non-string member is
 * dropped rather than failing the row: New API's spelling is the only one
 * known, and a malformed member should not deny the rest of the entry.
 */
function endpointTypes(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const types = raw.filter((type): type is string => typeof type === 'string' && type.length > 0)
  return types.length === 0 ? undefined : types
}

/**
 * The request modalities a listing entry advertises. New API discloses a list
 * that may name `image`; any entry accepting images is offered both text and
 * image, and one that does not is offered text alone.
 */
function modalities(raw: unknown): NewApiModality[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (raw.some(type => type === 'image')) return ['text', 'image']
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/v1/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working gateway's catalog. Duplicate
 * ids collapse onto the first entry, which is the one the gateway means.
 */
function readListing(body: unknown): NewApiDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this gateway\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models = new Map<string, NewApiDiscoveredModel>()
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined || models.has(id)) continue
    const name = label(entry?.name, entry?.display_name)
    const endpoints = endpointTypes(entry?.supported_endpoint_types)
    const input = modalities(entry?.input_modalities)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    const model: NewApiDiscoveredModel = { id }
    if (name !== undefined) model.name = name
    if (endpoints !== undefined) model.endpoints = endpoints
    if (input !== undefined) model.input = input
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    models.set(id, model)
  }
  return [...models.values()]
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this gateway\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this gateway\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft gateway endpoint for the models it advertises.
 * @param request - the endpoint and one-shot credential to use.
 * @param storedApiKey - the credential the named route already stored, asked
 *   for only when the draft carries none and only on the path that reaches the
 *   network. A configuration surface never holds a stored secret — it edits a
 *   redacted descriptor — so without this an already-configured route would be
 *   interrogated unauthenticated and answer 401.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the endpoint refuses or fails the request, or the
 *   reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: (provider: string | undefined) => Promise<string | undefined>,
): Promise<readonly NewApiDiscoveredModel[]> {
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      'a New API gateway\'s models can only come from its endpoint; set a baseURL, or enter'
      + " this gateway's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  const url = listingUrl(request.baseURL)
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is only asked for here, past the baseURL check, so a draft
  // that names no credential costs no lookup — and no diagnostic about a
  // credential it never needed. A probe carrying no key stays unauthenticated,
  // which is how a gateway that needs none is meant to be asked.
  const supplied = request.apiKey ?? await storedApiKey?.(request.provider)
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
