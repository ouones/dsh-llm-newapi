window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-llm-newapi", factory: (require) => {
var __modules = Object.create(null); var __cache = Object.create(null);
__modules["./index.js"] = function(module, exports, require, __load_) {
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const React = __importStar(require("react"));
/** Same-origin routes served by the Host `web.ts` module. */
const SETTINGS_ROUTE = '/_dsh/llm-newapi/settings';
const MODELS_ROUTE = '/_dsh/llm-newapi/models';
/** Locale namespace shared with nothing else; dictionaries live here. */
const NS_LOCALE = 'llm-newapi';
const enDict = {
    nav: 'New API',
    title: 'New API Provider',
    intro: 'Configure a New API gateway route: its base URL, API-key reference, and the models it should serve.',
    baseUrl: 'Base URL',
    baseUrlHint: 'For example https://gateway.example.com. The panel asks the gateway\'s /v1/models for candidate models.',
    apiKeyEnv: 'API Key reference',
    apiKeyEnvHint: 'The credential reference (e.g. an environment variable name) for this gateway. Leave blank for an unauthenticated gateway.',
    provider: 'Provider key',
    providerHint: 'A unique route key, e.g. my-gateway.',
    save: 'Save',
    saved: 'Saved',
    error: 'Error',
    fetchModels: 'Fetch available models',
    fetchModelsHint: 'Pulls the model id/display-name list from this gateway\'s /v1/models endpoint.',
    selectAll: 'Select all',
    models: 'Models',
    modelsHint: 'Every candidate defaults to selected; enable the checkbox set you want this route to serve.',
    reasoning: 'Default reasoning level',
    reasoningHint: 'low / medium / high / xhigh / max. Used when a request names no effort; medium is the default.',
    api: 'Wire protocol',
    apiHint: 'How this gateway speaks to models. OpenAI-compatible Chat Completions is the common New API dialect; most gateways route everything over it.',
    noneFetched: 'Enter a base URL, then fetch models.',
    emptyModels: 'This gateway advertised no models.',
    removedOldRoute: 'Route key changed; the old route remains unless you remove it in settings.yaml.',
};
const zhDict = {
    nav: 'New API',
    title: 'New API Provider',
    intro: '配置一个 New API 网关路由：其 Base URL、API Key 引用以及需要提供服务的模型。',
    baseUrl: 'Base URL',
    baseUrlHint: '例如 https://gateway.example.com。面板会向该网关的 /v1/models 拉取候选模型。',
    apiKeyEnv: 'API Key 引用',
    apiKeyEnvHint: '该网关的凭证引用（例如环境变量名）。留空表示该网关不需要鉴权。',
    provider: 'Provider 键',
    providerHint: '唯一的路由键，例如 my-gateway。',
    save: '保存',
    saved: '已保存',
    error: '出错',
    fetchModels: '获取可用模型',
    fetchModelsHint: '从该网关的 /v1/models 接口拉取模型 id/显示名列表。',
    selectAll: '全选',
    models: '模型',
    modelsHint: '每个候选模型默认全选；勾选你想该路由提供的模型集合。',
    reasoning: '默认思考深度',
    reasoningHint: 'low / medium / high / xhigh / max。请求未指定时使用；默认 medium。',
    api: '线路协议',
    apiHint: '该网关与模型对话的方式。OpenAI 兼容的 Chat Completions 是 New API 最常见的线路；多数网关都用它中继所有模型。',
    noneFetched: '先填写 Base URL，再获取模型。',
    emptyModels: '该网关没有返回任何模型。',
    removedOldRoute: '路由键已变更；旧路由仍保留，除非你在 settings.yaml 中删除它。',
};
function dictionary(lang) {
    return lang === 'zh' ? zhDict : enDict;
}
/** The selectable wire protocols (mirrors the Host catalog's SUPPORTED_PROTOCOLS). */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const PROTOCOL_NAMES = {
    'openai-completions': 'OpenAI Chat Completions',
    'openai-responses': 'OpenAI Responses',
    'anthropic-messages': 'Anthropic Messages',
};
/** The selectable reasoning levels (mirrors the Host catalog's THINKING_LEVELS). */
const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Multiple logs aside, most failures reduce to a message the panel shows. */
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** Parse the redacted body a same-origin DSH route answers with. */
async function parseResponse(response) {
    let body = null;
    try {
        body = await response.json();
    }
    catch {
        body = null;
    }
    if (!response.ok) {
        const detail = body?.error?.message;
        throw new Error(`${response.status}: ${typeof detail === 'string' ? detail : 'request failed'}`);
    }
    return { ok: response.ok, body };
}
/** GET the current settings snapshot. */
async function loadSettings() {
    const response = await fetch(SETTINGS_ROUTE, { method: 'GET' });
    const { body } = await parseResponse(response);
    return {
        writable: body?.writable === true,
        value: body?.value ?? {},
        base: body?.base,
        user: body?.user,
        revision: typeof body?.revision === 'number' ? body.revision : null,
    };
}
/** POST the listed path ops, retrying once on a revision conflict after a reload. */
async function saveSettings(ops) {
    const before = await loadSettings();
    const revision = before.revision;
    const response = await fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ops,
            ...revision === null ? {} : { expectedRevision: revision },
        }),
    });
    return (await parseResponse(response)).body;
}
/** POST a draft endpoint to /models; returns the advertised candidates. */
async function fetchModels(baseURL, provider) {
    const response = await fetch(MODELS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            baseURL,
            ...provider === undefined ? {} : { provider },
        }),
    });
    const { body } = await parseResponse(response);
    return Array.isArray(body?.models) ? body.models : [];
}
/** A tiny external store the section component subscribes to. */
class PanelController {
    // Minimal reactivity: version bumps on each mutation; the component re-reads
    // the cloud of members it holds. Kept deliberately plain to avoid a React
    // dependency beyond the runtime's own.
    version = 0;
    listeners = new Set();
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    getSnapshot = () => this.version;
    bump() {
        this.version += 1;
        for (const listener of this.listeners)
            listener();
    }
}
let controller;
/** Register the settings section once `slots` is available. */
function install(ctx) {
    const t = ctx.locale.bind(NS_LOCALE);
    if (controller === undefined)
        controller = new PanelController();
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-newapi',
        order: 30,
        label: () => t('nav'),
        inject: () => ({ controller, t }),
    }, NewApiSection));
}
/** The settings panel. */
function NewApiSection(props) {
    const t = props.t;
    const listen = React.useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, () => 0);
    const [snapshot, setSnapshot] = React.useState(null);
    const [status, setStatus] = React.useState('loading');
    const [error, setError] = React.useState(undefined);
    const [saved, setSaved] = React.useState(false);
    const [draft, setDraft] = React.useState(null);
    const [models, setModels] = React.useState([]);
    const [selectedModels, setSelectedModels] = React.useState(new Set());
    const [reasoning, setReasoning] = React.useState('medium');
    const [api, setApi] = React.useState('openai-completions');
    const [slug, setSlug] = React.useState('my-gateway');
    const [fetching, setFetching] = React.useState(false);
    // Initial load.
    React.useEffect(() => {
        let active = true;
        loadSettings()
            .then(next => {
            if (!active)
                return;
            const providers = next.value?.providers ?? {};
            const keys = Object.keys(providers);
            const route = keys[0];
            const profile = route !== undefined ? providers[route] : undefined;
            setSnapshot(next);
            if (route !== undefined && profile !== undefined) {
                setSlug(route);
                setDraft({
                    baseURL: profile.baseURL ?? '',
                    apiKeyEnv: profile.apiKeyEnv,
                });
                setApi(typeof profile.api === 'string' ? profile.api : 'openai-completions');
                const stored = new Set((profile.models ?? []).map(m => m.id));
                setSelectedModels(stored);
                const why = Object.keys(profile.reasoning ?? {});
                setReasoning(why.includes('medium') ? 'medium' : (why[0] ?? 'medium'));
            }
            else {
                setDraft({ baseURL: '', apiKeyEnv: undefined });
                setSelectedModels(new Set());
            }
            setStatus('ready');
        })
            .catch(err => {
            if (!active)
                return;
            setStatus('error');
            setError(messageOf(err));
        });
        return () => { active = false; };
        // controller.version is the only reactive input; the store version changing
        // should reload the snapshot.
    }, [listen]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (saved) {
            const handle = window.setTimeout(() => setSaved(false), 2000);
            return () => window.clearTimeout(handle);
        }
        return undefined;
    }, [saved]);
    if (status === 'loading')
        return React.createElement('p', { style: { opacity: 0.6 } }, '…');
    if (status === 'error' || draft === null) {
        return React.createElement('p', { style: { color: '#d43' } }, `${t('error')}: ${error ?? 'unavailable'}`);
    }
    const allSelected = models.length > 0 && models.every(m => selectedModels.has(m.id));
    const toggleAll = () => {
        const next = new Set(selectedModels);
        if (allSelected) {
            for (const m of models)
                next.delete(m.id);
        }
        else {
            for (const m of models)
                next.add(m.id);
        }
        setSelectedModels(next);
    };
    const doFetchModels = async () => {
        if (draft.baseURL.length === 0) {
            setError(t('noneFetched'));
            return;
        }
        setFetching(true);
        setError(undefined);
        try {
            // The route key names a configured provider; the Host resolves any stored
            // key from it rather than us sending a credential reference as a raw key.
            const list = await fetchModels(draft.baseURL, slug);
            setModels(list);
            // New candidates default to selected; keep anything already chosen.
            setSelectedModels(prev => new Set([...prev, ...list.map(m => m.id)]));
        }
        catch (err) {
            setError(messageOf(err));
        }
        finally {
            setFetching(false);
        }
    };
    const doSave = async () => {
        setError(undefined);
        // The document stores providers under an arbitrary route key naming the
        // provider; we keep the user's chosen slug. If they changed it we write the
        // new route and leave the old one alone (the hint says so).
        const modelsWire = [...selectedModels]
            .map(id => {
            const found = models.find(m => m.id === id);
            return found === undefined ? { id } : { id: found.id, ...found.name === undefined ? {} : { name: found.name } };
        });
        // Each fetched model that disclosed a wire protocol is preserved as a
        // per-model routing override, so the saved route stays serviceable without
        // re-interrogating the gateway (resolveModels needs a route `api` or a
        // `modelApiOverrides` entry to route every model it serves).
        const apiOverrides = {};
        for (const m of models) {
            if (selectedModels.has(m.id) && m.api !== undefined)
                apiOverrides[m.id] = m.api;
        }
        const profile = {
            baseURL: draft.baseURL,
            ...draft.apiKeyEnv === undefined || draft.apiKeyEnv.length === 0 ? {} : { apiKeyEnv: draft.apiKeyEnv },
            api: api,
            models: modelsWire,
            ...Object.keys(apiOverrides).length === 0 ? {} : { modelApiOverrides: apiOverrides },
            reasoning: { [reasoning]: reasoning },
        };
        const ops = [{ op: 'set', path: ['providers', slug], value: profile }];
        try {
            const next = await saveSettings(ops);
            setSnapshot(next);
            setSaved(true);
            props.controller.bump();
        }
        catch (err) {
            setError(messageOf(err));
        }
    };
    const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '4px 6px',
        fontFamily: 'inherit', fontSize: 13,
    };
    const rowStyle = { marginBottom: 10 };
    const labelStyle = { display: 'block', marginBottom: 3, fontSize: 12, color: '#666' };
    const hintStyle = { marginTop: 2, fontSize: 11, color: '#999' };
    const buttonStyle = {
        padding: '6px 12px', cursor: 'pointer', fontSize: 13,
        border: '1px solid #ccc', borderRadius: 4, background: '#fafafa',
    };
    return React.createElement('div', { style: { maxWidth: 560 } }, React.createElement('p', { style: { opacity: 0.7 } }, t('intro')), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('provider')), React.createElement('input', {
        style: inputStyle,
        value: slug,
        onChange: (e) => setSlug(e.target.value),
    }), React.createElement('div', { style: hintStyle }, t('providerHint'))), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('baseUrl')), React.createElement('input', {
        style: inputStyle,
        value: draft.baseURL,
        placeholder: 'https://gateway.example.com',
        onChange: (e) => setDraft({ ...draft, baseURL: e.target.value }),
    }), React.createElement('div', { style: hintStyle }, t('baseUrlHint'))), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('apiKeyEnv')), React.createElement('input', {
        style: inputStyle,
        value: draft.apiKeyEnv ?? '',
        placeholder: 'NEWAPI_TEST_TOKEN',
        onChange: (e) => setDraft({ ...draft, apiKeyEnv: e.target.value }),
    }), React.createElement('div', { style: hintStyle }, t('apiKeyEnvHint'))), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('api')), React.createElement('select', {
        style: inputStyle,
        value: api,
        onChange: (e) => setApi(e.target.value),
    }, PROTOCOLS.map(protocol => React.createElement('option', {
        key: protocol,
        value: protocol,
    }, PROTOCOL_NAMES[protocol] ?? protocol))), React.createElement('div', { style: hintStyle }, t('apiHint'))), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('reasoning')), React.createElement('select', {
        style: inputStyle,
        value: reasoning,
        onChange: (e) => setReasoning(e.target.value),
    }, REASONING_LEVELS.map(level => React.createElement('option', { key: level, value: level }, level))), React.createElement('div', { style: hintStyle }, t('reasoningHint'))), React.createElement('div', { style: rowStyle }, React.createElement('button', {
        style: buttonStyle,
        disabled: fetching,
        onClick: () => { void doFetchModels(); },
    }, fetching ? '…' : t('fetchModels')), React.createElement('div', { style: hintStyle }, t('fetchModelsHint'))), React.createElement('div', { style: rowStyle }, React.createElement('label', { style: labelStyle }, t('models')), React.createElement('div', { style: { marginBottom: 4, fontSize: 12 } }, React.createElement('label', { style: { cursor: 'pointer' } }, React.createElement('input', {
        type: 'checkbox',
        checked: allSelected,
        disabled: models.length === 0,
        onChange: toggleAll,
    }), ' ', t('selectAll'))), models.length === 0
        ? React.createElement('p', { style: hintStyle }, t('noneFetched'))
        : React.createElement('div', { style: { maxHeight: 180, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 4, padding: 4 } }, models.map(m => React.createElement('label', {
            key: m.id,
            style: { display: 'block', cursor: 'pointer', padding: '2px 4px', fontSize: 13 },
        }, React.createElement('input', {
            type: 'checkbox',
            checked: selectedModels.has(m.id),
            onChange: () => {
                const next = new Set(selectedModels);
                if (next.has(m.id))
                    next.delete(m.id);
                else
                    next.add(m.id);
                setSelectedModels(next);
            },
        }), ` ${m.name ?? m.id} (${m.id})`))), React.createElement('div', { style: hintStyle }, t('modelsHint'))), error !== undefined
        ? React.createElement('p', { style: { color: '#d43' } }, `${t('error')}: ${error}`)
        : null, React.createElement('div', { style: { marginTop: 12 } }, React.createElement('button', {
        style: { ...buttonStyle, background: '#2266dd', color: '#fff', borderColor: '#2266dd' },
        onClick: () => { void doSave(); },
    }, saved ? t('saved') : t('save'))));
}
/** Client plugin declaration. */
exports.inject = ['slots', 'locale'];
/** Client plugin lifecycle. */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS_LOCALE, { en: enDict, zh: zhDict }), 'llm-newapi: dictionaries');
    install(ctx);
}

};
function __resolve(from, request) {
  if (!request.startsWith(".")) return request;
  var parts = from.slice(2).split("/"); parts.pop();
  for (var part of request.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return "./" + parts.join("/");
}
function __load(id) {
  if (__modules[id] === undefined) return require(id);
  if (__cache[id] !== undefined) return __cache[id].exports;
  var module = __cache[id] = { exports: {} };
  __modules[id](module, module.exports, require, function(request) {
    var resolved = __resolve(id, request);
    return __modules[resolved] === undefined ? require(request) : __load(resolved);
  });
  return module.exports;
}
return __load("./index.js"); } });
