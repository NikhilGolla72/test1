/**
 * Auth module barrel export.
 *
 * Import from this file when plugging the auth/session system into another app:
 *   import { authService, tokenManager, sessionManager } from './auth';
 */
export { sessionManager } from './sessionManager';
export { tokenManager } from './tokenManager';
export { authService } from './authService';
export type { SessionInvalidationReason, SessionInvalidationEvent, SessionManagerConfig } from './types';
