import { Injectable } from '@nestjs/common';

/** Stand-in for your session store: when an IdP deactivates a user, their sessions end. */
@Injectable()
export class SessionsService {
  private readonly sessions = new Map<string, Set<string>>();
  readonly revoked: string[] = [];

  open(userId: string, sessionId: string): void {
    const sessions = this.sessions.get(userId) ?? new Set<string>();
    sessions.add(sessionId);
    this.sessions.set(userId, sessions);
  }

  revokeAll(userId: string): number {
    const count = this.sessions.get(userId)?.size ?? 0;
    this.sessions.delete(userId);
    this.revoked.push(userId);
    return count;
  }
}
