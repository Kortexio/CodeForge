/**
 * OpenCodeIDE - Terminal Integration
 * 
 * Bridge between AI tools and the IDE terminal.
 */

export interface TerminalSession {
    id: string;
    name: string;
    cwd: string;
    active: boolean;
}

export interface TerminalOutput {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

/**
 * Terminal Manager
 * 
 * Tracks and interacts with IDE terminal sessions
 */
export class TerminalManager {
    private sessions: Map<string, TerminalSession> = new Map();

    createSession(name: string, cwd: string): TerminalSession {
        const session: TerminalSession = {
            id: `term-${Date.now()}`,
            name,
            cwd,
            active: true,
        };
        this.sessions.set(session.id, session);
        return session;
    }

    getSession(id: string): TerminalSession | undefined {
        return this.sessions.get(id);
    }

    listSessions(): TerminalSession[] {
        return Array.from(this.sessions.values());
    }

    closeSession(id: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.active = false;
            this.sessions.delete(id);
        }
    }
}
