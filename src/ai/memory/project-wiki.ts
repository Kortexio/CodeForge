/**
 * OpenCodeIDE - Project Wiki
 * 
 * Cross-session project knowledge with temporal facts.
 * Based on ContextMemory's GlobalWikiService architecture.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { WikiFact } from '../types.js';

/**
 * Project Wiki Document
 */
interface WikiDocument {
    id: string;
    title: string;
    content: string;
    keywords: string[];
    summary: string;
    category: string;
    createdAt: Date;
    updatedAt: Date;
    revisions: WikiRevision[];
}

/**
 * Wiki Revision for temporal facts
 */
interface WikiRevision {
    id: string;
    content: string;
    validFrom: Date;
    validTo?: Date;
    supersededBy?: string;
    reason?: string;
}

/**
 * Project Wiki Manager
 * 
 * Manages project-level knowledge with temporal awareness
 */
export class ProjectWikiManager {
    private dataPath: string;
    private documents: Map<string, WikiDocument> = new Map();
    private facts: Map<string, WikiFact> = new Map();
    private initialized = false;

    constructor(dataPath: string) {
        this.dataPath = path.join(dataPath, 'project-wiki');
    }

    /**
     * Initialize and load from disk
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await fs.mkdir(this.dataPath, { recursive: true });
        await this.loadFromDisk();
        this.initialized = true;
    }

    /**
     * Save to disk
     */
    async save(): Promise<void> {
        const data = {
            documents: Array.from(this.documents.values()),
            facts: Array.from(this.facts.values()),
        };
        await fs.writeFile(
            path.join(this.dataPath, 'wiki.json'),
            JSON.stringify(data, null, 2)
        );
    }

    /**
     * Create or update a document
     */
    async upsertDocument(
        id: string,
        title: string,
        content: string,
        category: string = 'general'
    ): Promise<WikiDocument> {
        const existing = this.documents.get(id);

        if (existing) {
            // Create revision
            const revision: WikiRevision = {
                id: uuid(),
                content: existing.content,
                validFrom: existing.updatedAt,
                validTo: new Date(),
                reason: 'Updated',
            };
            existing.revisions.push(revision);

            // Update document
            existing.content = content;
            existing.title = title;
            existing.category = category;
            existing.updatedAt = new Date();
            existing.keywords = this.extractKeywords(content);
            existing.summary = this.generateSummary(content);

            await this.save();
            return existing;
        }

        // Create new document
        const doc: WikiDocument = {
            id,
            title,
            content,
            category,
            keywords: this.extractKeywords(content),
            summary: this.generateSummary(content),
            createdAt: new Date(),
            updatedAt: new Date(),
            revisions: [],
        };

        this.documents.set(id, doc);
        await this.save();
        return doc;
    }

    /**
     * Get document by ID
     */
    getDocument(id: string): WikiDocument | undefined {
        return this.documents.get(id);
    }

    /**
     * Get document as of a specific date
     */
    getDocumentAsOf(id: string, asOf: Date): WikiDocument | undefined {
        const doc = this.documents.get(id);
        if (!doc) return undefined;

        // Find the revision that was valid at that time
        for (const revision of doc.revisions.reverse()) {
            if (revision.validFrom <= asOf && (!revision.validTo || revision.validTo > asOf)) {
                return {
                    ...doc,
                    content: revision.content,
                };
            }
        }

        // If asOf is after all revisions, return current
        if (doc.createdAt <= asOf) {
            return doc;
        }

        return undefined;
    }

