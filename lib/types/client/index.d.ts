/**
 * llm-newapi browser settings panel. Registers a `settings.section` in the
 * DSH Web Settings dialog and edits the provider configuration the same
 * settings seam already holds: base URL, API-key reference, and the model set
 * (candidates pulled from the gateway's own `/v1/models` listing, all selected
 * by default, with a select-all toggle).
 *
 * This bundle is self-contained on purpose: it talks to the two same-origin
 * routes the Host web module serves (`/_dsh/llm-newapi/settings` and
 * `/models`), so it needs no other DSH client service beyond `slots`/`locale`.
 *
 * @module dsh-llm-newapi/client
 */
/** Client plugin declaration. */
export declare const inject: string[];
/** Client plugin lifecycle. */
export declare function apply(ctx: any): void;
