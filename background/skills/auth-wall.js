// background/skills/auth-wall.js
// Fires when the agent hits a login wall, SSO redirect, or MFA challenge mid-run.
// Common in MSP work: navigating between M365 tenants, Azure subscriptions, or
// enterprise portals where sessions expire or SSO kicks in unexpectedly.

import { getErrorMessage } from '../error-utils.js';

const _LOGIN_URL_RE = /\/login|\/signin|\/sign-in|\/auth|\/sso|\/oauth|\/saml|\/adfs|\/mfa|\/verify|microsoftonline\.com|accounts\.google\.com|login\.live\.com|okta\.com|auth0\.com|duosecurity\.com|\.ping(?:identity|federate)|duo\.com/i;
const _LOGIN_TEXT_RE = /\b(sign\s*in|log\s*in|enter\s*your\s*(email|password|username)|forgot\s*password|two.?factor|authenticat(?:or|ion)\s*code|verification\s*code|send\s*code|approve\s*sign.?in|mfa\s*required|session\s*(expired|timed?\s*out)|please\s*(sign|log)\s*in|identity\s*verification)\b/i;
const _MFA_TEXT_RE = /mfa|two.?factor|verif|authenticat|duo|approve/i;
const _SSO_DOMAIN_RE = /microsoftonline|okta|ping|auth0|saml|adfs/i;

export const authWall = {
  id: 'auth-wall',
  description: 'Recovery when agent hits a login page, SSO redirect, or MFA challenge',
  priority: 88,

  matches(ctx) {
    if (!ctx) return false;
    const url = typeof ctx.currentUrl === 'string' ? ctx.currentUrl : '';
    const pageText = typeof ctx.pageText === 'string' ? ctx.pageText : '';
    // Url-based detection: known auth/SSO endpoints
    if (_LOGIN_URL_RE.test(url)) return true;
    // Text-based detection: login/MFA language on a short page (< 3000 chars suggests a gate)
    if (_LOGIN_TEXT_RE.test(pageText) && pageText.length < 3000) return true;
    return false;
  },

  autoApply(_ctx) {
    // No deterministic auto-apply — the user needs to authenticate manually.
    // Returning null lets the prompt injection guide the LLM to pause and wait.
    return null;
  },

  promptInjection(ctx) {
    try {
      const url = (typeof ctx.currentUrl === 'string' ? ctx.currentUrl : '(unknown)').replace(/[`\\]/g, '_').substring(0, 200);
      const isMfa = _MFA_TEXT_RE.test(ctx.pageText || '');
      const isSso = _SSO_DOMAIN_RE.test(url);

      if (isMfa) {
        return `You are on an MFA / multi-factor authentication challenge page (${url}). The user must approve this sign-in manually. Do NOT attempt to type codes or click approve buttons on behalf of the user — MFA is designed to require their physical interaction.

Actions:
1. Use \`{type:'note', text:'⚠️ MFA challenge detected — waiting for user to approve sign-in.'}\` to log this.
2. Use \`{type:'wait_for_navigation', timeout:120000}\` with a 2-minute timeout to wait for the user to complete MFA and be redirected back.
3. After navigation completes, use \`{type:'read_page'}\` to verify you are past the auth gate.
4. If MFA takes longer, repeat the wait_for_navigation.`;
      }

      if (isSso) {
        return `You have been redirected to an SSO / identity provider (${url}). This is a federated login — the user's credentials are managed by their IdP (Microsoft, Okta, Google, etc.).

Actions:
1. Check if this is expected (you navigated to a protected resource that requires login).
2. If the user already has a session, try waiting: \`{type:'wait_for_navigation', timeout:15000}\` — SSO may auto-complete.
3. If the page has a username/email field, you CAN type the user's credentials: \`{type:'type', selector:'input[type=email],input[name=loginfmt]', text:'<use client knowledge or ask>'}\`.
4. After successful SSO redirect, use \`{type:'read_page'}\` to confirm you reached the target page.`;
      }

      return `You are on a login / authentication page (${url}). The resource you were trying to reach requires authentication.

Actions:
1. If you have the credentials in memory or client knowledge, proceed with login: type email → type password → click Sign In.
2. If credentials are not available, use \`{type:'note', text:'Login required at: ${url} — credentials needed'}\` and pause.
3. After successful login, use \`{type:'wait_for_navigation', timeout:15000}\` to wait for redirect to the target page.
4. Use \`{type:'read_page'}\` to verify you are now on the intended page before continuing with the original goal.`;
    } catch (error) {
      console.error('Error generating prompt injection for auth-wall:', getErrorMessage(error));
      return 'Error generating prompt injection for auth-wall. Please check logs for details.';
    }
  }
};