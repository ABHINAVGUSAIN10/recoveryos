import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { aiProposalSchema, revenueIncidentContextSchema, revenueProposalSchema, type AiProposal, type Incident, type RevenueIncidentContext, type RevenueProposal } from '@recoveryos/domain';
import { safeErrorMessage } from './redaction';
import { rateLimitRetryDelayMs, wait } from './provider-rate-limit';

type AiProvider = 'deepseek' | 'groq' | 'custom';
type ChatCompletionRequest = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
};
type AiConfig = {
  provider: AiProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  thinkingMode: 'enabled' | 'disabled';
};

const PROVIDER_DEFAULTS: Record<Exclude<AiProvider, 'custom'>, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
};

const PROMPT_VERSION = 'classifier-v7';
const REVENUE_PROMPT_VERSION = 'revenue-playbook-v1';
const GROQ_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'payout_incident_proposal',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['TRANSIENT_TECHNICAL', 'INVALID_BENEFICIARY', 'REVERSED', 'PROCESSING_AMBIGUITY', 'UNKNOWN', 'SUCCESSFUL'],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidenceSummary: { type: 'string', minLength: 1, maxLength: 1000 },
        recommendedAction: { type: 'string', enum: ['RETRY', 'ESCALATE', 'STOP', 'NO_ACTION'] },
        proposedDelayMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 10080 },
      },
      required: ['category', 'confidence', 'evidenceSummary', 'recommendedAction', 'proposedDelayMinutes'],
      additionalProperties: false,
    },
  },
};
const GROQ_REVENUE_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'revenue_recovery_playbook',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['TRANSIENT_PROVIDER', 'SOFT_DECLINE', 'INSUFFICIENT_FUNDS', 'CUSTOMER_AUTHENTICATION', 'INVALID_PAYMENT_METHOD', 'DUPLICATE_OR_PROCESSING', 'FRAUD_OR_COMPLIANCE', 'UNKNOWN'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        diagnosis: { type: 'string', minLength: 1, maxLength: 1000 },
        evidence: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: { eventId: { type: 'string' }, fact: { type: 'string' } }, required: ['eventId', 'fact'], additionalProperties: false } },
        recommendedAction: { type: 'string', enum: ['SMART_RETRY', 'CREATE_PAYMENT_LINK', 'CONTACT_CUSTOMER', 'ESCALATE', 'STOP'] },
        proposedDelayMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 10080 },
        playbook: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: { order: { type: 'integer', minimum: 1, maximum: 5 }, action: { type: 'string', enum: ['SMART_RETRY', 'CREATE_PAYMENT_LINK', 'CONTACT_CUSTOMER', 'ESCALATE', 'STOP'] }, delayMinutes: { type: 'integer', minimum: 0, maximum: 10080 }, requiresHuman: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['order', 'action', 'delayMinutes', 'requiresHuman', 'rationale'], additionalProperties: false } },
        riskFlags: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['DUPLICATE_RISK', 'CONSENT_REQUIRED', 'HIGH_VALUE', 'AUTHENTICATION_REQUIRED', 'COMPLIANCE_REVIEW'] } },
      },
      required: ['category', 'confidence', 'diagnosis', 'evidence', 'recommendedAction', 'proposedDelayMinutes', 'playbook', 'riskFlags'],
      additionalProperties: false,
    },
  },
};
const SAFE_FALLBACK: AiProposal = {
  category: 'UNKNOWN',
  confidence: 0,
  evidenceSummary: 'AI analysis unavailable; human review required.',
  recommendedAction: 'STOP',
  proposedDelayMinutes: null,
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  status() {
    if (!process.env.AI_API_KEY) {
      return { mode: 'deterministic-simulator', configured: false, provider: 'deterministic', model: 'heuristic-v1', thinkingMode: 'not-applicable', promptVersion: 'heuristic-v1' };
    }
    try {
      const config = this.resolveConfig();
      return { mode: 'hosted-model', configured: true, provider: config.provider, model: config.model, thinkingMode: config.provider === 'deepseek' ? config.thinkingMode : 'not-applicable', promptVersion: PROMPT_VERSION };
    } catch {
      return { mode: 'configuration-error', configured: false, provider: process.env.AI_PROVIDER || 'unknown', model: process.env.AI_MODEL || 'unknown', promptVersion: PROMPT_VERSION };
    }
  }

  async classify(incident: Incident): Promise<{ proposal: AiProposal; modelRef: string; promptVersion: string }> {
    if (!process.env.AI_API_KEY) {
      return { proposal: this.heuristic(incident), modelRef: 'deterministic-simulator', promptVersion: 'heuristic-v1' };
    }

    let config: AiConfig;
    try {
      config = this.resolveConfig();
    } catch {
      this.logger.warn('AI configuration is invalid; safely stopping for human review.');
      return { proposal: SAFE_FALLBACK, modelRef: 'configuration-error', promptVersion: PROMPT_VERSION };
    }

    const client = this.createClient(config);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const request: ChatCompletionRequest = {
          model: config.model,
          ...(config.provider !== 'deepseek' || config.thinkingMode === 'disabled' ? { temperature: 0 } : {}),
          ...(config.provider === 'deepseek' ? { thinking: { type: config.thinkingMode } } : {}),
          ...(config.provider === 'groq' ? { reasoning_effort: 'low' as const } : {}),
          max_tokens: 600,
          response_format: config.provider === 'groq' ? GROQ_RESPONSE_FORMAT : { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Classify payout incidents. Return only the requested structured fields. Never authorize money movement. Apply these mandatory mappings: PROCESSING_AMBIGUITY -> STOP with null delay; UNKNOWN -> STOP with null delay; INVALID_BENEFICIARY -> ESCALATE with null delay; REVERSED -> ESCALATE with null delay; SUCCESSFUL -> NO_ACTION with null delay. RETRY is permitted only for TRANSIENT_TECHNICAL and must include a non-null delay. Explicit temporary, technical, switch, network, connectivity, gateway, or unavailable failures are TRANSIENT_TECHNICAL unless the incident is processing or pending. Any PROCESSING or pending provider state is PROCESSING_AMBIGUITY, never TRANSIENT_TECHNICAL. Use UNKNOWN when the only evidence is an unsupported or unrecognized failure code, missing detail, a generic failure, or an opaque provider response. Do not infer INVALID_BENEFICIARY or PROCESSING_AMBIGUITY without explicit evidence of that condition. Example: {"category":"UNKNOWN","confidence":0,"evidenceSummary":"Insufficient evidence.","recommendedAction":"STOP","proposedDelayMinutes":null}',
            },
            { role: 'user', content: JSON.stringify(incident) },
          ],
        };
        const completion = await client.chat.completions.create(request);
        const content = completion.choices[0]?.message.content;
        if (!content) throw new Error('empty AI response');
        const proposal = aiProposalSchema.parse(JSON.parse(content));
        const modelRef = config.provider === 'deepseek' ? `${config.provider}:${config.model}:thinking-${config.thinkingMode}` : `${config.provider}:${config.model}`;
        return { proposal, modelRef, promptVersion: PROMPT_VERSION };
      } catch (error) {
        this.logger.warn(JSON.stringify({
          event: 'ai_classification_attempt_failed', provider: config.provider, model: config.model,
          thinkingMode: config.provider === 'deepseek' ? config.thinkingMode : 'not-applicable', attempt: attempt + 1,
          error: safeErrorMessage(error),
        }));
        if (attempt === 0) {
          const retryDelayMs = rateLimitRetryDelayMs(error);
          if (retryDelayMs > 0) {
            this.logger.warn(JSON.stringify({ event: 'ai_rate_limit_backoff', provider: config.provider, retryDelayMs }));
            await wait(retryDelayMs);
          }
          continue;
        }
      }
    }

    this.logger.warn('AI classification failed after bounded retry; safely stopping for human review.');
    const modelRef = config.provider === 'deepseek' ? `${config.provider}:${config.model}:thinking-${config.thinkingMode}:unavailable` : `${config.provider}:${config.model}:unavailable`;
    return { proposal: SAFE_FALLBACK, modelRef, promptVersion: PROMPT_VERSION };
  }

  async analyzeRevenue(input: RevenueIncidentContext): Promise<{ proposal: RevenueProposal; modelRef: string; promptVersion: string }> {
    const context = revenueIncidentContextSchema.parse(input);
    if (!process.env.AI_API_KEY) return { proposal: this.revenueHeuristic(context), modelRef: 'deterministic-revenue-simulator', promptVersion: 'revenue-heuristic-v1' };
    let config: AiConfig;
    try { config = this.resolveConfig(); }
    catch { return { proposal: this.revenueFallback(context, 'AI configuration is invalid.'), modelRef: 'configuration-error', promptVersion: REVENUE_PROMPT_VERSION }; }

    const client = this.createClient(config);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const request: ChatCompletionRequest = {
          model: config.model,
          ...(config.provider !== 'deepseek' || config.thinkingMode === 'disabled' ? { temperature: 0 } : {}),
          ...(config.provider === 'deepseek' ? { thinking: { type: config.thinkingMode } } : {}),
          ...(config.provider === 'groq' ? { reasoning_effort: 'low' as const } : {}),
          max_tokens: 1200,
          response_format: config.provider === 'groq' ? GROQ_REVENUE_RESPONSE_FORMAT : { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Diagnose an inbound payment failure using only the persisted timeline supplied by the user. Cite exact eventId values in every evidence item and never invent evidence. Propose a maximum three-step bounded recovery playbook, but never authorize or claim that money moved. Apply these mappings consistently: explicit transient-provider failures -> SMART_RETRY after 30 minutes; issuer soft declines -> SMART_RETRY after at least 180 minutes; insufficient funds with an active mandate -> SMART_RETRY after at least 1440 minutes; authentication-required or 3DS failures with explicit customer-contact consent -> CREATE_PAYMENT_LINK requiring a human, otherwise ESCALATE; invalid or expired payment methods -> ESCALATE; active, duplicated, queued, pending, or processing payment states -> DUPLICATE_OR_PROCESSING and STOP; fraud or compliance signals -> ESCALATE with COMPLIANCE_REVIEW; unknown evidence -> STOP. Customer contact and payment links always require explicit consent and human approval. The deterministic policy engine will independently authorize or reject the first step.',
            },
            { role: 'user', content: JSON.stringify(context) },
          ],
        };
        const completion = await client.chat.completions.create(request);
        const content = completion.choices[0]?.message.content;
        if (!content) throw new Error('empty AI response');
        const proposal = revenueProposalSchema.parse(JSON.parse(content));
        const modelRef = config.provider === 'deepseek' ? `${config.provider}:${config.model}:thinking-${config.thinkingMode}` : `${config.provider}:${config.model}`;
        return { proposal, modelRef, promptVersion: REVENUE_PROMPT_VERSION };
      } catch (error) {
        this.logger.warn(JSON.stringify({ event: 'revenue_ai_attempt_failed', provider: config.provider, model: config.model, attempt: attempt + 1, error: safeErrorMessage(error) }));
        if (attempt === 0) {
          const retryDelayMs = rateLimitRetryDelayMs(error);
          if (retryDelayMs > 0) await wait(retryDelayMs);
          continue;
        }
      }
    }
    return { proposal: this.revenueFallback(context, 'AI analysis unavailable after bounded retry.'), modelRef: `${config.provider}:${config.model}:unavailable`, promptVersion: REVENUE_PROMPT_VERSION };
  }

  private resolveConfig(): AiConfig {
    const provider = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
    if (provider !== 'deepseek' && provider !== 'groq' && provider !== 'custom') {
      throw new Error('unsupported AI provider');
    }

    const defaults = provider === 'custom' ? undefined : PROVIDER_DEFAULTS[provider];
    const baseURL = process.env.AI_BASE_URL || defaults?.baseURL;
    const model = process.env.AI_MODEL || defaults?.model;
    const parsedTimeout = Number.parseInt(process.env.AI_TIMEOUT_MS || '15000', 10);
    const thinkingMode = process.env.AI_THINKING_MODE || 'disabled';
    if (!baseURL || !model || !Number.isFinite(parsedTimeout) || parsedTimeout < 1_000 || parsedTimeout > 120_000) {
      throw new Error('incomplete AI configuration');
    }
    if (thinkingMode !== 'enabled' && thinkingMode !== 'disabled') throw new Error('invalid AI thinking mode');

    return { provider, apiKey: process.env.AI_API_KEY!, baseURL, model, timeoutMs: parsedTimeout, thinkingMode };
  }

  private createClient(config: AiConfig): OpenAI {
    return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 });
  }

  private heuristic(incident: Incident): AiProposal {
    const reason = (incident.reason || '').toLowerCase();
    if (incident.status === 'PROCESSING' || /processing|timeout|pending/.test(reason)) return { category: 'PROCESSING_AMBIGUITY', confidence: .99, evidenceSummary: 'Provider state is ambiguous or processing.', recommendedAction: 'STOP', proposedDelayMinutes: null };
    if (/invalid|closed|frozen|dormant/.test(reason)) return { category: 'INVALID_BENEFICIARY', confidence: .95, evidenceSummary: 'Beneficiary cannot receive funds.', recommendedAction: 'ESCALATE', proposedDelayMinutes: null };
    if (/revers(?:ed|al)|revert/.test(reason)) return { category: 'REVERSED', confidence: .85, evidenceSummary: 'Payout was reversed and requires review.', recommendedAction: 'ESCALATE', proposedDelayMinutes: null };
    if (/technical|bank|temporary|unavailable|network/.test(reason)) return { category: 'TRANSIENT_TECHNICAL', confidence: .9, evidenceSummary: 'Temporary technical or beneficiary-bank condition.', recommendedAction: 'RETRY', proposedDelayMinutes: 30 };
    if (incident.status === 'RECOVERED') return { category: 'SUCCESSFUL', confidence: 1, evidenceSummary: 'Payout is already successful.', recommendedAction: 'NO_ACTION', proposedDelayMinutes: null };
    return { category: 'UNKNOWN', confidence: .5, evidenceSummary: 'No supported failure pattern found.', recommendedAction: 'STOP', proposedDelayMinutes: null };
  }

  private revenueFallback(context: RevenueIncidentContext, reason: string): RevenueProposal {
    const event = context.timeline.at(-1)!;
    return { category: 'UNKNOWN', confidence: 0, diagnosis: `${reason} Human review is required.`, evidence: [{ eventId: event.eventId, fact: event.summary }], recommendedAction: 'STOP', proposedDelayMinutes: null, playbook: [{ order: 1, action: 'STOP', delayMinutes: 0, requiresHuman: true, rationale: 'Insufficient validated evidence for an automated revenue action.' }], riskFlags: [] };
  }

  private revenueHeuristic(context: RevenueIncidentContext): RevenueProposal {
    const text = `${context.failureCode} ${context.failureDescription} ${context.timeline.map(event => `${event.eventType} ${event.summary}`).join(' ')}`.toLowerCase();
    const event = context.timeline.at(-1)!;
    const evidence = [{ eventId: event.eventId, fact: event.summary }];
    const highValue = context.amountPaise > 1_000_000 ? ['HIGH_VALUE' as const] : [];
    const retryPlaybook = (delayMinutes: number): RevenueProposal['playbook'] => [
      { order: 1, action: 'SMART_RETRY', delayMinutes, requiresHuman: false, rationale: 'Retry only after the bounded cooling-off interval.' },
      ...(context.consentToContact ? [{ order: 2 as const, action: 'CREATE_PAYMENT_LINK' as const, delayMinutes: 60, requiresHuman: true, rationale: 'If the retry fails, offer an approved alternative payment path.' }] : []),
      { order: context.consentToContact ? 3 : 2, action: 'STOP', delayMinutes: 1440, requiresHuman: false, rationale: 'Stop after the bounded recovery window to prevent repeated charges.' },
    ];
    if (/processing|pending|duplicate|already initiated/.test(text)) return { category: 'DUPLICATE_OR_PROCESSING', confidence: .99, diagnosis: 'The payment outcome is active or duplicate-prone; another charge could double collect.', evidence, recommendedAction: 'STOP', proposedDelayMinutes: null, playbook: [{ order: 1, action: 'STOP', delayMinutes: 0, requiresHuman: false, rationale: 'Wait for terminal provider confirmation.' }], riskFlags: ['DUPLICATE_RISK'] };
    if (/fraud|risk|compliance|stolen/.test(text)) return { category: 'FRAUD_OR_COMPLIANCE', confidence: .98, diagnosis: 'The timeline contains a fraud or compliance signal.', evidence, recommendedAction: 'ESCALATE', proposedDelayMinutes: null, playbook: [{ order: 1, action: 'ESCALATE', delayMinutes: 0, requiresHuman: true, rationale: 'Route to compliance without attempting collection.' }], riskFlags: ['COMPLIANCE_REVIEW'] };
    if (/expired|invalid card|invalid method|card closed/.test(text)) return { category: 'INVALID_PAYMENT_METHOD', confidence: .96, diagnosis: 'The stored payment method cannot be retried safely.', evidence, recommendedAction: 'ESCALATE', proposedDelayMinutes: null, playbook: [{ order: 1, action: 'ESCALATE', delayMinutes: 0, requiresHuman: true, rationale: 'Obtain a valid payment method before collection.' }], riskFlags: [...highValue] };
    if (/3ds|authentication|otp|customer action/.test(text)) return { category: 'CUSTOMER_AUTHENTICATION', confidence: .95, diagnosis: 'The customer must complete authentication before payment can succeed.', evidence, recommendedAction: context.consentToContact ? 'CREATE_PAYMENT_LINK' : 'ESCALATE', proposedDelayMinutes: null, playbook: [{ order: 1, action: context.consentToContact ? 'CREATE_PAYMENT_LINK' : 'ESCALATE', delayMinutes: 0, requiresHuman: true, rationale: 'Require an authenticated customer-present payment path.' }], riskFlags: ['AUTHENTICATION_REQUIRED', ...(context.consentToContact ? ['CONSENT_REQUIRED' as const] : [])] };
    if (/insufficient|low balance/.test(text)) return { category: 'INSUFFICIENT_FUNDS', confidence: .9, diagnosis: 'The issuer declined because available customer funds were insufficient.', evidence, recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 1440, playbook: retryPlaybook(1440), riskFlags: highValue };
    if (/temporary|timeout|network|gateway|unavailable|issuer down/.test(text)) return { category: 'TRANSIENT_PROVIDER', confidence: .93, diagnosis: 'The provider or issuer reported a transient technical failure.', evidence, recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 30, playbook: retryPlaybook(30), riskFlags: highValue };
    if (/soft decline|do not honor|issuer declined/.test(text)) return { category: 'SOFT_DECLINE', confidence: .82, diagnosis: 'The issuer returned a potentially recoverable soft decline.', evidence, recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 180, playbook: retryPlaybook(180), riskFlags: highValue };
    return this.revenueFallback(context, 'No supported recovery pattern was found.');
  }
}
