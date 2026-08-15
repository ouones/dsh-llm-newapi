/**
 * Real-composition guard for the dormant llm-newapi posture: LlmRuntime,
 * settings-file, credentials-local, and a bare `llm-newapi` row boot from a
 * test-only cordis.yml through the actual Loader + Include path, an external
 * edit of settings.yaml registers the gateway route live, and an emptied
 * section returns the composition to its dormant state. A hand-mounted
 * `ctx.plugin` cannot catch Loader export-shape failures, which is why the
 * twin adapter has the same guard.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmNewApi from '@deepseek-ai/dsh-llm-newapi'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Boot the dormant composition: a bare `llm-newapi` row with no config at all. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-newapi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(join(root, '.credentials.yaml'), 'NEWAPI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: llm-newapi',
    "  name: '@deepseek-ai/dsh-llm-newapi'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-newapi', LlmNewApi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('llm-newapi real dormant composition', () => {
  it('boots with zero routes, registers a route the moment settings supply a profile, and withdraws it when the section empties', async () => {
    vi.stubEnv('NEWAPI_COMPOSITION_KEY', '')
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route and no directory entry do.
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      'llm-newapi:',
      '  providers:',
      '    my-gateway:',
      '      apiKeyEnv: NEWAPI_COMPOSITION_KEY',
      '      baseURL: https://gateway.example.com',
      '      api: openai-completions',
      '      models:',
      '        - id: test-model',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['my-gateway'])
    }, { timeout: 5000 })
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['my-gateway'])

    // Emptying the user layer returns the composition to its dormant state:
    // routes drop and the directory registration withdraws its entries.
    await writeFile(settingsPath, '# emptied\n')
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([])
    }, { timeout: 5000 })
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})
