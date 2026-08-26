import { createHash, createHmac, randomUUID } from 'crypto';
import { config } from 'dotenv';

config({ path: '../../.env' });

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type AcceptanceOptions = {
  baseUrl?: string;
  webhookSecret?: string;
  authMode?: string;
  viewerToken?: string;
  operatorToken?: string;
  simulationMode?: string;
  fetchImpl?: FetchLike;
};

type WebhookResult = { duplicate: boolean; incidentId: string };
type IncidentDetail = { status: string; events?: Array<unknown>; auditEvents?: Array<{ eventType?: string }> };
type BatchResult = { id: string };
type BatchExport = { cohortSize: number; results: Array<{ incidentId: string }> };

export function signWebhookBody(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function bearer(token: string | undefined, required: boolean): Record<string, string> {
  if (!required) return {};
  if (!token) throw new Error('Acceptance role token is required when AUTH_MODE=token.');
  return { Authorization: `Bearer ${token}` };
}

async function responseText(fetchImpl: FetchLike, url: string, init: RequestInit) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`Acceptance request failed with status ${response.status}.`);
  return text;
}

async function responseJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
  const text = await responseText(fetchImpl, url, init);
  return JSON.parse(text) as T;
}

export async function runWebhookAcceptance(options: AcceptanceOptions = {}) {
  const simulationMode = options.simulationMode ?? process.env.SIMULATION_MODE;
  if (simulationMode === 'false') throw new Error('Webhook acceptance fixtures are allowed only in simulation mode.');
  const secret = options.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || /replace|example/i.test(secret)) throw new Error('A non-placeholder RAZORPAY_WEBHOOK_SECRET is required.');

  const authMode = options.authMode ?? process.env.AUTH_MODE ?? 'disabled';
  const tokenAuth = authMode === 'token';
  const viewerHeaders = bearer(options.viewerToken ?? process.env.VIEWER_API_TOKEN, tokenAuth);
  const operatorHeaders = bearer(options.operatorToken ?? process.env.OPERATOR_API_TOKEN, tokenAuth);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? process.env.ACCEPTANCE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT || '3001'}/api/v1`).replace(/\/$/, '');
  const unique = randomUUID().replaceAll('-', '');
  const eventId = `acceptance-event-${unique}`;
  const payoutId = `pout_acceptance_${unique}`;
  const body = JSON.stringify({
    event_id: eventId,
    event: 'payout.processed',
    payload: { payout: { entity: {
      id: payoutId,
      status: 'processed',
      amount: 12_345,
      currency: 'INR',
      reference_id: `acceptance-${unique}`,
      status_details: { description: 'Acceptance fixture already processed' },
    } } },
  });
  const webhookHeaders = { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signWebhookBody(body, secret) };
  const webhookUrl = `${baseUrl}/webhooks/razorpay`;
  const first = await responseJson<WebhookResult>(fetchImpl, webhookUrl, { method: 'POST', headers: webhookHeaders, body });
  const second = await responseJson<WebhookResult>(fetchImpl, webhookUrl, { method: 'POST', headers: webhookHeaders, body });
  if (first.duplicate || !second.duplicate || first.incidentId !== second.incidentId) throw new Error('Webhook deduplication acceptance check failed.');

  const incident = await responseJson<IncidentDetail>(fetchImpl, `${baseUrl}/incidents/${first.incidentId}`, { headers: viewerHeaders });
  const batch = await responseJson<BatchResult>(fetchImpl, `${baseUrl}/batches`, {
    method: 'POST',
    headers: { ...operatorHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Signed webhook acceptance ${unique}`, incidentIds: [first.incidentId] }),
  });
  const jsonExport = await responseJson<BatchExport>(fetchImpl, `${baseUrl}/batches/${batch.id}/export.json`, { headers: viewerHeaders });
  const csvExport = await responseText(fetchImpl, `${baseUrl}/batches/${batch.id}/export.csv`, { headers: viewerHeaders });

  const persistedEventCount = incident.events?.length ?? 0;
  const webhookAuditCount = incident.auditEvents?.filter(event => event.eventType === 'WEBHOOK_RECEIVED').length ?? 0;
  const jsonIncidentTraceable = jsonExport.cohortSize === 1 && jsonExport.results[0]?.incidentId === first.incidentId;
  const csvLines = csvExport.trimEnd().split(/\r?\n/);
  const csvIncidentTraceable = csvLines.length === 2 && csvExport.includes(first.incidentId);
  if (persistedEventCount !== 1 || webhookAuditCount !== 1 || incident.status !== 'RECOVERED' || !jsonIncidentTraceable || !csvIncidentTraceable) {
    throw new Error('Webhook persistence or batch evidence acceptance check failed.');
  }

  return {
    eventId,
    payoutId,
    incidentId: first.incidentId,
    firstDeliveryDuplicate: first.duplicate,
    secondDeliveryDuplicate: second.duplicate,
    persistedEventCount,
    webhookAuditCount,
    incidentStatus: incident.status,
    batchId: batch.id,
    jsonIncidentTraceable,
    csvLineCount: csvLines.length,
    csvIncidentTraceable,
    csvSha256: createHash('sha256').update(csvExport).digest('hex'),
  };
}

if (require.main === module) {
  runWebhookAcceptance()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Webhook acceptance failed.'); process.exit(1); });
}
