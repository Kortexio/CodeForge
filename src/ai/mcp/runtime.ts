/**
 * OpenCodeIDE - MCP Runtime
 * 
 * Model Context Protocol client for external tool integrations.
 */

import {
    McpServer,
    McpTool,
    ToolSchema,
    ToolCall,
    ToolResult,
} from '../types.js';

/**
 * MCP Runtime
 * 
 * Manages MCP server connections and tool execution
 */
export class McpRuntime {
    private dataPath: string;
    private servers: Map<string, McpServer> = new Map();
    private tools: Map<string, McpTool> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        // Load server configurations
        // TODO: Load from dataPath
        
        this.initialized = true;
    }

    async shutdown(): Promise<void> {
        // Disconnect from all servers
        for (const server of this.servers.values()) {
            await this.disconnectServer(server.name);
        }
        this.initialized = false;
    }

    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Add an MCP server configuration
     */
    async addServer(server: McpServer): Promise<void> {
        this.servers.set(server.name, server);
        
        if (server.enabled) {
            await this.connectServer(server.name);
        }
    }

    /**
     * Remove an MCP server
     */
    async removeServer(name: string): Promise<void> {
        await this.disconnectServer(name);
        this.servers.delete(name);
    }

    /**
     * Connect to an MCP server
     */
    async connectServer(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (!server) throw new Error(`Server not found: ${name}`);

        // TODO: Implement actual MCP connection
        // For now, just mark as connected
        server.enabled = true;

        // Refresh tool list
        await this.refreshTools(name);
    }

    /**
     * Disconnect from an MCP server
     */
    async disconnectServer(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (!server) return;

        // Remove tools from this server
        for (const [toolName, tool] of this.tools) {
            if (tool.server === name) {
                this.tools.delete(toolName);
            }
        }

        server.enabled = false;
    }

    /**
     * Refresh tools from a server
     */
    async refreshTools(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (!server || !server.enabled) return;

        // TODO: Implement actual MCP tools/list call
        // For now, no tools
    }

    /**
     * Get all available MCP tools
     */
    getTools(): McpTool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get tool schemas for prompt
     */
    async getToolSchemas(): Promise<ToolSchema[]> {
        return Array.from(this.tools.values()).map(t => t.schema);
    }

    /**
     * Execute an MCP tool
     */
    async executeTool(toolCall: ToolCall): Promise<ToolResult> {
        const startTime = Date.now();

        // Parse server__tool format
        const [serverName, toolName] = toolCall.name.split('__');
        
        const server = this.servers.get(serverName);
        if (!server) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: `MCP server not found: ${serverName}`,
                duration: Date.now() - startTime,
            };
        }

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: `MCP tool not found: ${toolName}`,
                duration: Date.now() - startTime,
            };
        }

        // Check if tool is allowed
        if (server.deniedTools?.includes(toolName)) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: `Tool is denied by policy: ${toolName}`,
                duration: Date.now() - startTime,
            };
        }

        if (server.allowedTools && !server.allowedTools.includes(toolName)) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: `Tool is not in allowed list: ${toolName}`,
                duration: Date.now() - startTime,
            };
        }

        try {
            // TODO: Implement actual MCP tools/call
            const result = await this.callMcpTool(server, toolName, toolCall.arguments);

            return {
                toolCallId: toolCall.id,
                success: true,
                output: JSON.stringify(result, null, 2),
                duration: Date.now() - startTime,
            };
        } catch (error) {
            return {
                toolCallId: toolCall.id,
                success: false,
                output: '',
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime,
            };
        }
    }

    /**
     * Get server list
     */
    getServers(): McpServer[] {
        return Array.from(this.servers.values());
    }

    /**
     * Get server status
     */
    getServerStatus(name: string): { connected: boolean; toolCount: number } {
        const server = this.servers.get(name);
        if (!server) {
            return { connected: false, toolCount: 0 };
        }

        const toolCount = Array.from(this.tools.values()).filter(t => t.server === name).length;
        return { connected: server.enabled, toolCount };
    }

    private async callMcpTool(server: McpServer, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        if (server.transport === 'http' && server.url) {
            // HTTP transport
            const response = await fetch(`${server.url}/tools/call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(server.auth?.type === 'bearer' && server.auth.credentials
                        ? { Authorization: `Bearer ${server.auth.credentials}` }
                        : {}),
                    ...(server.auth?.type === 'api-key' && server.auth.credentials
                        ? { 'X-API-Key': server.auth.credentials }
                        : {}),
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: {
                        name: toolName,
                        arguments: args,
                    },
                    id: Date.now(),
                }),
            });

            if (!response.ok) {
                throw new Error(`MCP call failed: ${response.status}`);
            }

            const data = await response.json() as { result?: unknown; error?: { message: string } };
            if (data.error) {
                throw new Error(data.error.message);
            }

            return data.result;
        } else if (server.transport === 'stdio') {
            // stdio transport - would spawn process and communicate via stdin/stdout
            // TODO: Implement stdio transport
            throw new Error('stdio transport not yet implemented');
        }

        throw new Error(`Unknown transport: ${server.transport}`);
    }
}
