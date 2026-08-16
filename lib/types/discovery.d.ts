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
import type { LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
import type { NewApiDiscoveredModel } from './catalog.ts';
/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
export declare const MAX_RESPONSE_BYTES: number;
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
export declare function discoverModels(request: LlmModelDiscoveryRequest, storedApiKey?: (provider: string | undefined) => Promise<string | undefined>): Promise<readonly NewApiDiscoveredModel[]>;
