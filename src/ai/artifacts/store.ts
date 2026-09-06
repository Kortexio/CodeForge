/**
 * OpenCodeIDE - Artifact Store
 * 
 * Manages large outputs and files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { Artifact, ArtifactType } from '../types.js';

/**
 * Artifact Store
 * 
 * Stores and retrieves large artifacts
 */
export class ArtifactStore {
    private artifactsPath: string;
    private artifacts: Map<string, Artifact> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.artifactsPath = path.join(dataPath, 'artifacts');
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        // Create artifacts directory
        await fs.mkdir(this.artifactsPath, { recursive: true });
        
        // Load artifact index
        try {
            const indexPath = path.join(this.artifactsPath, 'index.json');
            const indexContent = await fs.readFile(indexPath, 'utf-8');
            const index = JSON.parse(indexContent) as Artifact[];
            for (const artifact of index) {
                this.artifacts.set(artifact.id, artifact);
            }
        } catch {
            // No index file yet
        }
        
        this.initialized = true;
    }

    /**
     * Create a new artifact
     */
    async create(type: ArtifactType, name: string, content: string): Promise<Artifact> {
        const id = uuid();
        const filename = `${id}.txt`;
        const fullPath = path.join(this.artifactsPath, filename);

        // Write content to file
        await fs.writeFile(fullPath, content, 'utf-8');

        // Create preview (first 500 chars)
        const preview = content.substring(0, 500) + (content.length > 500 ? '...' : '');

        const artifact: Artifact = {
            id,
            type,
            name,
            preview,
            fullPath,
            size: Buffer.byteLength(content, 'utf-8'),
            createdAt: new Date(),
        };

        this.artifacts.set(id, artifact);
        await this.saveIndex();

        return artifact;
    }

    /**
     * Get an artifact by ID
     */
    async get(id: string): Promise<Artifact | null> {
        return this.artifacts.get(id) ?? null;
    }

    /**
     * Read full artifact content
     */
    async read(id: string): Promise<string | null> {
        const artifact = this.artifacts.get(id);
        if (!artifact) return null;

        try {
            return await fs.readFile(artifact.fullPath, 'utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Read last N lines of artifact
     */
    async tail(id: string, lines: number = 50): Promise<string | null> {
        const content = await this.read(id);
        if (!content) return null;

        const allLines = content.split('\n');
        const lastLines = allLines.slice(-lines);
        return lastLines.join('\n');
    }

    /**
     * Delete an artifact
     */
    async delete(id: string): Promise<void> {
        const artifact = this.artifacts.get(id);
        if (!artifact) return;

        try {
            await fs.unlink(artifact.fullPath);
        } catch {
            // File may already be deleted
        }

        this.artifacts.delete(id);
        await this.saveIndex();
    }

    /**
     * List all artifacts
     */
    list(): Artifact[] {
        return Array.from(this.artifacts.values());
    }

    /**
     * List artifacts by type
     */
    listByType(type: ArtifactType): Artifact[] {
        return Array.from(this.artifacts.values()).filter(a => a.type === type);
    }

    /**
     * Clean up old artifacts
     */
    async cleanup(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
        const now = Date.now();
        let deleted = 0;

        for (const [id, artifact] of this.artifacts) {
            if (now - artifact.createdAt.getTime() > maxAge) {
                await this.delete(id);
                deleted++;
            }
        }

        return deleted;
    }

    private async saveIndex(): Promise<void> {
        const indexPath = path.join(this.artifactsPath, 'index.json');
        const artifacts = Array.from(this.artifacts.values());
        await fs.writeFile(indexPath, JSON.stringify(artifacts, null, 2), 'utf-8');
    }
}
