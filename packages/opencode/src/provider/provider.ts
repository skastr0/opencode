import z from "zod"
import os from "os"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Hash } from "../util/hash"
import { Plugin } from "../plugin"
import { NamedError } from "@opencode-ai/util/error"
import { ModelsDev } from "./models"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"
import path from "path"
import { Filesystem } from "../util/filesystem"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/copilot"
import { CLAUDE_AGENT_SDK_MODELS } from "./native/models"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab, VERSION as GITLAB_PROVIDER_VERSION } from "@gitlab/gitlab-ai-provider"
// WebSocket transport uses Bun's native WebSocket with custom headers
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { GoogleAuth } from "google-auth-library"
import { ProviderTransform } from "./transform"
import { Installation } from "../installation"
import { ModelID, ProviderID } from "./schema"

const DEFAULT_CHUNK_TIMEOUT = 300_000

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) return false
    return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (typeof ms !== "number" || ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@gitlab/gitlab-ai-provider": createGitLab,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    vars?: CustomVarsLoader
    options?: Record<string, any>
  }>

  function useLanguageModel(sdk: any) {
    return sdk.responses === undefined && sdk.chat === undefined
  }

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,effort-2025-11-24",
          },
        },
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "claude-agent-sdk": async () => {
      // Always autoload - SDK handles its own auth (CLI login, OAuth, API key, etc.)
      // Note: No getModel needed since we use native streaming (streamClaudeNative) instead of AI SDK
      return {
        autoload: true,
        options: {},
      }
    },
    azure: async (provider) => {
      const resource = iife(() => {
        const name = provider.options?.resourceName
        if (typeof name === "string" && name.trim() !== "") return name
        return Env.get("AZURE_RESOURCE_NAME")
      })
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
        vars(_options) {
          return {
            ...(resource && { AZURE_RESOURCE_NAME: resource }),
          }
        },
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds)
        return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from opencode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://opencode.ai/",
            "x-title": "opencode",
          },
        },
      }
    },
    "google-vertex": async (provider) => {
      const project =
        provider.options?.project ??
        Env.get("GOOGLE_CLOUD_PROJECT") ??
        Env.get("GCP_PROJECT") ??
        Env.get("GCLOUD_PROJECT")

      const location = String(
        provider.options?.location ??
          Env.get("GOOGLE_VERTEX_LOCATION") ??
          Env.get("GOOGLE_CLOUD_LOCATION") ??
          Env.get("VERTEX_LOCATION") ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const auth = new GoogleAuth()
            const client = await auth.getApplicationDefault()
            const token = await client.credential.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    gitlab: async (input) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await Auth.get(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await Config.get()
      const providerConfig = config.provider?.["gitlab"]

      const aiGatewayHeaders = {
        "User-Agent": `opencode/${Installation.VERSION} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...(providerConfig?.options?.aiGatewayHeaders || {}),
      }

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          aiGatewayHeaders,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...(providerConfig?.options?.featureFlags || {}),
            },
          })
        },
      }
    },
    "cloudflare-workers-ai": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      if (!accountId) return { autoload: false }

      const apiKey = await iife(async () => {
        const envToken = Env.get("CLOUDFLARE_API_KEY")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN") || Env.get("CF_AIG_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      if (!apiToken) {
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
        )
      }

      // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
      const { createAiGateway } = await import("ai-gateway-provider")
      const { createUnified } = await import("ai-gateway-provider/providers/unified")

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      const unified = createUnified()

      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
          return aigateway(unified(modelID))
        },
        options: {},
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
          },
        },
      }
    },
    kilo: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
  }

  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: ModelID.make(model.id),
      providerID: ProviderID.make(provider.id),
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: ProviderID.make(provider.id),
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  const state = Instance.state(
    async () => {
      using _ = log.time("state")
      const config = await Config.get()
      const modelsDev = await ModelsDev.get()
      const database: Record<string, Info> = mapValues(modelsDev, fromModelsDevProvider)

      database["claude-agent-sdk"] = {
        id: ProviderID.make("claude-agent-sdk"),
        source: "custom",
        name: "Claude Agent SDK",
        env: [],
        options: {},
        models: CLAUDE_AGENT_SDK_MODELS,
      }

      if (database["github-copilot"]) {
        const copilot = database["github-copilot"]
        database["github-copilot-enterprise"] = {
          ...copilot,
          id: ProviderID.make("github-copilot-enterprise"),
          name: "GitHub Copilot Enterprise",
          models: mapValues(copilot.models, (model) => ({
            ...model,
            providerID: ProviderID.make("github-copilot-enterprise"),
          })),
        }
      }

      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

      function isProviderAllowed(providerID: ProviderID): boolean {
        if (enabled && !enabled.has(providerID)) return false
        if (disabled.has(providerID)) return false
        return true
      }

      const providers: { [providerID: string]: Info } = {}
      const languages = new Map<string, LanguageModelV2>()
      const modelLoaders: {
        [providerID: string]: CustomModelLoader
      } = {}
      const varsLoaders: {
        [providerID: string]: CustomVarsLoader
      } = {}
      const sdk = new Map<string, SDK>()

      log.info("init")

      const configProviders = Object.entries(config.provider ?? {})

      function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
        const existing = providers[providerID]
        if (existing) {
          // @ts-expect-error
          providers[providerID] = mergeDeep(existing, provider)
          return
        }
        const match = database[providerID]
        if (!match) return
        // @ts-expect-error
        providers[providerID] = mergeDeep(match, provider)
      }

      for (const [providerID, provider] of configProviders) {
        const existing = database[providerID]
        const parsed: Info = {
          id: ProviderID.make(providerID),
          name: provider.name ?? existing?.name ?? providerID,
          env: provider.env ?? existing?.env ?? [],
          options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
          source: "config",
          models: existing?.models ?? {},
        }

        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          const existingModel = parsed.models[model.id ?? modelID]
          const name = iife(() => {
            if (model.name) return model.name
            if (model.id && model.id !== modelID) return modelID
            return existingModel?.name ?? modelID
          })
          const parsedModel: Model = {
            id: ModelID.make(modelID),
            api: {
              id: model.id ?? existingModel?.api.id ?? modelID,
              npm:
                model.provider?.npm ??
                provider.npm ??
                existingModel?.api.npm ??
                modelsDev[providerID]?.npm ??
                "@ai-sdk/openai-compatible",
              url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
            },
            status: model.status ?? existingModel?.status ?? "active",
            name,
            providerID: ProviderID.make(providerID),
            capabilities: {
              temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
              reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
              attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
              toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
              input: {
                text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
              },
              output: {
                text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
              },
              interleaved: model.interleaved ?? false,
            },
            cost: {
              input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
              output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
              cache: {
                read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
              },
            },
            options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
            limit: {
              context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
              output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
            },
            headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
            family: model.family ?? existingModel?.family ?? "",
            release_date: model.release_date ?? existingModel?.release_date ?? "",
            variants: {},
          }
          const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
          parsedModel.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
          parsed.models[modelID] = parsedModel
        }
        database[providerID] = parsed
      }

      const env = Env.all()
      for (const [id, provider] of Object.entries(database)) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        const apiKey = provider.env.map((item) => env[item]).find(Boolean)
        if (!apiKey) continue
        mergeProvider(providerID, {
          source: "env",
          key: provider.env.length === 1 ? apiKey : undefined,
        })
      }

      for (const [id, provider] of Object.entries(await Auth.all())) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        if (provider.type !== "api") continue
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }

      for (const plugin of await Plugin.list()) {
        if (!plugin.auth?.loader) continue
        const providerID = ProviderID.make(plugin.auth.provider)
        if (disabled.has(providerID)) continue

        let hasAuth = false
        const auth = await Auth.get(providerID)
        if (auth) hasAuth = true

        if (providerID === ProviderID.make("github-copilot") && !hasAuth) {
          const enterpriseAuth = await Auth.get(ProviderID.make("github-copilot-enterprise"))
          if (enterpriseAuth) hasAuth = true
        }

        if (!hasAuth) continue

        if (auth) {
          const options = await plugin.auth.loader(
            () => Auth.get(providerID) as any,
            database[plugin.auth.provider] as Info,
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        if (providerID === ProviderID.make("github-copilot")) {
          const enterpriseProviderID = ProviderID.make("github-copilot-enterprise")
          if (disabled.has(enterpriseProviderID)) continue
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (!enterpriseAuth) continue
          const enterpriseOptions = await plugin.auth.loader(
            () => Auth.get(enterpriseProviderID) as any,
            database[enterpriseProviderID] as Info,
          )
          const opts = enterpriseOptions ?? {}
          const patch: Partial<Info> = providers[enterpriseProviderID]
            ? { options: opts }
            : { source: "custom", options: opts }
          mergeProvider(enterpriseProviderID, patch)
        }
      }

      for (const [id, fn] of Object.entries(CUSTOM_LOADERS)) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        const data = database[providerID]
        if (!data) {
          log.error("Provider does not exist in model list " + providerID)
          continue
        }
        const result = await fn(data)
        if (result && (result.autoload || providers[providerID])) {
          if (result.getModel) modelLoaders[providerID] = result.getModel
          if (result.vars) varsLoaders[providerID] = result.vars
          const opts = result.options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }
      }

      for (const [id, provider] of configProviders) {
        const providerID = ProviderID.make(id)
        const partial: Partial<Info> = { source: "config" }
        if (provider.env) partial.env = provider.env
        if (provider.name) partial.name = provider.name
        if (provider.options) partial.options = provider.options
        mergeProvider(providerID, partial)
      }

      for (const [id, provider] of Object.entries(providers)) {
        const providerID = ProviderID.make(id)
        if (!isProviderAllowed(providerID)) {
          delete providers[providerID]
          continue
        }

        const configProvider = config.provider?.[providerID]

        for (const [modelID, model] of Object.entries(provider.models)) {
          model.api.id = model.api.id ?? model.id ?? modelID
          if (
            modelID === "gpt-5-chat-latest" ||
            (providerID === ProviderID.openrouter && modelID === "openai/gpt-5-chat")
          )
            delete provider.models[modelID]
          if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
          if (model.status === "deprecated") delete provider.models[modelID]
          if (
            (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
            (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
          )
            delete provider.models[modelID]

          model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
          const configVariants = configProvider?.models?.[modelID]?.variants
          if (configVariants && model.variants) {
            const merged = mergeDeep(model.variants, configVariants)
            model.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
          }
        }

        if (Object.keys(provider.models).length === 0) {
          delete providers[providerID]
          continue
        }

        log.info("found", { providerID })
      }

      return {
        models: languages,
        providers,
        sdk,
        cleanup: new Map<string, () => void>(),
        modelLoaders,
        varsLoaders,
      }
    },
    async (state) => {
      for (const close of state.cleanup.values()) close()
      state.cleanup.clear()
      state.sdk.clear()
      state.models.clear()
    },
  )

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
        delete options.fetch
      }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      const baseURL = iife(() => {
        let url =
          typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
        if (!url) return

        // some models/providers have variable urls, ex: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1"
        // We track this in models.dev, and then when we are resolving the baseURL
        // we need to string replace that literal: "${AZURE_RESOURCE_NAME}"
        const loader = s.varsLoaders[model.providerID]
        if (loader) {
          const vars = loader(options)
          for (const [key, value] of Object.entries(vars)) {
            const field = "${" + key + "}"
            url = url.replaceAll(field, value)
          }
        }

        url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
          const val = Env.get(String(key))
          return val ?? item
        })
        return url
      })

      if (baseURL !== undefined) options["baseURL"] = baseURL
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key

      // For Anthropic SDK models on non-anthropic providers (e.g. opencode proxy),
      // add the anthropic-beta header required for extended thinking
      if (
        model.api.npm === "@ai-sdk/anthropic" &&
        model.providerID !== "anthropic" &&
        !options["headers"]?.["anthropic-beta"]
      ) {
        options["headers"] = {
          ...options["headers"],
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,effort-2025-11-24",
        }
      }

      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Hash.fast(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      const chunkTimeout = options["chunkTimeout"] || DEFAULT_CHUNK_TIMEOUT
      delete options["chunkTimeout"]

      type ResponsesSocketState = {
        socket?: WebSocket
        key?: string
        busy: boolean
        idleTimer?: ReturnType<typeof setTimeout>
      }

      const responsesSockets = new Map<string, ResponsesSocketState>()
      let responsesSocketRetryAfter = 0
      const responsesSocketRetryDelay = 30_000

      const getResponsesSocketState = (session: string) => {
        const match = responsesSockets.get(session)
        if (match) return match
        const state: ResponsesSocketState = { busy: false }
        responsesSockets.set(session, state)
        return state
      }

      const cleanupResponsesSocketState = (session: string) => {
        const match = responsesSockets.get(session)
        if (!match) return
        if (match.busy) return
        if (match.socket) return
        if (match.idleTimer) return
        responsesSockets.delete(session)
      }

      const clearResponsesSocketIdleTimer = (session: string) => {
        const match = responsesSockets.get(session)
        if (!match?.idleTimer) return
        clearTimeout(match.idleTimer)
        match.idleTimer = undefined
      }

      const closeResponsesWebSocket = (session: string, preserveBusy = false, reason = "stale") => {
        const match = responsesSockets.get(session)
        if (!match) return
        clearResponsesSocketIdleTimer(session)
        if (
          match.socket &&
          (match.socket.readyState === WebSocket.OPEN || match.socket.readyState === WebSocket.CONNECTING)
        ) {
          log.debug("closing responses websocket", {
            providerID: model.providerID,
            modelID: model.id,
            session,
            preserveBusy,
            reason,
          })
          match.socket.close(1000, reason)
        }
        match.socket = undefined
        match.key = undefined
        if (!preserveBusy) {
          match.busy = false
          cleanupResponsesSocketState(session)
        }
      }

      const getWebSocketHeaders = (headers: BunFetchRequestInit["headers"]) => {
        const resolved = Object.fromEntries(new Headers(headers).entries())
        // Required by OpenAI WebSocket mode
        resolved["openai-beta"] = "responses_websockets=2026-02-06"
        return resolved
      }

      const getWebSocketKey = (url: string, headers: Record<string, string>) => {
        return JSON.stringify({
          url,
          authorization: headers["authorization"],
          accountId: headers["chatgpt-account-id"],
        })
      }

      const getResponsesSocketSession = (body: Record<string, any>) => {
        const key = body["prompt_cache_key"] ?? body["promptCacheKey"]
        if (typeof key === "string" && key.trim()) return key
        return "__default__"
      }

      const closeAllResponsesWebSockets = () => {
        const sessions = [...responsesSockets.keys()]
        if (sessions.length === 0) return
        log.info("closing all responses websockets", {
          providerID: model.providerID,
          modelID: model.id,
          count: sessions.length,
        })
        for (const session of sessions) {
          closeResponsesWebSocket(session, false, "provider-dispose")
        }
      }

      const scheduleResponsesWebSocketIdleClose = (session: string, timeout: number | undefined) => {
        if (timeout === undefined) return
        const match = responsesSockets.get(session)
        if (!match) return
        if (match.busy) return
        if (!match.socket) {
          cleanupResponsesSocketState(session)
          return
        }
        clearResponsesSocketIdleTimer(session)
        log.debug("scheduled responses websocket idle close", {
          providerID: model.providerID,
          modelID: model.id,
          session,
          timeout,
        })
        match.idleTimer = setTimeout(() => {
          const next = responsesSockets.get(session)
          if (!next) return
          if (next.busy) return
          if (!next.socket) {
            cleanupResponsesSocketState(session)
            return
          }
          log.debug("evicting idle responses websocket", {
            providerID: model.providerID,
            modelID: model.id,
            session,
            timeout,
          })
          closeResponsesWebSocket(session, false, "idle-timeout")
        }, timeout)
      }

      const openResponsesWebSocket = async (
        session: string,
        url: string,
        headers: Record<string, string>,
        signal?: AbortSignal,
      ): Promise<WebSocket> => {
        const state = getResponsesSocketState(session)
        const key = getWebSocketKey(url, headers)

        if (state.socket && state.socket.readyState === WebSocket.OPEN && state.key === key) {
          log.debug("reusing responses websocket", {
            providerID: model.providerID,
            modelID: model.id,
            session,
          })
          clearResponsesSocketIdleTimer(session)
          return state.socket
        }

        if (
          state.socket &&
          (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)
        ) {
          closeResponsesWebSocket(session, true, "stale")
        }

        log.info("opening responses websocket", {
          providerID: model.providerID,
          modelID: model.id,
          url,
          hasAuth: !!headers["authorization"],
        })

        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(url, { headers } as any)
          let timer: ReturnType<typeof setTimeout> | undefined

          const cleanup = () => {
            socket.removeEventListener("open", onOpen)
            socket.removeEventListener("error", onError)
            socket.removeEventListener("close", onClose)
            signal?.removeEventListener("abort", onAbort)
            if (timer) clearTimeout(timer)
          }

          const fail = (reason: string) => {
            cleanup()
            try {
              if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
            } catch {
              // Ignore close errors
            }
            log.error("websocket connection failed", {
              providerID: model.providerID,
              modelID: model.id,
              reason,
            })
            reject(new Error(reason))
          }

          const onOpen = () => {
            cleanup()
            log.info("websocket connection established", {
              providerID: model.providerID,
              modelID: model.id,
            })
            resolve(socket)
          }

          const onError = () => fail("websocket connection error")
          const onClose = (event: Event) => {
            const close = event as CloseEvent
            fail(`websocket closed before open${close.code ? ` (code=${close.code}, reason=${close.reason})` : ""}`)
          }

          const onAbort = () => fail("websocket aborted")

          socket.addEventListener("open", onOpen)
          socket.addEventListener("error", onError)
          socket.addEventListener("close", onClose)

          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener("abort", onAbort, { once: true })

          timer = setTimeout(() => fail("websocket connection timeout (3s)"), 3000)
        })

        ws.addEventListener("close", (event: Event) => {
          const close = event as CloseEvent
          log.debug("responses websocket closed", {
            providerID: model.providerID,
            modelID: model.id,
            session,
            code: close.code,
            reason: close.reason,
          })
          const match = responsesSockets.get(session)
          if (!match || match.socket !== ws) return
          clearResponsesSocketIdleTimer(session)
          match.socket = undefined
          match.key = undefined
          match.busy = false
          cleanupResponsesSocketState(session)
        })

        state.socket = ws
        state.key = key
        return ws
      }

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}
        const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
        const signals: AbortSignal[] = []
        const requestUrl =
          input instanceof URL ? input : new URL(typeof input === "string" ? input : (input as Request).url)

        const isOpenAIRequest = model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST"
        const isOpenAIResponsesRequest = isOpenAIRequest && requestUrl.pathname.endsWith("/responses")
        const defaultCompactionThreshold: number | undefined = undefined
        const defaultResponsesSocketIdleTimeout = 5 * 60 * 1000
        const websocketMode =
          options["websocketMode"] === undefined ? model.providerID === "openai" : options["websocketMode"] !== false
        const standaloneCompaction = options["standaloneCompaction"] === true
        const compactionThreshold =
          options["compactionThreshold"] === false
            ? undefined
            : typeof options["compactionThreshold"] === "number"
              ? options["compactionThreshold"]
              : defaultCompactionThreshold
        const responsesSocketIdleTimeout =
          options["responsesSocketIdleTimeoutMs"] === false
            ? undefined
            : typeof options["responsesSocketIdleTimeoutMs"] === "number"
              ? Math.max(0, Math.floor(options["responsesSocketIdleTimeoutMs"]))
              : defaultResponsesSocketIdleTimeout

        let parsedBody: Record<string, any> | undefined
        if (isOpenAIRequest && typeof opts.body === "string") {
          try {
            parsedBody = JSON.parse(opts.body)
          } catch {
            // Ignore non-JSON body
          }
        }

        if (opts.signal) signals.push(opts.signal)
        if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
        if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false) {
          signals.push(AbortSignal.timeout(options["timeout"]))
        }

        const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
        if (combined) opts.signal = combined

        if (isOpenAIRequest && parsedBody) {
          const body = parsedBody
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) delete item.id
            }
          }

          if (
            isOpenAIResponsesRequest &&
            compactionThreshold !== undefined &&
            Number.isFinite(compactionThreshold) &&
            body.context_management == null
          ) {
            body.context_management = [
              {
                type: "compaction",
                compact_threshold: Math.max(1000, Math.floor(compactionThreshold)),
              },
            ]
          }

          if (isOpenAIResponsesRequest && standaloneCompaction && Array.isArray(body.input) && body.input.length > 0) {
            const compactUrl = new URL(requestUrl.toString())
            compactUrl.pathname = compactUrl.pathname.replace(/\/responses$/, "/responses/compact")

            try {
              const compactHeaders = new Headers(opts.headers)
              compactHeaders.set("content-type", "application/json")
              const compactResult = await fetchFn(compactUrl, {
                method: "POST",
                headers: compactHeaders,
                body: JSON.stringify({ model: body.model, input: body.input }),
                signal: opts.signal,
                // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
                timeout: false,
              })

              if (compactResult.ok) {
                const compactJson = await compactResult.json().catch(() => undefined)
                if (compactJson && typeof compactJson === "object" && Array.isArray((compactJson as any).output)) {
                  body.input = (compactJson as any).output
                }
              }
            } catch (error) {
              log.warn("standalone compaction failed", {
                providerID: model.providerID,
                modelID: model.id,
                error,
              })
            }
          }

          opts.body = JSON.stringify(body)
          parsedBody = body
        }

        const responsesSocketSession =
          isOpenAIResponsesRequest && parsedBody ? getResponsesSocketSession(parsedBody) : undefined
        const responsesSocketState = responsesSocketSession
          ? getResponsesSocketState(responsesSocketSession)
          : undefined
        const responsesSocketReady = Date.now() >= responsesSocketRetryAfter

        if (
          isOpenAIResponsesRequest &&
          websocketMode &&
          parsedBody &&
          parsedBody.stream === true &&
          responsesSocketSession &&
          responsesSocketState &&
          !responsesSocketState.busy &&
          responsesSocketReady
        ) {
          const wsHeaders = getWebSocketHeaders(opts.headers)
          let wsUrl: URL

          if (customFetch) {
            const auth = await Auth.get(model.providerID)
            if (auth?.type === "oauth" && auth.access) {
              wsHeaders["authorization"] = `Bearer ${auth.access}`
              const authWithAccount = auth as typeof auth & { accountId?: string }
              if (authWithAccount.accountId) {
                wsHeaders["chatgpt-account-id"] = authWithAccount.accountId
              }
              wsUrl = new URL("wss://chatgpt.com/backend-api/codex/responses")
            } else {
              wsUrl = new URL(requestUrl.toString())
              wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
            }
          } else {
            wsUrl = new URL(requestUrl.toString())
            wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
          }

          responsesSocketState.busy = true
          let socket: WebSocket | undefined
          try {
            socket = await openResponsesWebSocket(
              responsesSocketSession,
              wsUrl.toString(),
              wsHeaders,
              opts.signal ?? undefined,
            )
          } catch (error) {
            responsesSocketState.busy = false
            closeResponsesWebSocket(responsesSocketSession, false, "open-failed")
            if (opts.signal?.aborted) throw error
            responsesSocketRetryAfter = Date.now() + responsesSocketRetryDelay
            log.warn("responses websocket unavailable, falling back to http", {
              providerID: model.providerID,
              modelID: model.id,
              session: responsesSocketSession,
              retryAfter: responsesSocketRetryAfter,
              error: error instanceof Error ? error.message : String(error),
            })
          }

          if (socket) {
            const payload = { ...parsedBody, type: "response.create" }
            delete (payload as any).stream
            delete (payload as any).background

            const encoder = new TextEncoder()
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                let done = false

                const releaseSocket = () => {
                  const state = responsesSockets.get(responsesSocketSession)
                  if (!state) return
                  state.busy = false
                  scheduleResponsesWebSocketIdleClose(responsesSocketSession, responsesSocketIdleTimeout)
                }

                const cleanup = () => {
                  socket.removeEventListener("message", onMessage)
                  socket.removeEventListener("close", onClose)
                  socket.removeEventListener("error", onError)
                  opts.signal?.removeEventListener("abort", onAbort)
                }

                const enqueueEvent = (value: unknown) => {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
                }

                const finish = (error?: string) => {
                  if (done) return
                  done = true
                  cleanup()
                  releaseSocket()

                  if (error) {
                    enqueueEvent({
                      type: "error",
                      error: {
                        type: "invalid_request_error",
                        code: "websocket_transport_error",
                        message: error,
                      },
                      status: 500,
                    })
                    closeResponsesWebSocket(responsesSocketSession, false, "stream-error")
                  }

                  controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  controller.close()
                }

                const parseMessage = (data: unknown) => {
                  if (typeof data === "string") {
                    try {
                      return JSON.parse(data)
                    } catch {
                      return {
                        type: "error",
                        error: {
                          type: "invalid_request_error",
                          code: "websocket_invalid_json",
                          message: data,
                        },
                        status: 500,
                      }
                    }
                  }

                  if (data instanceof ArrayBuffer) {
                    const text = Buffer.from(new Uint8Array(data)).toString("utf8")
                    try {
                      return JSON.parse(text)
                    } catch {
                      return {
                        type: "error",
                        error: {
                          type: "invalid_request_error",
                          code: "websocket_invalid_json",
                          message: text,
                        },
                        status: 500,
                      }
                    }
                  }

                  return data
                }

                const onMessage = (event: Event) => {
                  const msg = parseMessage((event as MessageEvent).data)
                  enqueueEvent(msg)
                  const type = (msg as any)?.type
                  if (type === "response.completed" || type === "response.incomplete" || type === "error") {
                    finish()
                  }
                }

                const onClose = (event: Event) => {
                  const close = event as CloseEvent
                  if (!done) finish(`websocket closed${close.code ? ` (${close.code})` : ""}`)
                }
                const onError = () => {
                  if (!done) finish("websocket stream error")
                }
                const onAbort = () => {
                  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close(1000, "request aborted")
                  }
                  finish("request aborted")
                }

                socket.addEventListener("message", onMessage)
                socket.addEventListener("close", onClose)
                socket.addEventListener("error", onError)
                opts.signal?.addEventListener("abort", onAbort, { once: true })

                try {
                  socket.send(JSON.stringify(payload))
                } catch (error) {
                  finish(error instanceof Error ? error.message : String(error))
                }
              },
              cancel() {
                const state = responsesSockets.get(responsesSocketSession)
                if (!state) return
                state.busy = false
                scheduleResponsesWebSocketIdleClose(responsesSocketSession, responsesSocketIdleTimeout)
              },
            })

            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "x-opencode-transport": "responses-websocket",
              },
            })
          }
        }

        const response = await fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })

        const res =
          isOpenAIResponsesRequest && parsedBody?.stream === true && !response.headers.get("x-opencode-transport")
            ? new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: (() => {
                  const headers = new Headers(response.headers)
                  headers.set("x-opencode-transport", "responses-http")
                  return headers
                })(),
              })
            : response

        if (!chunkAbortCtl) return res
        return wrapSSE(res, chunkTimeout, chunkAbortCtl)
      }

      const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: model.api.npm })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        s.cleanup.set(key, closeAllResponsesWebSockets)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      s.cleanup.set(key, closeAllResponsesWebSockets)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: ProviderID) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: ProviderID, modelID: ModelID) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: ProviderID, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: ProviderID) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("opencode")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        if (providerID === ProviderID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]
          const candidates = Object.keys(provider.models).filter((m) => m.includes(item))

          // Model selection priority:
          // 1. global. prefix (works everywhere)
          // 2. User's region prefix (us., eu.)
          // 3. Unprefixed model
          const globalMatch = candidates.find((m) => m.startsWith("global."))
          if (globalMatch) return getModel(providerID, ModelID.make(globalMatch))

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((m) => m.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return getModel(providerID, ModelID.make(regionalMatch))
            }
          }

          const unprefixed = candidates.find((m) => !crossRegionPrefixes.some((p) => m.startsWith(p)))
          if (unprefixed) return getModel(providerID, ModelID.make(unprefixed))
        } else {
          for (const model of Object.keys(provider.models)) {
            if (model.includes(item)) return getModel(providerID, ModelID.make(model))
          }
        }
      }
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort<T extends { id: string }>(models: T[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const providers = await list()
    const recent = (await Filesystem.readJson<{ recent?: { providerID: ProviderID; modelID: ModelID }[] }>(
      path.join(Global.Path.state, "model.json"),
    )
      .then((x) => (Array.isArray(x.recent) ? x.recent : []))
      .catch(() => [])) as { providerID: ProviderID; modelID: ModelID }[]
    for (const entry of recent) {
      const provider = providers[entry.providerID]
      if (!provider) continue
      if (!provider.models[entry.modelID]) continue
      return { providerID: entry.providerID, modelID: entry.modelID }
    }

    const provider = Object.values(providers).find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models) as Model[])
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )
}
