/**
 * OpenCodeIDE - Model Router
 * 
 * Routes requests to different LLM providers with harness modes
 * for weak/strong model support.
 */

import {
    ModelProvider,
    ModelConfig,
    ModelHarness,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ToolCall,
    HarnessMode,
} from '../types.js';
import { PlatformConfig } from '../platform.js';
import { ProseToolCallParser } from './prose-parser.js';

// Default harness configurations for known models
const MODEL_HARNESSES: Record<string, ModelHarness> = {
    // OpenAI
    'gpt-4o': {
        mode: 'strong',
        supportsNativeToolCalls: true,
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        promptProfile: { systemPromptStyle: 'markdown', toolCallFormat: 'native', responseFormat: 'native' },
    },
    'gpt-4-turbo': {
        mode: 'strong',
        supportsNativeToolCalls: true,
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        promptProfile: { systemPromptStyle: 'markdown', toolCallFormat: 'native', responseFormat: 'native' },
    },
    // Anthropic
    'claude-3-opus': {
        mode: 'strong',
        supportsNativeToolCalls: true,
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        promptProfile: { systemPromptStyle: 'xml', toolCallFormat: 'native', responseFormat: 'native' },
    },
    'claude-3-sonnet': {
        mode: 'strong',
        supportsNativeToolCalls: true,
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        promptProfile: { systemPromptStyle: 'xml', toolCallFormat: 'native', responseFormat: 'native' },
    },
    // Weak models (need prose parsing)
    'qwen': {
        mode: 'weak',
        supportsNativeToolCalls: false,
        supportsVision: false,
        supportsStreaming: true,
        maxContextTokens: 32000,
        promptProfile: { systemPromptStyle: 'markdown', toolCallFormat: 'prose', responseFormat: 'structured' },
    },
    'llama': {
        mode: 'weak',
        supportsNativeToolCalls: false,
        supportsVision: false,
        supportsStreaming: true,
        maxContextTokens: 8000,
        promptProfile: { systemPromptStyle: 'markdown', toolCallFormat: 'prose', responseFormat: 'structured' },
    },
};

/**
 * Model Router
 * 
 * Routes requests to LLM providers with capability normalization
 */
export class ModelRouter {
    private config: PlatformConfig;
    private providers: Map<ModelProvider, ModelProviderClient> = new Map();
    private defaultModel: string = 'gpt-4o';
    private summaryModel: string = 'gpt-4o-mini';
    private initialized = false;
    private proseParser: ProseToolCallParser;

    constructor(config: PlatformConfig) {
        this.config = config;
        this.proseParser = new ProseToolCallParser();
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        // Initialize available providers
        if (this.config.apiKey) {
            const provider = this.detectProvider(this.config.apiKey);
            if (provider) {
                this.providers.set(provider, this.createClient(provider, this.config.apiKey));
            }
        }

        this.initialized = true;
    }

    isReady(): boolean {
        return this.initialized && this.providers.size > 0;
    }

    getDefaultModel(): string {
        return this.defaultModel;
    }

    setDefaultModel(model: string): void {
        this.defaultModel = model;
    }

    getSummaryModel(): string {
        return this.summaryModel;
    }

    /**
     * Get harness configuration for a model
     */
    getHarness(model: string): ModelHarness {
        // Check exact match
        if (MODEL_HARNESSES[model]) {
            return MODEL_HARNESSES[model];
        }

        // Check prefix match
        for (const [key, harness] of Object.entries(MODEL_HARNESSES)) {
            if (model.toLowerCase().includes(key.toLowerCase())) {
                return harness;
            }
        }

        // Default to strong mode (assume modern model)
        return {
            mode: 'strong',
            supportsNativeToolCalls: true,
            supportsVision: false,
            supportsStreaming: true,
            maxContextTokens: 8000,
            promptProfile: { systemPromptStyle: 'markdown', toolCallFormat: 'native', responseFormat: 'native' },
        };
    }

    /**
     * Get harness mode for a model
     */
    getMode(model: string): HarnessMode {
        return this.getHarness(model).mode;
    }

    /**
     * Make a chat completion request
     */
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        const harness = this.getHarness(request.model);
        const provider = this.getProviderForModel(request.model);
        const client = this.providers.get(provider);

        if (!client) {
            throw new Error(`No client configured for provider: ${provider}`);
        }

        // Transform request based on harness mode
        const transformedRequest = this.transformRequest(request, harness);

        // Make the request
        const response = await client.chat(transformedRequest);

        // Transform response if using weak mode
        if (harness.mode === 'weak' && harness.promptProfile.toolCallFormat === 'prose') {
            return this.transformWeakResponse(response);
        }

