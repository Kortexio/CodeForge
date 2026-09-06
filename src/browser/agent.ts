/**
 * OpenCodeIDE - Browser Agent
 * 
 * Browser automation using Playwright (when available) or native CDP.
 */

import { Artifact } from '../ai/types.js';

export interface BrowserConfig {
    headless?: boolean;
    viewport?: { width: number; height: number };
    userAgent?: string;
    artifactStore?: ArtifactStoreLike;
}

export interface ArtifactStoreLike {
    create(type: string, name: string, content: string): Promise<Artifact>;
}

export interface ElementInfo {
    selector: string;
    text: string;
    tag: string;
    attributes: Record<string, string>;
    boundingBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

/**
 * Browser Agent
 * 
 * Provides browser automation capabilities
 */
export class BrowserAgent {
    private config: BrowserConfig;
    private browser: BrowserLike | null = null;
    private page: PageLike | null = null;
    private initialized = false;

    constructor(config: BrowserConfig = {}) {
        this.config = {
            headless: true,
            viewport: { width: 1280, height: 720 },
            ...config,
        };
    }

    /**
     * Initialize browser
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            // Try to use Playwright
            const playwright = await this.tryLoadPlaywright();
            if (playwright) {
                this.browser = await playwright.chromium.launch({
                    headless: this.config.headless,
                });
                this.page = await this.browser.newPage();
                await this.page.setViewportSize(this.config.viewport!);
            } else {
                console.warn('Playwright not available. Browser features limited.');
            }
        } catch (error) {
            console.error('Failed to initialize browser:', error);
        }

        this.initialized = true;
    }

    /**
     * Shutdown browser
     */
    async shutdown(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
        this.initialized = false;
    }

    /**
     * Navigate to URL
     */
    async navigate(url: string): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        await this.page.goto(url);
    }

    /**
     * Get accessibility snapshot
     */
    async getSnapshot(): Promise<string> {
        if (!this.page) throw new Error('Browser not initialized');

        // Get accessibility tree
        const snapshot = await this.page.accessibility?.snapshot() ?? {};
        return this.formatAccessibilityTree(snapshot);
    }

    /**
     * Click element
     */
    async click(selector: string): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        await this.page.click(selector);
    }

    /**
     * Type text
     */
    async type(selector: string, text: string): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        await this.page.fill(selector, text);
    }

    /**
     * Press key
     */
    async press(key: string): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        await this.page.keyboard.press(key);
    }

    /**
     * Take screenshot
     */
    async screenshot(): Promise<Artifact | null> {
        if (!this.page || !this.config.artifactStore) return null;

        const buffer = await this.page.screenshot({ fullPage: false });
        const base64 = buffer.toString('base64');
        
        return this.config.artifactStore.create(
            'screenshot',
            `screenshot-${Date.now()}`,
            base64
        );
    }

    /**
     * Get page content
     */
    async getContent(): Promise<string> {
        if (!this.page) throw new Error('Browser not initialized');
        return this.page.content();
    }

    /**
     * Get console logs
     */
    async getConsoleLogs(): Promise<string[]> {
        // Would need to set up listener on page creation
        return [];
    }

    /**
     * Get network requests
     */
    async getNetworkRequests(): Promise<Array<{ url: string; method: string; status: number }>> {
        // Would need to set up listener on page creation
        return [];
    }

    /**
     * Find elements by selector
     */
    async findElements(selector: string): Promise<ElementInfo[]> {
        if (!this.page) throw new Error('Browser not initialized');

        const elements = await this.page.$$(selector);
        const results: ElementInfo[] = [];

        for (const element of elements) {
            const text = await element.textContent() ?? '';
            const tagName = await element.evaluate((el: Element) => el.tagName.toLowerCase());
            const attrs = await element.evaluate((el: Element) => {
                const result: Record<string, string> = {};
                for (const attr of el.attributes) {
                    result[attr.name] = attr.value;
                }
                return result;
            });
            const box = await element.boundingBox();

            results.push({
                selector,
                text: text.trim(),
                tag: tagName,
                attributes: attrs,
                boundingBox: box ?? undefined,
            });
        }

        return results;
    }

    /**
     * Wait for selector
     */
    async waitFor(selector: string, timeout: number = 5000): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        await this.page.waitForSelector(selector, { timeout });
    }

    /**
     * Scroll page
     */
    async scroll(direction: 'up' | 'down', amount: number = 500): Promise<void> {
        if (!this.page) throw new Error('Browser not initialized');
        
        const delta = direction === 'down' ? amount : -amount;
        await this.page.mouse.wheel(0, delta);
    }

    /**
     * Try to load Playwright
     */
    private async tryLoadPlaywright(): Promise<PlaywrightLike | null> {
        try {
            // Dynamic import to avoid hard dependency
            const playwright = await import('playwright');
            return playwright;
        } catch {
            return null;
        }
    }

    /**
     * Format accessibility tree for context
     */
    private formatAccessibilityTree(node: AccessibilityNode, indent: number = 0): string {
        if (!node) return '';

        const lines: string[] = [];
        const prefix = '  '.repeat(indent);
        const role = node.role ?? 'unknown';
        const name = node.name ?? '';
        const value = node.value ?? '';

        let line = `${prefix}[${role}]`;
        if (name) line += ` "${name}"`;
        if (value) line += ` (${value})`;
        lines.push(line);

        if (node.children) {
            for (const child of node.children) {
                lines.push(this.formatAccessibilityTree(child, indent + 1));
            }
        }

        return lines.join('\n');
    }
}

// Type definitions for Playwright-like interface
interface PlaywrightLike {
    chromium: {
        launch(options?: { headless?: boolean }): Promise<BrowserLike>;
    };
}

interface BrowserLike {
    newPage(): Promise<PageLike>;
    close(): Promise<void>;
}

interface PageLike {
    goto(url: string): Promise<void>;
    content(): Promise<string>;
    click(selector: string): Promise<void>;
    fill(selector: string, text: string): Promise<void>;
    screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
    $$(selector: string): Promise<ElementHandleLike[]>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
    accessibility?: {
        snapshot(): Promise<AccessibilityNode>;
    };
    keyboard: {
        press(key: string): Promise<void>;
    };
    mouse: {
        wheel(x: number, y: number): Promise<void>;
    };
}

interface ElementHandleLike {
    textContent(): Promise<string | null>;
    evaluate<T>(fn: (el: Element) => T): Promise<T>;
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

interface AccessibilityNode {
    role?: string;
    name?: string;
    value?: string;
    children?: AccessibilityNode[];
}
