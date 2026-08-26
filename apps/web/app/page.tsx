'use client';
import { useEffect, useMemo, useState } from 'react';

type Incident = { id: string; razorpayPayoutId: string; status: string; amountPaise: number; currentReason?: string; attempts: number; reviewTasks: unknown[]; policyDecisions?: { finalDecision: string }[]; updatedAt: string };
type Detail = Omit<Incident, 'policyDecisions'> & { auditEvents: { id: string; eventType: string; actorType: string; rationale: string; createdAt: string; decision?: string }[]; analyses: { modelRef: string; promptVersion: string; createdAt: string; outputJson: { category: string; confidence: number; evidenceSummary: string; recommendedAction: string } }[]; policyDecisions: { finalDecision: string; reasonsJson: string[] }[] };
type Metrics = { valueAtRiskPaise: number; recoveredValuePaise: number; recoveryRate: number; eligibleCount: number; eligibleValuePaise: number; recoveredEligibleValuePaise: number; eligibleRecoveryRate: number; pendingRecoveryValuePaise: number; manualReviewValuePaise: number; protectedValuePaise: number; manualInterventions: number; unsafeActionsPrevented: number; unresolvedIncidents: number; statusDistribution: Record<string, number> };
type Batch = { id: string; name: string; cohortSize: number; startedAt: string; metrics: Metrics };
type Policy = { version: string; maxAutoRetryAttempts: number; maxAutonomousAmountPaise: number; minimumRetryDelayMinutes: number };
type Operations = { status: 'ready' | 'degraded'; simulationMode: boolean; services: { database: boolean; redis: boolean }; queue: { waiting: number; active: number; delayed: number; completed: number; failed: number; paused: number }; ai: { mode: string; configured: boolean; provider: string; model: string; thinkingMode: string; promptVersion: string }; timestamp: string };
type IncidentPage = { total: number; page: number; pageSize: number; totalPages: number };
type View = 'incidents' | 'batches' | 'policy' | 'operations';

const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
const tone = (status: string) => status === 'RECOVERED' ? 'good' : ['STOPPED', 'ESCALATE', 'APPROVAL_REQUIRED', 'EXECUTION_UNKNOWN', 'PROCESSING'].includes(status) ? 'warn' : 'neutral';

