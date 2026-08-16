/**
 * Web-profile routes for the llm-newapi Settings section. The browser never
 * sees credential values; it reads and rewrites the redacted configuration the
 * same settings seam already holds. Model candidates come straight from the
 * gateway's own `/v1/models` listing, exactly as the models page interrogates
 * a draft endpoint.
 *
 * @module dsh-llm-newapi/web
 */
import type { Context } from '@deepseek-ai/cordis';
import { type NewApiDiscoveredModel } from './catalog.ts';
/** Exact namespace the settings panel edits. */
export declare const NS = "llm-newapi";
/** The branded namespace the settings seam addresses. */
export declare const NS_SCHEMA: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/** Exact routes the bundled Web settings panel calls. */
export declare const SETTINGS_ROUTE = "/_dsh/llm-newapi/settings";
export declare const MODELS_ROUTE = "/_dsh/llm-newapi/models";
/** Handlers the Web panel needs that live outside this module's seams. */
export interface LlmNewapiWebDeps {
    /** Resolve the credential a draft names no key for, mirroring the models page. */
    storedApiKey?: (provider: string | undefined) => Promise<string | undefined>;
    /** Interrogate one gateway endpoint for its advertised models. */
    discover: (baseURL: string, apiKey: string | undefined, provider: string | undefined) => Promise<readonly NewApiDiscoveredModel[]>;
}
/**
 * Attach the Web routes a bundled Settings panel depends on. Mounts whenever a
 * `webServer` service is present (Web profile); absent in headless runs.
 * @param ctx - plugin context.
 * @param deps - model-discovery and credential seams.
 */
export declare function installLlmNewapiWeb(ctx: Context, deps: LlmNewapiWebDeps): void;