    /**
     * Search documents
     */
    search(query: string, options: { category?: string; limit?: number } = {}): WikiDocument[] {
        const queryTerms = query.toLowerCase().split(/\s+/);
        const limit = options.limit ?? 10;

        const results = Array.from(this.documents.values())
            .filter(doc => !options.category || doc.category === options.category)
            .map(doc => ({
                doc,
                score: this.calculateSearchScore(doc, queryTerms),
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(item => item.doc);

        return results;
    }

    /**
     * Full-text search with keyword matching
     */
    grep(pattern: string): WikiDocument[] {
        const regex = new RegExp(pattern, 'gi');
        return Array.from(this.documents.values())
            .filter(doc => regex.test(doc.content) || regex.test(doc.title));
    }

    /**
     * Add a temporal fact
     */
    addFact(content: string, validFrom: Date = new Date()): WikiFact {
        const fact: WikiFact = {
            id: uuid(),
            content,
            validFrom,
        };

        this.facts.set(fact.id, fact);
        return fact;
    }

    /**
     * Supersede a fact
     */
    supersedeFact(factId: string, newContent: string): WikiFact {
        const oldFact = this.facts.get(factId);
        if (oldFact) {
            oldFact.validTo = new Date();
        }

        const newFact: WikiFact = {
            id: uuid(),
            content: newContent,
            validFrom: new Date(),
        };

        if (oldFact) {
            oldFact.supersededBy = newFact.id;
        }

        this.facts.set(newFact.id, newFact);
        return newFact;
    }

    /**
     * Get facts valid at a specific time
     */
    getFactsAsOf(asOf: Date): WikiFact[] {
        return Array.from(this.facts.values())
            .filter(f => f.validFrom <= asOf && (!f.validTo || f.validTo > asOf));
    }

    /**
     * Get current valid facts
     */
    getCurrentFacts(): WikiFact[] {
        return this.getFactsAsOf(new Date());
    }

    /**
     * Get all documents by category
     */
    getByCategory(category: string): WikiDocument[] {
        return Array.from(this.documents.values())
            .filter(doc => doc.category === category);
    }

    /**
     * Get digests (summaries) of top documents
     */
    getDigests(limit: number = 10): Array<{ id: string; title: string; summary: string }> {
        return Array.from(this.documents.values())
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, limit)
            .map(doc => ({
                id: doc.id,
                title: doc.title,
                summary: doc.summary,
            }));
    }

    /**
     * Delete a document
     */
    async deleteDocument(id: string): Promise<void> {
        this.documents.delete(id);
        await this.save();
    }

    private async loadFromDisk(): Promise<void> {
        try {
            const data = await fs.readFile(path.join(this.dataPath, 'wiki.json'), 'utf-8');
            const parsed = JSON.parse(data) as { documents: WikiDocument[]; facts: WikiFact[] };

            for (const doc of parsed.documents) {
                doc.createdAt = new Date(doc.createdAt);
                doc.updatedAt = new Date(doc.updatedAt);
                doc.revisions.forEach(r => {
                    r.validFrom = new Date(r.validFrom);
                    if (r.validTo) r.validTo = new Date(r.validTo);
                });
                this.documents.set(doc.id, doc);
            }

            for (const fact of parsed.facts) {
                fact.validFrom = new Date(fact.validFrom);
                if (fact.validTo) fact.validTo = new Date(fact.validTo);
                this.facts.set(fact.id, fact);
            }
        } catch {
            // No existing wiki
        }
    }

    private calculateSearchScore(doc: WikiDocument, queryTerms: string[]): number {
        let score = 0;
        const titleLower = doc.title.toLowerCase();
        const contentLower = doc.content.toLowerCase();
        const keywordsLower = doc.keywords.map(k => k.toLowerCase());

        for (const term of queryTerms) {
            // Title match (highest weight)
            if (titleLower.includes(term)) score += 3;
            // Keyword match (high weight)
            if (keywordsLower.some(k => k.includes(term))) score += 2;
            // Content match (lower weight)
            if (contentLower.includes(term)) score += 1;
        }

        return score;
    }

    private extractKeywords(content: string): string[] {
        // Simple keyword extraction
        const words = content.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 3);

        // Count frequency
        const freq: Record<string, number> = {};
        for (const word of words) {
            freq[word] = (freq[word] || 0) + 1;
        }

        // Return top keywords
        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word]) => word);
    }

    private generateSummary(content: string, maxLength: number = 200): string {
        // Take first paragraph or first N characters
        const firstParagraph = content.split('\n\n')[0];
        if (firstParagraph.length <= maxLength) {
            return firstParagraph;
        }
        return firstParagraph.substring(0, maxLength - 3) + '...';
    }
}