        return response;
    }

    /**
     * Configure a provider
     */
    configureProvider(provider: ModelProvider, apiKey: string, baseUrl?: string): void {
        this.providers.set(provider, this.createClient(provider, apiKey, baseUrl));
    }

    /**
     * Get available providers
     */
    getAvailableProviders(): ModelProvider[] {
        return Array.from(this.providers.keys());
    }

    private detectProvider(apiKey: string): ModelProvider | null {
        if (apiKey.startsWith('sk-ant-')) return 'anthropic';
        if (apiKey.startsWith('sk-')) return 'openai';
        return null;
    }

    private getProviderForModel(model: string): ModelProvider {
        if (model.includes('gpt') || model.includes('o1')) return 'openai';
        if (model.includes('claude')) return 'anthropic';
        if (model.includes('gemini')) return 'google';
        if (model.includes('grok')) return 'xai';
        return this.config.modelProvider as ModelProvider ?? 'openai';
    }

    private createClient(provider: ModelProvider, apiKey: string, baseUrl?: string): ModelProviderClient {
        switch (provider) {
            case 'openai':
                return new OpenAIClient(apiKey, baseUrl);
            case 'anthropic':
                return new AnthropicClient(apiKey, baseUrl);
            case 'ollama':
                return new OllamaClient(baseUrl ?? 'http://localhost:11434');
            default:
                // Use OpenAI-compatible client
                return new OpenAIClient(apiKey, baseUrl);
        }
    }

    private transformRequest(request: ChatCompletionRequest, harness: ModelHarness): ChatCompletionRequest {
        // For weak models, inject tool descriptions into system prompt
        if (harness.mode === 'weak' && request.tools?.length) {
            const toolDescriptions = request.tools.map(t => 
                `Tool: ${t.name}\nDescription: ${t.description}\nParameters: ${JSON.stringify(t.parameters)}`
            ).join('\n\n');

            const systemMessage = request.messages.find(m => m.role === 'system');
            const systemContent = systemMessage?.content ?? '';
            
            const enhancedSystem = `${systemContent}\n\n## Available Tools\n\n${toolDescriptions}\n\nTo use a tool, respond with:\n<tool_call>\n{"name": "tool_name", "arguments": {...}}\n</tool_call>`;

            return {
                ...request,
                messages: request.messages.map(m => 
                    m.role === 'system' ? { ...m, content: enhancedSystem } : m
                ),
                tools: undefined, // Remove tools from weak model request
            };
        }

        return request;
    }

    private transformWeakResponse(response: ChatCompletionResponse): ChatCompletionResponse {
        const message = response.choices[0]?.message;
        if (!message?.content) return response;

        // Parse tool calls from prose
        const toolCalls = this.proseParser.parse(message.content);

        if (toolCalls.length > 0) {
            return {
                ...response,
                choices: [{
                    ...response.choices[0],
                    message: {
                        ...message,
                        toolCalls,
                    },
                    finishReason: 'tool_calls',
                }],
            };
        }

        return response;
    }
}

// Provider client interfaces
interface ModelProviderClient {
    chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

class OpenAIClient implements ModelProviderClient {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl?: string) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl ?? 'https://api.openai.com/v1';
    }

    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: request.model,
                messages: request.messages,
                tools: request.tools?.map(t => ({ type: 'function', function: t })),
                temperature: request.temperature,
                max_tokens: request.maxTokens,
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json();
        return this.transformResponse(data);
    }

    private transformResponse(data: unknown): ChatCompletionResponse {
        const d = data as Record<string, unknown>;
        const choices = d.choices as Array<Record<string, unknown>>;
        const usage = d.usage as Record<string, number>;

        return {
            id: d.id as string,
            model: d.model as string,
            choices: choices.map((c, i) => ({
                index: i,
                message: this.transformMessage(c.message as Record<string, unknown>),
                finishReason: c.finish_reason as 'stop' | 'tool_calls' | 'length' | 'content_filter',
            })),
            usage: {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
            },
        };
    }

    private transformMessage(msg: Record<string, unknown>): { role: 'assistant'; content: string; toolCalls?: ToolCall[] } {
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        return {
            role: 'assistant',
            content: msg.content as string ?? '',
            toolCalls: toolCalls?.map(tc => ({
                id: tc.id as string,
                name: (tc.function as Record<string, string>).name,
                arguments: JSON.parse((tc.function as Record<string, string>).arguments),
            })),
        };
    }
}

class AnthropicClient implements ModelProviderClient {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl?: string) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl ?? 'https://api.anthropic.com/v1';
    }

    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        // Transform to Anthropic format
        const systemMessage = request.messages.find(m => m.role === 'system');
        const otherMessages = request.messages.filter(m => m.role !== 'system');

        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: request.model,
                system: systemMessage?.content,
                messages: otherMessages.map(m => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content,
                })),
                tools: request.tools?.map(t => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters,
                })),
                temperature: request.temperature,
                max_tokens: request.maxTokens ?? 4096,
            }),
        });

        if (!response.ok) {
            throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json();
        return this.transformResponse(data);
    }

    private transformResponse(data: unknown): ChatCompletionResponse {
        const d = data as Record<string, unknown>;
        const content = d.content as Array<Record<string, unknown>>;
        const usage = d.usage as Record<string, number>;

        const textContent = content.find(c => c.type === 'text');
        const toolUseContent = content.filter(c => c.type === 'tool_use');

        return {
            id: d.id as string,
            model: d.model as string,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: (textContent?.text as string) ?? '',
                    toolCalls: toolUseContent.map(tc => ({
                        id: tc.id as string,
                        name: tc.name as string,
                        arguments: tc.input as Record<string, unknown>,
                    })),
                },
                finishReason: d.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
            }],
            usage: {
                promptTokens: usage.input_tokens,
                completionTokens: usage.output_tokens,
                totalTokens: usage.input_tokens + usage.output_tokens,
            },
        };
    }
}

class OllamaClient implements ModelProviderClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: request.model,
                messages: request.messages,
                stream: false,
                options: {
                    temperature: request.temperature,
                    num_predict: request.maxTokens,
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const message = data.message as Record<string, string>;

        return {
            id: `ollama-${Date.now()}`,
            model: request.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: message.content,
                },
                finishReason: 'stop',
            }],
            usage: {
                promptTokens: (data.prompt_eval_count as number) ?? 0,
                completionTokens: (data.eval_count as number) ?? 0,
                totalTokens: ((data.prompt_eval_count as number) ?? 0) + ((data.eval_count as number) ?? 0),
            },
        };
    }
}
