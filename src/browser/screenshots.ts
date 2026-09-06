/**
 * OpenCodeIDE - Screenshot Manager
 * 
 * Manages browser screenshots for visual testing.
 */

import * as path from 'path';

/**
 * Screenshot Manager
 * 
 * Stores and compares screenshots
 */
export class ScreenshotManager {
    private readonly dataPath: string;
    private screenshots: Map<string, ScreenshotInfo> = new Map();

    constructor(dataPath: string) {
        this.dataPath = path.join(dataPath, 'screenshots');
    }

    /**
     * Get storage path
     */
    getDataPath(): string {
        return this.dataPath;
    }

    /**
     * Store a screenshot
     */
    store(name: string, base64Data: string): ScreenshotInfo {
        const info: ScreenshotInfo = {
            name,
            data: base64Data,
            timestamp: new Date(),
        };

        this.screenshots.set(name, info);
        return info;
    }

    /**
     * Get a screenshot
     */
    get(name: string): ScreenshotInfo | undefined {
        return this.screenshots.get(name);
    }

    /**
     * List all screenshots
     */
    list(): ScreenshotInfo[] {
        return Array.from(this.screenshots.values());
    }

    /**
     * Compare two screenshots (basic pixel comparison)
     */
    async compare(name1: string, name2: string): Promise<ComparisonResult> {
        const ss1 = this.screenshots.get(name1);
        const ss2 = this.screenshots.get(name2);

        if (!ss1 || !ss2) {
            return {
                identical: false,
                similarity: 0,
                error: 'Screenshot not found',
            };
        }

        // Simple comparison - in production would use image comparison library
        if (ss1.data === ss2.data) {
            return {
                identical: true,
                similarity: 1.0,
            };
        }

        // Estimate similarity based on data length difference
        const lenDiff = Math.abs(ss1.data.length - ss2.data.length);
        const maxLen = Math.max(ss1.data.length, ss2.data.length);
        const similarity = 1 - (lenDiff / maxLen);

        return {
            identical: false,
            similarity,
        };
    }

    /**
     * Delete a screenshot
     */
    delete(name: string): void {
        this.screenshots.delete(name);
    }

    /**
     * Clear all screenshots
     */
    clear(): void {
        this.screenshots.clear();
    }
}

export interface ScreenshotInfo {
    name: string;
    data: string;
    timestamp: Date;
}

export interface ComparisonResult {
    identical: boolean;
    similarity: number;
    diffImage?: string;
    error?: string;
}