export default function Dashboard() {
  const [view, setView] = useState<View>('incidents');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [operations, setOperations] = useState<Operations | null>(null);
  const [incidentPage, setIncidentPage] = useState<IncidentPage>({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apiFetch = (path: string, init: RequestInit = {}, token = authToken) => { const headers = new Headers(init.headers); if (token) headers.set('Authorization', `Bearer ${token}`); return fetch(`${api}${path}`, { ...init, headers }); };
  const load = async (token = authToken, requestedPage = incidentPage.page, filters = { search, statusFilter, reviewOnly }) => {
    setLoading(true);
    try {
      const incidentQuery = new URLSearchParams({ page: String(requestedPage), pageSize: String(incidentPage.pageSize) });
      if (filters.search.trim()) incidentQuery.set('search', filters.search.trim());
      if (filters.statusFilter) incidentQuery.set('status', filters.statusFilter);
      if (filters.reviewOnly) incidentQuery.set('reviewRequired', 'true');
      const [incidentResponse, batchResponse, policyResponse, operationsResponse] = await Promise.all([apiFetch(`/incidents?${incidentQuery}`, { cache: 'no-store' }, token), apiFetch('/batches', { cache: 'no-store' }, token), apiFetch('/policies', { cache: 'no-store' }, token), apiFetch('/operations', { cache: 'no-store' }, token)]);
      if ([incidentResponse, batchResponse, policyResponse, operationsResponse].some(response => response.status === 401 || response.status === 403)) { setError('AUTH_REQUIRED'); return; }
      if (!incidentResponse.ok || !batchResponse.ok || !policyResponse.ok || !operationsResponse.ok) throw new Error('API unavailable');
      const [incidentData, batchData, policyData, operationsData] = await Promise.all([incidentResponse.json(), batchResponse.json(), policyResponse.json(), operationsResponse.json()]);
      setIncidents(incidentData.items); setIncidentPage({ total: incidentData.total, page: incidentData.page, pageSize: incidentData.pageSize, totalPages: incidentData.totalPages }); setBatches(batchData); setPolicy(policyData); setOperations(operationsData);
      setSelectedBatch(current => batchData.find((batch: Batch) => batch.id === current?.id) ?? batchData[0] ?? null);
      setError('');
    } catch { setError('Start the API and seed the deterministic cohort with pnpm simulate.'); }
    finally { setLoading(false); }
  };
  const open = async (id: string) => { const response = await apiFetch(`/incidents/${id}`); if (response.ok) setDetail(await response.json()); };
  const review = async (approved: boolean) => { if (!detail) return; await apiFetch(`/incidents/${detail.id}/${approved ? 'approve' : 'reject'}`, { method: 'POST' }); await open(detail.id); await load(); };
  const createBatch = async () => { if (!incidents.length) return; const response = await apiFetch('/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Operator filtered page ${new Date().toLocaleString()}`, incidentIds: incidents.map(incident => incident.id) }) }); if (response.ok) { const batch = await response.json(); setNotice(`Created ${batch.name}`); setSelectedBatch(batch); await load(); } else setNotice('Your role cannot create a batch.'); };
  const savePolicy = async () => { if (!policy) return; const response = await apiFetch('/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) }); if (response.ok) { setPolicy(await response.json()); setNotice('Policy version activated.'); } else setNotice('Admin authorization is required to update policy.'); };
  const connect = async () => { sessionStorage.setItem('recoveryos-token', tokenInput); setAuthToken(tokenInput); await load(tokenInput); };
  const disconnect = async () => { sessionStorage.removeItem('recoveryos-token'); setAuthToken(''); setTokenInput(''); await load(''); };
  const downloadBatch = async (batch: Batch, format: 'csv' | 'json') => { const response = await apiFetch(`/batches/${batch.id}/export.${format}`); if (!response.ok) { setNotice('Authentication is required to download evidence.'); return; } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${batch.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`; anchor.click(); URL.revokeObjectURL(url); };
  useEffect(() => { const stored = sessionStorage.getItem('recoveryos-token') || ''; setAuthToken(stored); setTokenInput(stored); load(stored); }, []);

  const liveMetrics = useMemo<Metrics>(() => {
    const atRisk = incidents.reduce((sum, incident) => sum + incident.amountPaise, 0);
    const recoveredIncidents = incidents.filter(incident => incident.status === 'RECOVERED');
    const recovered = recoveredIncidents.reduce((sum, incident) => sum + incident.amountPaise, 0);
    const eligible = incidents.filter(incident => incident.policyDecisions?.[0]?.finalDecision === 'AUTO_RETRY');
    const eligibleValue = eligible.reduce((sum, incident) => sum + incident.amountPaise, 0);
    const recoveredEligible = eligible.filter(incident => incident.status === 'RECOVERED').reduce((sum, incident) => sum + incident.amountPaise, 0);
    const manual = incidents.filter(incident => ['ESCALATE', 'APPROVAL_REQUIRED'].includes(incident.status));
    const protectedIncidents = incidents.filter(incident => ['STOPPED', 'PROCESSING', 'EXECUTION_UNKNOWN'].includes(incident.status));
    const distribution = incidents.reduce<Record<string, number>>((counts, incident) => { counts[incident.status] = (counts[incident.status] || 0) + 1; return counts; }, {});
    return {
      valueAtRiskPaise: atRisk, recoveredValuePaise: recovered, recoveryRate: atRisk ? recovered / atRisk : 0,
      eligibleCount: eligible.length, eligibleValuePaise: eligibleValue, recoveredEligibleValuePaise: recoveredEligible,
      eligibleRecoveryRate: eligibleValue ? recoveredEligible / eligibleValue : 0,
      pendingRecoveryValuePaise: eligible.filter(incident => incident.status !== 'RECOVERED').reduce((sum, incident) => sum + incident.amountPaise, 0),
      manualReviewValuePaise: manual.reduce((sum, incident) => sum + incident.amountPaise, 0),
      protectedValuePaise: protectedIncidents.reduce((sum, incident) => sum + incident.amountPaise, 0),
      manualInterventions: manual.length, unsafeActionsPrevented: protectedIncidents.length,
      unresolvedIncidents: incidents.filter(incident => !['RECOVERED', 'STOPPED', 'NO_ACTION'].includes(incident.status)).length,
      statusDistribution: distribution,
    };
  }, [incidents]);
  const metrics = selectedBatch?.metrics ?? liveMetrics;

  return <main>
    <header><div><p className="eyebrow">RAZORPAY RECOVERYOS</p><h1>Recovery command center</h1><p className="subtle">AI advises. Policy authorizes. Every decision is auditable.</p></div><div className="simulation">● SIMULATION / TEST MODE</div></header>
    <nav className="nav"><button className={view === 'incidents' ? 'active' : ''} onClick={() => setView('incidents')}>Incidents</button><button className={view === 'batches' ? 'active' : ''} onClick={() => setView('batches')}>Batch evidence</button><button className={view === 'policy' ? 'active' : ''} onClick={() => setView('policy')}>Policy controls</button><button className={view === 'operations' ? 'active' : ''} onClick={() => setView('operations')}>Operations</button><span>{selectedBatch ? `Metrics: ${selectedBatch.name}` : 'Live incident metrics'}</span>{authToken && <button onClick={disconnect}>Sign out</button>}</nav>
    <section className="metrics"><Metric label="Value at risk" value={money(metrics.valueAtRiskPaise)} /><Metric label="Gross recovered" value={money(metrics.recoveredValuePaise)} accent="green" /><Metric label="Gross recovery" value={`${(metrics.recoveryRate * 100).toFixed(1)}%`} /><Metric label="Eligible recovery" value={`${(metrics.eligibleRecoveryRate * 100).toFixed(1)}%`} accent="green" /><Metric label="Eligible value" value={money(metrics.eligibleValuePaise)} /><Metric label="Pending recovery" value={money(metrics.pendingRecoveryValuePaise)} /><Metric label="Protected value" value={money(metrics.protectedValuePaise)} accent="orange" /><Metric label="Manual review value" value={money(metrics.manualReviewValuePaise)} /></section>
    {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>Dismiss</button></div>}
    {error === 'AUTH_REQUIRED' && <section className="panel auth-panel"><p className="eyebrow">AUTHENTICATION REQUIRED</p><h2>Connect to RecoveryOS</h2><p>Enter a viewer, operator, or administrator token. It is kept only in this browser tab.</p><div><input type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="Bearer token" /><button className="approve" onClick={connect}>Connect</button></div></section>}
    {error && error !== 'AUTH_REQUIRED' && <div className="empty panel">{error}</div>}
    {!error && view === 'incidents' && <section className="content"><div className="panel list"><div className="panel-head"><div><h2>Incident queue</h2><p>{loading ? 'Loading…' : `${incidentPage.total} payout incidents · page ${incidentPage.page} of ${incidentPage.totalPages}`}</p></div><button onClick={() => load()}>Refresh</button></div><div className="filters"><input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') load(authToken, 1); }} placeholder="Search payout ID or reason" aria-label="Search incidents" /><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{['RECOVERED', 'AUTO_RETRY', 'ESCALATE', 'APPROVAL_REQUIRED', 'PROCESSING', 'STOPPED', 'EXECUTION_UNKNOWN', 'FAILED'].map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select><label><input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} />Open reviews</label><button onClick={() => load(authToken, 1)}>Apply</button><button onClick={() => { const cleared = { search: '', statusFilter: '', reviewOnly: false }; setSearch(''); setStatusFilter(''); setReviewOnly(false); load(authToken, 1, cleared); }}>Clear</button></div><div className="rows">{incidents.map(incident => <button className="row" key={incident.id} onClick={() => open(incident.id)}><span><strong>{incident.razorpayPayoutId}</strong><small>{incident.currentReason || 'No reason supplied'}</small></span><span className={`badge ${tone(incident.status)}`}>{incident.status.replaceAll('_', ' ')}</span><strong>{money(incident.amountPaise)}</strong></button>)}{!loading && !incidents.length && <div className="empty">No incidents match these filters.</div>}</div><div className="pagination"><button disabled={incidentPage.page <= 1} onClick={() => load(authToken, incidentPage.page - 1)}>Previous</button><span>Showing {incidents.length} of {incidentPage.total}</span><button disabled={incidentPage.page >= incidentPage.totalPages} onClick={() => load(authToken, incidentPage.page + 1)}>Next</button></div></div><aside className="panel detail">{detail ? <IncidentDetail detail={detail} onReview={review} /> : <div className="empty"><h2>Select an incident</h2><p>Inspect AI evidence, policy decisions, actions, and the complete audit timeline.</p></div>}</aside></section>}
    {!error && view === 'batches' && <BatchWorkspace batches={batches} selected={selectedBatch} onSelect={setSelectedBatch} onCreate={createBatch} onDownload={downloadBatch} />}
    {!error && view === 'policy' && policy && <PolicyWorkspace policy={policy} onChange={setPolicy} onSave={savePolicy} />}
    {!error && view === 'operations' && <OperationsWorkspace operations={operations} onRefresh={() => load()} />}
  </main>;
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) { return <article className={`metric ${accent || ''}`}><span>{label}</span><strong>{value}</strong></article>; }
function BatchWorkspace({ batches, selected, onSelect, onCreate, onDownload }: { batches: Batch[]; selected: Batch | null; onSelect: (batch: Batch) => void; onCreate: () => void; onDownload: (batch: Batch, format: 'csv' | 'json') => void }) {
  return <section className="workspace"><div className="panel batch-list"><div className="panel-head"><div><h2>Evaluation batches</h2><p>Reproducible financial evidence</p></div><button onClick={onCreate}>Create from queue</button></div>{batches.length ? batches.map(batch => <button key={batch.id} className={`batch-card ${selected?.id === batch.id ? 'selected' : ''}`} onClick={() => onSelect(batch)}><span><strong>{batch.name}</strong><small>{new Date(batch.startedAt).toLocaleString()} · {batch.cohortSize} cases</small></span><strong>Eligible {(batch.metrics.eligibleRecoveryRate * 100).toFixed(1)}%</strong></button>) : <div className="empty">No batches yet. Create one from the current incident queue.</div>}</div><aside className="panel batch-detail">{selected ? <><div className="panel-head"><div><p className="eyebrow">BATCH EVIDENCE</p><h2>{selected.name}</h2></div><span className="badge neutral">{selected.cohortSize} CASES</span></div><div className="batch-stats expanded"><span>Gross recovered<strong>{money(selected.metrics.recoveredValuePaise)}</strong></span><span>Eligible recovered<strong>{money(selected.metrics.recoveredEligibleValuePaise)}</strong></span><span>Eligible recovery<strong>{(selected.metrics.eligibleRecoveryRate * 100).toFixed(1)}%</strong></span><span>Pending recovery<strong>{money(selected.metrics.pendingRecoveryValuePaise)}</strong></span><span>Protected value<strong>{money(selected.metrics.protectedValuePaise)}</strong></span><span>Manual review value<strong>{money(selected.metrics.manualReviewValuePaise)}</strong></span></div><div className="metric-note">Eligible recovery measures only policy-approved transient failures. Gross recovery includes payouts that arrived already processed.</div><div className="distribution"><p className="eyebrow">OUTCOME DISTRIBUTION</p>{Object.entries(selected.metrics.statusDistribution).map(([status, count]) => <div key={status}><span>{status.replaceAll('_', ' ')}</span><strong>{count}</strong></div>)}</div><div className="actions"><button className="approve" onClick={() => onDownload(selected, 'csv')}>Download CSV</button><button onClick={() => onDownload(selected, 'json')}>Download JSON</button></div></> : <div className="empty">Select a batch to inspect its evidence.</div>}</aside></section>;
}
function PolicyWorkspace({ policy, onChange, onSave }: { policy: Policy; onChange: (policy: Policy) => void; onSave: () => void }) { const numeric = (key: keyof Policy, value: string) => onChange({ ...policy, [key]: Number(value) }); return <section className="panel policy-workspace"><div className="panel-head"><div><h2>Deterministic recovery policy</h2><p>Activating a version changes authorization rules, never AI behavior.</p></div><span className="badge neutral">FAIL CLOSED</span></div><div className="policy-form"><label>Policy version<input value={policy.version} onChange={event => onChange({ ...policy, version: event.target.value })} /></label><label>Maximum automatic retries<input type="number" min="0" max="10" value={policy.maxAutoRetryAttempts} onChange={event => numeric('maxAutoRetryAttempts', event.target.value)} /></label><label>Autonomous amount limit (paise)<input type="number" min="1" value={policy.maxAutonomousAmountPaise} onChange={event => numeric('maxAutonomousAmountPaise', event.target.value)} /></label><label>Minimum retry delay (minutes)<input type="number" min="0" value={policy.minimumRetryDelayMinutes} onChange={event => numeric('minimumRetryDelayMinutes', event.target.value)} /></label><div className="policy-warning"><strong>Activation is immediate.</strong><p>Create a new version identifier for every material rule change. Existing audit events retain the policy version that authorized them.</p></div><button className="approve" onClick={onSave}>Activate policy version</button></div></section>; }
function OperationsWorkspace({ operations, onRefresh }: { operations: Operations | null; onRefresh: () => void }) {
  if (!operations) return <section className="panel operations"><div className="empty">Operational status is loading.</div></section>;
  return <section className="panel operations">
    <div className="panel-head">
      <div><h2>Operational readiness</h2><p>Credential-free service, worker queue, and advisory-provider status.</p></div>
      <div className="actions compact"><span className={`badge ${operations.status === 'ready' ? 'good' : 'warn'}`}>{operations.status.toUpperCase()}</span><button onClick={onRefresh}>Refresh</button></div>
    </div>
    <div className="service-grid">
      <ServiceState label="Neon PostgreSQL" ready={operations.services.database} />
      <ServiceState label="Upstash / BullMQ" ready={operations.services.redis} />
      <ServiceState label="Simulation safety" ready={operations.simulationMode} readyText="ENABLED" failedText="DISABLED" />
      <ServiceState label="AI configuration" ready={operations.ai.configured} readyText="HOSTED MODEL" failedText="SIMULATOR" neutral={!operations.ai.configured} />
    </div>
    <div className="operations-grid">
      <section><p className="eyebrow">QUEUE COUNTS</p><div className="queue-grid">{Object.entries(operations.queue).map(([state, count]) => <span key={state}>{state.replaceAll('_', ' ')}<strong>{count}</strong></span>)}</div></section>
      <section className="provider-card">
        <p className="eyebrow">ADVISORY PROVIDER</p><strong>{operations.ai.mode.replaceAll('-', ' ').toUpperCase()}</strong>
        <dl>
          <div><dt>Provider</dt><dd>{operations.ai.provider}</dd></div>
          <div><dt>Model</dt><dd>{operations.ai.model}</dd></div>
          <div><dt>Thinking</dt><dd>{operations.ai.thinkingMode}</dd></div>
          <div><dt>Prompt</dt><dd>{operations.ai.promptVersion}</dd></div>
        </dl>
        <p>No model can authorize a financial action; deterministic policy remains the authorization boundary.</p>
      </section>
    </div>
    <div className="checked-at">Last checked {new Date(operations.timestamp).toLocaleString()}</div>
  </section>;
}
function ServiceState({ label, ready, readyText = 'READY', failedText = 'DEGRADED', neutral = false }: { label: string; ready: boolean; readyText?: string; failedText?: string; neutral?: boolean }) { return <article><span>{label}</span><strong className={ready ? 'state-good' : neutral ? 'state-neutral' : 'state-warn'}>● {ready ? readyText : failedText}</strong></article>; }
function IncidentDetail({ detail, onReview }: { detail: Detail; onReview: (approved: boolean) => void }) { const analysisRecord = detail.analyses.at(-1); const analysis = analysisRecord?.outputJson; const decision = detail.policyDecisions.at(-1); const deterministic = analysisRecord?.modelRef === 'deterministic-simulator'; return <><div className="panel-head"><div><p className="eyebrow">INCIDENT DETAILS</p><h2>{detail.razorpayPayoutId}</h2></div><span className={`badge ${tone(detail.status)}`}>{detail.status.replaceAll('_', ' ')}</span></div><div className="facts"><span>Amount <strong>{money(detail.amountPaise)}</strong></span><span>Attempts <strong>{detail.attempts}</strong></span><span>Reason <strong>{detail.currentReason || '—'}</strong></span></div>{analysis && <section className="evidence"><div className="evidence-head"><p className="eyebrow">{deterministic ? 'DETERMINISTIC ADVISORY' : 'AI ADVISORY'}</p><span className="badge neutral">{analysisRecord?.modelRef}</span></div><strong>{analysis.category.replaceAll('_', ' ')}</strong><p>{analysis.evidenceSummary}</p><small>Confidence {Math.round(analysis.confidence * 100)}% · Proposed {analysis.recommendedAction} · Prompt {analysisRecord?.promptVersion}</small></section>}{decision && <section className="evidence policy"><p className="eyebrow">POLICY DECISION</p><strong>{decision.finalDecision.replaceAll('_', ' ')}</strong><p>{decision.reasonsJson.join(' ')}</p></section>}{['APPROVAL_REQUIRED', 'ESCALATE'].includes(detail.status) && <div className="actions"><button className="approve" onClick={() => onReview(true)}>Approve retry</button><button onClick={() => onReview(false)}>Reject</button></div>}<section className="timeline"><p className="eyebrow">AUDIT TIMELINE</p>{detail.auditEvents.map(event => <div className="event" key={event.id}><i></i><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><p>{event.rationale}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></div>)}</section></>; }
