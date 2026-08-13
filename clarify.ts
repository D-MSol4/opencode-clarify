/**
 * clarify — rewrite rough, plain-language prompts into precise technical prompts.
 * Port of pi-clarify (https://github.com/dodo-reach/pi-clarify, MIT) by
 * dodo-reach for the opencode2 TUI.
 *
 * Triggers:
 *   /clarify <rough idea>             # rewrite the idea (press Enter)
 *   /clarify                          # rewrite the rest of the prompt
 *   /clarify:model                    # pick a rewrite model (and variant) from a list
 *   /clarify:model <provider> <id>    # pin a rewrite model
 *   /clarify:model reset              # use the session model again
 *   ... -clarify                      # marker anywhere in a message
 *   "Clarify prompt" (command palette)# rewrite the whole box content
 *
 * Config (optional):
 *   <config-dir>/clarify.json
 *   { "provider": "<provider>", "model": "<model-id>", "variant": "<variant-id>" }
 *
 * When no config is set, the session model is used with its lowest-effort
 * variant when it has variants.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const USAGE =
  "Usage: /clarify <idea> | /clarify:model [provider model|reset] | add -clarify anywhere in the message"

const SYSTEM_PROMPT = `You rewrite rough, plain-language user prompts into clear, precise prompts for a coding agent.

Your job is terminology compression and clarity, not invention.

Rules:
1. Keep the user's intent exactly. Do not add features, constraints, stack choices, or preferences they did not state.
2. When a well-known technical term matches what the user described, use that term instead of the long description.
   Examples of the kind of compression wanted:
   - "remember old card positions, measure new ones, animate between them" → "FLIP animation"
   - "thumbnail grows into the large image on the next screen so it feels like the same image" → "shared-element transition"
   - "one small part working end-to-end from UI through backend and database" → "vertical slice"
   - "show the new state right away, then fix it if the server fails" → "optimistic update"
   - "wait until the user stops typing before searching" → "debounce the search input"
   Apply the same idea in any domain: use the standard name for the pattern, algorithm, UX move, architecture choice, protocol, or process the user is describing.
3. Prefer short, exact terms over long explanations. If a term is right, use it.
4. Preserve all concrete details: product names, file names, paths, numbers, constraints, UI copy, error text, and acceptance criteria.
5. Keep the rewrite as a ready-to-send user prompt. Do not wrap it in quotes. Do not add a preamble like "Here is the rewritten prompt".
6. Use the same language the user wrote in (English stays English, Italian stays Italian, etc.).
7. If the original is already precise, make only light cleanup. Do not invent jargon or force terms that do not fit.
8. Structure multi-part asks with short bullets or numbered steps when that makes the ask clearer.
9. Do not answer the request. Only rewrite the prompt.
10. Output only the rewritten prompt text.`

const CLARIFY_MARKER_RE = /(?:^|\s)-clarify(?=\s|$|[.,;:!?…])/gi
const CLARIFY_COMMAND_RE = /^\/clarify(?=\s|$)/i
const CLARIFY_MODEL_COMMAND_RE = /^\/clarify:model(?=\s|$)/i

function hasClarifyMarker(text: string): boolean {
  const trimmed = String(text ?? "").trim()
  if (trimmed === "-clarify") return true
  CLARIFY_MARKER_RE.lastIndex = 0
  return CLARIFY_MARKER_RE.test(String(text ?? ""))
}

function stripClarifyMarker(text: string): string {
  return String(text ?? "")
    .replace(CLARIFY_MARKER_RE, " ")
    .replace(/\s+([.,;:!?…])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

type ModelLike = {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
  api?: { id?: string; url?: string } | null
  settings?: Record<string, unknown>
  variants?: VariantLike[]
}

type VariantLike = {
  id?: string
  headers?: Record<string, unknown>
  body?: Record<string, unknown>
}

type ProviderLike = {
  id?: string
  name?: string
  env?: string[]
  options?: Record<string, unknown>
  settings?: Record<string, unknown>
  models?: Record<string, ModelLike> | ModelLike[]
  apiKey?: string
}

type PromptEditor = {
  plainText: string
  setText(text: string): void
  gotoBufferEnd(): void
  isDestroyed?: boolean
}

type ClarifyConfig = {
  provider: string
  model: string
  variant?: string
}

type ResolvedModel = {
  provider: ProviderLike
  model: ModelLike
  variant?: VariantLike
}

type Trigger = { kind: "rewrite"; source: string } | { kind: "model"; args: string[] }

type State = {
  busy: boolean
  cached: string
}

type Api = any

function toast(api: Api, message: string, variant: "info" | "success" | "warning" | "error"): void {
  try {
    api?.ui?.toast?.show?.({ variant, message })
  } catch {
    // never crash the TUI over a toast
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function startBusyToast(api: Api, label: string): () => void {
  let frame = 0
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    frame = (frame + 1) % SPINNER_FRAMES.length
    toast(api, `${SPINNER_FRAMES[frame]} ${label}`, "info")
  }
  tick()
  const timer = setInterval(tick, 120)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

function configDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return path.join(os.homedir(), ".config", "opencode")
}

function configPath(): string {
  return path.join(configDir(), "clarify.json")
}

function readConfig(): ClarifyConfig | null {
  const filePath = configPath()
  if (!existsSync(filePath)) return null

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ClarifyConfig>
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : ""
    const model = typeof raw.model === "string" ? raw.model.trim() : ""
    if (!provider || !model) return null
    const variant = typeof raw.variant === "string" && raw.variant.trim() ? raw.variant.trim() : undefined
    return { provider, model, variant }
  } catch {
    return null
  }
}

function writeConfig(config: ClarifyConfig): void {
  const filePath = configPath()
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function clearConfig(): void {
  const filePath = configPath()
  if (existsSync(filePath)) unlinkSync(filePath)
}

function getPromptEditor(api: Api): PromptEditor | undefined {
  try {
    const editor = api?.renderer?.currentFocusedEditor
    if (!editor || typeof editor !== "object") return undefined
    if (editor.isDestroyed === true) return undefined
    const e = editor as Record<string, unknown>
    if (typeof e.plainText !== "string") return undefined
    if (typeof e.setText !== "function") return undefined
    if (typeof e.gotoBufferEnd !== "function") return undefined
    return e as unknown as PromptEditor
  } catch {
    return undefined
  }
}

function parseTrigger(text: string): Trigger | null {
  const lineEnd = text.indexOf("\n")
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd)

  if (CLARIFY_MODEL_COMMAND_RE.test(firstLine)) {
    const rest = firstLine.replace(/^\/clarify:model/i, "").trimStart()
    const parts = rest ? rest.split(/\s+/) : []
    return { kind: "model", args: parts }
  }

  if (CLARIFY_COMMAND_RE.test(firstLine)) {
    const rest = firstLine.replace(/^\/clarify/i, "").trimStart()
    const restLines = lineEnd === -1 ? "" : text.slice(lineEnd + 1).trim()
    const parts = rest ? rest.split(/\s+/) : []
    if (parts[0]?.toLowerCase() === "model") return { kind: "model", args: parts.slice(1) }
    return { kind: "rewrite", source: rest || restLines }
  }

  if (hasClarifyMarker(text)) return { kind: "rewrite", source: stripClarifyMarker(text) }

  return null
}

function getProviders(api: Api): ProviderLike[] {
  try {
    const data = api?.data
    if (Array.isArray(data?.provider)) return data.provider as ProviderLike[]
    if (Array.isArray(data?.providers)) return data.providers as ProviderLike[]
  } catch {
    // fall through
  }
  return []
}

async function getClientProviders(api: Api): Promise<ProviderLike[]> {
  try {
    const listFn = api?.client?.provider?.list
    if (typeof listFn !== "function") return []
    const res = await listFn({})
    const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    return list.map((p: any) => ({
      id: p.id,
      name: p.name,
      settings: p.settings,
      options: p.settings,
    }))
  } catch {
    return []
  }
}

async function findModel(api: Api, providerID: string, modelID: string): Promise<ResolvedModel | null> {
  const syncProviders = getProviders(api)
  const syncProvider = syncProviders.find((p) => p.id === providerID)

  const syncModels = syncProvider?.models
  if (syncModels && !Array.isArray(syncModels) && typeof syncModels === "object") {
    const model = (syncModels as Record<string, ModelLike>)[modelID]
    if (model) return { provider: syncProvider!, model }
  }
  if (Array.isArray(syncModels)) {
    const model = syncModels.find((m) => m.id === modelID || m.modelID === modelID)
    if (model) return { provider: syncProvider!, model }
  }

  const clientProviders = await getClientProviders(api)
  const clientProvider = clientProviders.find((p) => p.id === providerID)
  try {
    const listFn = api?.client?.model?.list
    if (typeof listFn === "function") {
      const res = await listFn({})
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      const model = list.find((m: any) => m.providerID === providerID && (m.id === modelID || m.modelID === modelID))
      if (model) {
        return {
          provider: { id: providerID, settings: model.settings, options: model.settings },
          model: {
            id: model.id,
            api: model.api ?? null,
            settings: model.settings,
            variants: Array.isArray(model.variants) ? (model.variants as VariantLike[]) : undefined,
          },
        }
      }
    }
  } catch {
    // fall through
  }
  if (clientProvider) return { provider: clientProvider, model: { id: modelID } }
  if (syncProvider) return { provider: syncProvider, model: { id: modelID } }
  return null
}

async function getSessionRef(
  api: Api,
): Promise<{ sessionID: string; providerID?: string; modelID?: string } | null> {
  try {
    const route = api?.ui?.router?.current?.()
    const sessionID = route?.sessionID ?? route?.params?.sessionID
    if (!sessionID) return null

    const dataSession = api?.data?.session
    const syncSession = typeof dataSession?.get === "function" ? dataSession.get(sessionID) : undefined
    if (syncSession?.model && syncSession.model.providerID) {
      return {
        sessionID,
        providerID: syncSession.model.providerID,
        modelID: syncSession.model.id ?? syncSession.model.modelID,
      }
    }

    const getFn = api?.client?.session?.get
    if (typeof getFn === "function") {
      const res = await getFn({ sessionID })
      const session = res?.data
      if (session?.model && session.model.providerID) {
        return {
          sessionID,
          providerID: session.model.providerID,
          modelID: session.model.id ?? session.model.modelID,
        }
      }
      return { sessionID }
    }
    return { sessionID }
  } catch {
    return null
  }
}

async function resolveDefaultModel(api: Api, providers: ProviderLike[]): Promise<ResolvedModel | null> {
  try {
    const cfgModel = api?.data?.config?.model
    if (typeof cfgModel === "string") {
      const idx = cfgModel.indexOf("/")
      if (idx > 0) {
        const providerID = cfgModel.slice(0, idx)
        const modelID = cfgModel.slice(idx + 1)
        const provider = providers.find((p) => p.id === providerID)
        if (provider) return { provider, model: { id: modelID } }
      }
    }
  } catch {
    // fall through
  }
  for (const provider of providers) {
    const models = provider.models
    if (models && !Array.isArray(models) && typeof models === "object") {
      const first = Object.keys(models)[0]
      const model = first ? (models as Record<string, ModelLike>)[first] : undefined
      if (model) return { provider, model }
    }
    if (Array.isArray(models) && models.length > 0) return { provider, model: models[0]! }
  }
  try {
    const listFn = api?.client?.model?.list
    if (typeof listFn === "function") {
      const res = await listFn({})
      const list = Array.isArray(res?.data) ? res.data : []
      let first = list.find((m: any) => m.providerID === providers[0]?.id && m.enabled !== false)
      if (!first) first = list.find((m: any) => m.enabled !== false) ?? list[0]
      if (first?.id && first?.providerID) {
        return {
          provider: { id: first.providerID, settings: first.settings, options: first.settings },
          model: {
            id: first.id,
            api: first.api ?? null,
            settings: first.settings,
            variants: Array.isArray(first.variants) ? (first.variants as VariantLike[]) : undefined,
          },
        }
      }
    }
  } catch {
    // fall through
  }
  return null
}

async function resolveSessionModel(api: Api): Promise<ResolvedModel | null> {
  const sessionRef = await getSessionRef(api)
  if (!sessionRef?.providerID || !sessionRef.modelID) return null
  const found = await findModel(api, sessionRef.providerID, sessionRef.modelID)
  if (!found) return null
  const variants = Array.isArray(found.model.variants) ? found.model.variants : []
  const lowVariant = variants.find((variant) => typeof variant.id === "string" && variant.id.length > 0)
  return lowVariant ? { ...found, variant: lowVariant } : found
}

async function resolveRewriteModel(api: Api): Promise<ResolvedModel | null> {
  const config = readConfig()
  if (config) {
    const pinned = await findModel(api, config.provider, config.model)
    if (!pinned) {
      toast(
        api,
        `Clarify model not found: ${config.provider}/${config.model}. Set one with /clarify:model <provider> <model>, or /clarify:model reset.`,
        "error",
      )
      return null
    }
    const variant = config.variant
      ? (pinned.model.variants ?? []).find((item) => item.id === config.variant)
      : undefined
    if (config.variant && !variant) {
      toast(
        api,
        `Clarify variant not found: ${config.provider}/${config.model}:${config.variant}. Pick it again with /clarify:model.`,
        "error",
      )
      return null
    }
    return variant ? { ...pinned, variant } : pinned
  }

  const sessionModel = await resolveSessionModel(api)
  if (sessionModel) return sessionModel

  const providers = [...getProviders(api), ...(await getClientProviders(api))]
  const fallback = await resolveDefaultModel(api, providers)
  if (fallback) return fallback

  toast(
    api,
    "No model available for clarify. Select a session model, or pin one with /clarify:model <provider> <model>.",
    "error",
  )
  return null
}

async function describeModel(api: Api): Promise<string> {
  const config = readConfig()
  if (config) return `${config.provider}/${config.model}${config.variant ? `:${config.variant}` : ""} (pinned)`
  const sessionModel = await resolveSessionModel(api)
  if (sessionModel) {
    return `${sessionModel.provider.id ?? ""}/${sessionModel.model.id ?? ""}${
      sessionModel.variant?.id ? `:${sessionModel.variant.id}` : ""
    } (session)`
  }
  return "none"
}

type ModelPickerValue =
  | { provider: string; model: string; variants?: VariantLike[] }
  | { reset: true }

type ModelPickerOption = {
  title: string
  value: ModelPickerValue
  description?: string
  category?: string
  disabled?: boolean
}

async function collectModelOptions(api: Api): Promise<ModelPickerOption[]> {
  const options: ModelPickerOption[] = [
    {
      title: "Session model (reset)",
      value: { reset: true },
      description: "Use the current session model again",
      category: "Clarify",
    },
  ]
  const seen = new Set<string>()

  const addModel = (
    providerID: string,
    providerName: string | undefined,
    modelID: string,
    name?: string,
    disabled = false,
    variants?: VariantLike[],
  ) => {
    if (!providerID || !modelID) return
    const key = `${providerID}/${modelID}`
    if (seen.has(key)) return
    seen.add(key)
    options.push({
      title: typeof name === "string" && name.length > 0 ? name : modelID,
      value: { provider: providerID, model: modelID, variants },
      category: providerName,
      disabled,
    })
  }

  const providerNames = new Map<string, string>()
  for (const provider of getProviders(api)) {
    if (provider.id) providerNames.set(provider.id, provider.name ?? provider.id)
    const models = provider.models
    if (models && !Array.isArray(models) && typeof models === "object") {
      for (const [id, model] of Object.entries(models as Record<string, ModelLike>)) {
        if (model && typeof model === "object") {
          addModel(
            provider.id ?? "",
            provider.name,
            id,
            typeof model.name === "string" ? model.name : undefined,
            false,
            Array.isArray(model.variants) ? model.variants : undefined,
          )
        }
      }
    } else if (Array.isArray(models)) {
      for (const model of models) {
        const id = model?.id ?? model?.modelID
        if (typeof id === "string" && id.length > 0) {
          addModel(
            provider.id ?? "",
            provider.name,
            id,
            typeof model.name === "string" ? model.name : undefined,
            false,
            Array.isArray(model.variants) ? model.variants : undefined,
          )
        }
      }
    }
  }

  for (const provider of await getClientProviders(api)) {
    if (provider.id && !providerNames.has(provider.id)) {
      providerNames.set(provider.id, provider.name ?? provider.id)
    }
  }

  try {
    const listFn = api?.client?.model?.list
    if (typeof listFn === "function") {
      const res = await listFn({})
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      for (const model of list) {
        const providerID = typeof model?.providerID === "string" ? model.providerID : ""
        const modelID =
          typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : ""
        if (!providerID || !modelID) continue
        addModel(
          providerID,
          providerNames.get(providerID) ?? providerID,
          modelID,
          typeof model?.name === "string" ? model.name : undefined,
          model?.enabled === false,
          Array.isArray(model?.variants) ? (model.variants as VariantLike[]) : undefined,
        )
      }
    }
  } catch {
    // client model list is best-effort
  }

  return options
}

async function currentModelValue(
  api: Api,
  options: ModelPickerOption[],
): Promise<ModelPickerValue | undefined> {
  const config = readConfig()
  const sessionRef = config ? null : await getSessionRef(api)
  const providerID = config?.provider ?? sessionRef?.providerID
  const modelID = config?.model ?? sessionRef?.modelID
  if (!providerID || !modelID) return undefined
  const found = options.find((option) => {
    const value = option.value
    if ("reset" in value) return false
    return value.provider === providerID && value.model === modelID
  })
  if (found) return found.value
  return { provider: providerID, model: modelID, variants: undefined }
}

async function pickVariant(
  api: Api,
  provider: string,
  model: string,
  variants: VariantLike[],
  currentVariant?: string,
): Promise<string | undefined | null> {
  const select = api?.ui?.dialog?.select
  if (typeof select !== "function") return undefined
  const options = [
    { title: "Default", value: "default", description: "No variant" },
    ...variants
      .filter((variant) => typeof variant.id === "string" && variant.id.length > 0)
      .map((variant) => ({ title: variant.id as string, value: variant.id as string })),
  ]
  try {
    const chosen = (await select({
      title: `Clarify variant: ${provider}/${model}`,
      placeholder: "Search variants...",
      options,
      current: currentVariant ?? "default",
    })) as string | undefined
    return chosen === undefined ? null : chosen === "default" ? undefined : chosen
  } catch {
    return null
  }
}

async function showModelPicker(api: Api): Promise<void> {
  const select = api?.ui?.dialog?.select
  if (typeof select !== "function") {
    toast(api, `Clarify model: ${await describeModel(api)} · config: ${configPath()}`, "info")
    return
  }

  try {
    const options = await collectModelOptions(api)
    if (options.length <= 1) {
      toast(api, "No models found. Check provider auth, or pin with /clarify:model <provider> <model>.", "warning")
      return
    }
    const chosen = (await select({
      title: "Clarify model",
      placeholder: "Search models...",
      options,
      current: await currentModelValue(api, options),
    })) as ModelPickerValue | undefined
    if (!chosen) return
    if ("reset" in chosen) {
      clearConfig()
      toast(api, "Clarify model reset to session model.", "info")
      return
    }

    const config = readConfig()
    const sameModel = config?.provider === chosen.provider && config?.model === chosen.model
    let variant: string | undefined
    if (chosen.variants && chosen.variants.length > 0) {
      const picked = await pickVariant(api, chosen.provider, chosen.model, chosen.variants, sameModel ? config?.variant : undefined)
      if (picked === null) return
      variant = picked
    }

    writeConfig({ provider: chosen.provider, model: chosen.model, ...(variant ? { variant } : {}) })
    toast(
      api,
      `Clarify model pinned to ${chosen.provider}/${chosen.model}${variant ? `:${variant}` : ""}`,
      "info",
    )
  } catch {
    toast(api, `Clarify model: ${await describeModel(api)} · config: ${configPath()}`, "info")
  }
}

async function handleModelCommand(api: Api, args: string[]): Promise<void> {
  if (args.length === 0) {
    await showModelPicker(api)
    return
  }

  if (args.length === 1 && args[0].toLowerCase() === "reset") {
    clearConfig()
    const sessionRef = await getSessionRef(api)
    toast(
      api,
      `Clarify model reset to session model${
        sessionRef?.providerID && sessionRef.modelID ? ` (${sessionRef.providerID}/${sessionRef.modelID})` : ""
      }.`,
      "info",
    )
    return
  }

  if (args.length >= 2) {
    const provider = args[0].trim()
    const modelId = args.slice(1).join(" ").trim()
    if (!provider || !modelId) {
      toast(api, USAGE, "warning")
      return
    }

    const found = await findModel(api, provider, modelId)
    if (!found) {
      toast(api, `Model not found: ${provider}/${modelId}. Check the models available in this session.`, "error")
      return
    }

    writeConfig({ provider, model: modelId })
    toast(api, `Clarify model pinned to ${provider}/${modelId}`, "info")
    return
  }

  toast(api, USAGE, "warning")
}

function resolveApiKey(provider: ProviderLike): string | undefined {
  const options = provider?.options ?? provider?.settings ?? {}
  for (const key of ["apiKey", "apikey", "api_key"]) {
    const value = options[key]
    if (typeof value === "string" && value.length > 0) return value
  }

  const envs = Array.isArray(provider?.env) ? provider.env : []
  for (const name of envs) {
    if (typeof name === "string" && process.env[name]) return process.env[name]
  }

  try {
    const dataDir = process.env.OPENCODE_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "opencode")
    const auth = JSON.parse(readFileSync(path.join(dataDir, "auth.json"), "utf8")) as Record<string, unknown>
    const entry = auth?.[provider.id ?? ""]
    if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
      const key = (entry as { key: string }).key
      if (key.length > 0) return key
    }
  } catch {
    // auth.json is optional; fall through
  }

  return undefined
}

async function callModelHttp(api: Api, resolved: ResolvedModel, text: string): Promise<string | null> {
  const provider = resolved.provider
  const model = resolved.model
  const apiKey = resolveApiKey(provider)
  if (!apiKey) return null

  const options = provider?.options ?? provider?.settings ?? {}
  const baseURL = typeof options.baseURL === "string" ? options.baseURL.replace(/\/+$/, "") : ""
  const modelSettings = model?.settings ?? {}
  const settingsBaseURL =
    typeof modelSettings.baseURL === "string" ? modelSettings.baseURL.replace(/\/+$/, "") : baseURL
  const apiUrl = typeof model?.api?.url === "string" ? model.api.url : ""
  const apiId = typeof model?.api?.id === "string" ? model.api.id : ""
  const modelID = model.id ?? model.modelID ?? ""
  const isAnthropic = /anthropic/i.test(`${provider.id ?? ""} ${settingsBaseURL} ${apiUrl}`)
  const isResponses = apiId.includes("responses") || /\/responses$/.test(apiUrl)
  const variantBody = resolved.variant?.body ?? {}
  const variantHeaders = resolved.variant?.headers ?? {}

  const signal = AbortSignal.timeout(120_000)

  if (isResponses) {
    const url = apiUrl || `${settingsBaseURL}/responses`
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...variantHeaders },
      body: JSON.stringify({
        ...variantBody,
        model: modelID,
        instructions: SYSTEM_PROMPT,
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
      }),
      signal,
    })
    if (!response.ok) throw new Error(`Clarify failed: ${await response.text()}`)
    const json = (await response.json()) as {
      output_text?: string
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
      error?: { message?: string }
    }
    const rewritten =
      typeof json.output_text === "string"
        ? json.output_text
        : (json.output ?? [])
            .flatMap((item) => item.content ?? [])
            .filter((part) => part.type === "output_text")
            .map((part) => part.text ?? "")
            .join("")
    return extractRewrite(rewritten)
  }

  if (isAnthropic) {
    const url = apiUrl || `${settingsBaseURL}/messages`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...variantHeaders,
      },
      body: JSON.stringify({
        ...variantBody,
        model: modelID,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
      signal,
    })
    if (!response.ok) throw new Error(`Clarify failed: ${await response.text()}`)
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>
      error?: { message?: string }
    }
    const rewritten = (json.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    return extractRewrite(rewritten)
  }

  const url = apiUrl || `${settingsBaseURL}/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...variantHeaders },
    body: JSON.stringify({
      ...variantBody,
      model: modelID,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal,
  })
  if (!response.ok) throw new Error(`Clarify failed: ${await response.text()}`)
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string }
  }
  const rewritten = json.choices?.[0]?.message?.content ?? ""
  return extractRewrite(rewritten)
}

function extractRewrite(rewritten: string): string | null {
  const text = rewritten.trim()
  if (!text) throw new Error("Clarify returned empty text")
  return text
}

async function collectText(res: unknown): Promise<string> {
  if (typeof res === "string") return res
  if (res && typeof res === "object") {
    const r = res as Record<string, any>
    if (typeof r.text === "string") return r.text
    if (typeof r.data === "string") return r.data
    if (r.data && typeof r.data === "object" && typeof r.data.text === "string") return r.data.text
    if (typeof r[Symbol.asyncIterator] === "function") {
      let out = ""
      for await (const chunk of r as AsyncIterable<any>) {
        if (typeof chunk === "string") out += chunk
        else if (chunk && typeof chunk === "object") {
          if (typeof chunk.text === "string") out += chunk.text
          else if (typeof chunk.data === "string") out += chunk.data
          else if (chunk.data && typeof chunk.data === "object" && typeof chunk.data.text === "string")
            out += chunk.data.text
        }
      }
      return out
    }
  }
  return ""
}

async function callGenerate(api: Api, sessionID: string, text: string): Promise<string | null> {
  try {
    const gen = api?.client?.session?.generate
    if (typeof gen !== "function" || !sessionID) return null
    const prompt = `${SYSTEM_PROMPT}\n\nRewrite this prompt. Output only the rewritten prompt text:\n\n${text}`
    const res = await gen({ sessionID, prompt })
    const collected = (await collectText(res)).trim()
    if (!collected) return null
    return collected
  } catch {
    return null
  }
}

async function rewrite(api: Api, raw: string, state: State): Promise<void> {
  const text = raw.trim()
  if (!text) {
    toast(api, USAGE, "warning")
    return
  }

  const target = getPromptEditor(api)
  const resolved = await resolveRewriteModel(api)
  if (!resolved) return

  state.busy = true
  const stopBusyToast = startBusyToast(
    api,
    `Clarifying with ${resolved.provider.id ?? "?"}/${resolved.model.id ?? "?"}${resolved.variant?.id ? `:${resolved.variant.id}` : ""}...`,
  )
  try {
    let rewritten: string | null = null
    try {
      rewritten = await callModelHttp(api, resolved, text)
    } catch (error) {
      stopBusyToast()
      toast(api, error instanceof Error ? error.message : String(error), "error")
      return
    }

    const sessionRef = await getSessionRef(api)
    if (rewritten === null && sessionRef?.sessionID) {
      rewritten = await callGenerate(api, sessionRef.sessionID, text)
    }

    if (rewritten === null) {
      stopBusyToast()
      toast(api, `No API key for ${resolved.provider.id ?? "the provider"}`, "error")
      return
    }

    state.cached = rewritten
    const editor = target && target.isDestroyed !== true ? target : getPromptEditor(api)
    if (editor) {
      editor.setText(rewritten)
      editor.gotoBufferEnd()
      try {
        api.renderer.requestRender?.()
      } catch {
        // renderer refresh is best-effort
      }
      stopBusyToast()
      toast(api, "Rewrite ready. Edit if needed, then send.", "info")
    } else {
      stopBusyToast()
      toast(api, rewritten, "info")
    }
  } catch (error) {
    stopBusyToast()
    toast(api, error instanceof Error ? error.message : String(error), "error")
  } finally {
    stopBusyToast()
    state.busy = false
  }
}

export default {
  id: "clarify",
  async setup(api: Api): Promise<void> {
    if (!api?.renderer) return

    const state: State = { busy: false, cached: "" }
    let layersRegistered = false

    const registerLayers = (): void => {
      if (layersRegistered) return
      layersRegistered = true
      try {
        api.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "clarify.rewrite",
              title: "Clarify prompt",
              desc: "Rewrite prompt · /clarify or add -clarify to activate",
              description: "Rewrite prompt · /clarify or add -clarify to activate",
              group: "Prompt",
              bind: false,
              palette: true,
              slash: { name: "clarify", arguments: true },
              run: async (args: unknown) => {
                if (typeof args === "string" && args.trim()) {
                  const parts = args.trim().split(/\s+/)
                  if (parts[0]?.toLowerCase() === "model") {
                    await handleModelCommand(api, parts.slice(1))
                    return
                  }
                  await rewrite(api, args, state)
                  return
                }
                const editor = getPromptEditor(api)
                const raw = editor ? editor.plainText : state.cached
                const trigger = parseTrigger(raw)
                if (trigger?.kind === "model") {
                  await handleModelCommand(api, trigger.args)
                  return
                }
                if (trigger?.kind === "rewrite") {
                  await rewrite(api, trigger.source, state)
                  return
                }
                await rewrite(api, raw, state)
              },
            },
            {
              id: "clarify.model",
              title: "Clarify model",
              desc: "Pick the rewrite model",
              description: "Pick the rewrite model",
              group: "Prompt",
              bind: false,
              palette: true,
              slash: { name: "clarify:model", arguments: true },
              run: async (args: unknown) => {
                const parts = typeof args === "string" && args.trim() ? args.trim().split(/\s+/) : []
                await handleModelCommand(api, parts)
              },
            },
          ],
        }))
      } catch {
        // layer registration is best-effort
      }

      try {
        api.keymap.layer(() => ({
          priority: 100,
          enabled: () => {
            const editor = getPromptEditor(api)
            if (editor) state.cached = editor.plainText
            return true
          },
          commands: [
            {
              bind: "return",
              run: () => {
                const editor = getPromptEditor(api)
                if (!editor) return false
                const trigger = parseTrigger(editor.plainText)
                if (!trigger) return false
                if (state.busy) return undefined
                if (trigger.kind === "model") {
                  editor.setText("")
                  editor.gotoBufferEnd()
                  void handleModelCommand(api, trigger.args)
                  return undefined
                }
                if (!trigger.source.trim()) {
                  editor.setText("")
                  editor.gotoBufferEnd()
                }
                void rewrite(api, trigger.source, state)
                return undefined
              },
            },
          ],
        }))
      } catch {
        // layer registration is best-effort
      }
    }

    try {
      const slotFn = api.slot ?? api.ui?.slot
      if (typeof slotFn === "function") {
        slotFn({
          append: "app",
          render: () => {
            registerLayers()
            return null
          },
        })
      }
    } catch {
      // slot registration is best-effort
    }
  },
}
