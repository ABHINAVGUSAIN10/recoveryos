'use client';
import { useEffect, useMemo, useState } from 'react';

type RecoveryRole = 'VIEWER' | 'OPERATOR' | 'ADMIN';
type Session = { id: string; role: RecoveryRole };
type ReviewTask = { id: string; kind: 'RETRY_APPROVAL' | 'REMEDIATION'; status: string; severity: string; remediationJson?: Record<string, unknown> };
type Incident = { id: string; razorpayPayoutId: string; status: string; amountPaise: number; currentReason?: string; attempts: number; reviewTasks: ReviewTask[]; policyDecisions?: { finalDecision: string }[]; updatedAt: string };
type Detail = Omit<Incident, 'policyDecisions'> & { auditEvents: { id: string; eventType: string; actorType: string; rationale: string; createdAt: string; decision?: string }[]; analyses: { modelRef: string; promptVersion: string; createdAt: string; outputJson: { category: string; confidence: number; evidenceSummary: string; recommendedAction: string } }[]; policyDecisions: { finalDecision: string; reasonsJson: string[] }[]; executions?: { id: string; actionType: string; outcome: string; scheduledFor: string; createdAt: string; responseJson?: { id?: string; status?: string } }[] };
type Metrics = { valueAtRiskPaise: number; recoveredValuePaise: number; recoveryRate: number; eligibleCount: number; eligibleValuePaise: number; recoveredEligibleValuePaise: number; eligibleRecoveryRate: number; pendingRecoveryValuePaise: number; manualReviewValuePaise: number; protectedValuePaise: number; manualInterventions: number; unsafeActionsPrevented: number; unresolvedIncidents: number; statusDistribution: Record<string, number> };
type Batch = { id: string; name: string; cohortSize: number; startedAt: string; completedAt?: string; immutable?: boolean; policyVersion?: string; modelRef?: string; promptVersion?: string; cohortFingerprint?: string; baseline?: { noAction?: { recoveredValuePaise: number }; rulesOnly?: { eligibleValuePaise: number; observedRecoveredValuePaise: number } }; metrics: Metrics };
type Policy = { version: string; maxAutoRetryAttempts: number; maxAutonomousAmountPaise: number; minimumRetryDelayMinutes: number };
type DemoScenario = { key: string; title: string; description: string; amountPaise: number; expectedAiAction: string; expectedPolicyDecision: string; humanRequired: boolean };
type Operations = { status: 'ready' | 'degraded'; simulationMode: boolean; services: { database: boolean; redis: boolean }; queue: { waiting: number; active: number; delayed: number; completed: number; failed: number; paused: number }; ai: { mode: string; configured: boolean; provider: string; model: string; thinkingMode: string; promptVersion: string }; demo: { enabled: boolean; ready: boolean; retryDelaySeconds: number; scenarios: DemoScenario[] }; razorpayTestDemo: { enabled: boolean; ready: boolean; testMode: boolean; simulationSafe: boolean; fundAccountConfigured: boolean; fundAccountDisplay?: string; policyAllowsAmount: boolean; amountPaise: number; confirmation: string; cooldownSeconds: number }; timestamp: string };
type IncidentPage = { total: number; page: number; pageSize: number; totalPages: number };
type DemoRun = { runId: string; scenario: string; retryDelaySeconds: number; duplicateReplayVerified: Record<string, boolean>; batch: Batch; incidents: Detail[] };
type RazorpayTestDemoRun = { runId: string; amountPaise: number; retryDelaySeconds: number; duplicateReplayVerified: boolean; batch: Batch; incident: Detail };
type RevenueProposal = { category: string; confidence: number; diagnosis: string; evidence: { eventId: string; fact: string }[]; recommendedAction: string; proposedDelayMinutes: number | null; playbook: { order: number; action: string; delayMinutes: number; requiresHuman: boolean; rationale: string }[]; riskFlags: string[] };
type RevenueIncident = { id: string; sourcePaymentId: string; status: string; amountPaise: number; currency: string; paymentMethod: string; failureCode: string; failureDescription: string; consentToContact: boolean; attemptCount: number; detectedAt?: string; updatedAt?: string; recoveredAt?: string; analyses: { modelRef: string; promptVersion: string; timelineDigest: string; confidence: number; outputJson: RevenueProposal }[]; policyDecisions: { policyVersion: string; proposedAction: string; finalAction: string; authorized: boolean; reasonsJson: string[] }[]; events?: { id: string; externalEventId: string; eventType: string; occurredAt: string; dataJson: { summary?: string } }[]; actions?: { id: string; actionType: string; outcome: string; attributedRevenuePaise: number }[]; auditEvents?: { id: string; eventType: string; rationale: string; createdAt: string }[] };
type RevenueMetrics = { valueAtRiskPaise: number; recoveredValuePaise: number; recoveryRate: number; recoveredIncidentCount: number; manualReviewRequired: number; interventions: number; unsafeActionsPrevented: number; evidenceCompleteness: number; duplicateReplayCount?: number; duplicateReplayTotal?: number; statusDistribution: Record<string, number> };
type RevenueBaseline = { controlledExperiment: boolean; disclaimer: string; noAction: { recoveredValuePaise: number; recoveryRate: number }; rulesOnly: { definition: string; recoveredValuePaise: number; recoveryRate: number }; aiPolicy: { recoveredValuePaise: number; recoveryRate: number; incrementalVsRulesPaise: number } };
type RevenueExperiment = { id: string; name: string; cohortSize: number; totalValueAtRiskPaise: number; policyVersion: string; modelRef: string; promptVersion: string; cohortFingerprint: string; startedAt: string; completedAt: string; immutable: true; baseline: RevenueBaseline; metrics: RevenueMetrics };
type RevenueConfiguration = { enabled: boolean; simulationSafe: boolean; aiConfigured: boolean; ready: boolean; policy: { version: string; maxAutomaticAttempts: number; maxAutonomousAmountPaise: number; minimumRetryDelayMinutes: number; minimumConfidence: number }; scenarios: { key: string; title: string; amountPaise: number; expectedCategory: string; expectedPolicyAction: string }[] };
type RevenueDemoRun = { runId: string; retryDelaySeconds: number; duplicateReplayVerified: Record<string, boolean>; experiment: RevenueExperiment; incidents: RevenueIncident[] };
type View = 'revenue' | 'incidents' | 'batches' | 'demo' | 'policy' | 'operations';

const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
const tone = (status: string) => status === 'RECOVERED' ? 'good' : ['STOPPED', 'ESCALATE', 'APPROVAL_REQUIRED', 'EXECUTION_UNKNOWN', 'PROCESSING'].includes(status) ? 'warn' : 'neutral';
const roleRank: Record<RecoveryRole, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };
const can = (session: Session | null, role: RecoveryRole) => Boolean(session && roleRank[session.role] >= roleRank[role]);
const age = (value?: string) => { if (!value) return '—'; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`; };
const nextAction = (status: string) => status === 'APPROVAL_REQUIRED' ? 'Human decision' : ['ESCALATE', 'ESCALATED'].includes(status) ? 'Remediate' : ['AUTO_RETRY', 'AUTO_ACTION'].includes(status) ? 'Automatic recovery' : ['PROCESSING', 'EXECUTION_UNKNOWN'].includes(status) ? 'Reconcile' : status === 'RECOVERED' ? 'Complete' : 'No action';

export default function Dashboard() {
  const [view, setView] = useState<View>('revenue');
  const [session, setSession] = useState<Session | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [operations, setOperations] = useState<Operations | null>(null);
  const [demoRun, setDemoRun] = useState<DemoRun | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState('');
  const [razorpayTestRun, setRazorpayTestRun] = useState<RazorpayTestDemoRun | null>(null);
  const [razorpayTestBusy, setRazorpayTestBusy] = useState(false);
  const [razorpayTestError, setRazorpayTestError] = useState('');
  const [providerConfirmationOpen, setProviderConfirmationOpen] = useState(false);
  const [revenueIncidents, setRevenueIncidents] = useState<RevenueIncident[]>([]);
  const [revenueDetail, setRevenueDetail] = useState<RevenueIncident | null>(null);
  const [revenueExperiments, setRevenueExperiments] = useState<RevenueExperiment[]>([]);
  const [selectedRevenueExperiment, setSelectedRevenueExperiment] = useState<RevenueExperiment | null>(null);
  const [revenueConfiguration, setRevenueConfiguration] = useState<RevenueConfiguration | null>(null);
  const [revenueRun, setRevenueRun] = useState<RevenueDemoRun | null>(null);
  const [revenueBusy, setRevenueBusy] = useState(false);
  const [revenueError, setRevenueError] = useState('');
  const [incidentPage, setIncidentPage] = useState<IncidentPage>({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [payoutSort, setPayoutSort] = useState('newest');
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
      const [sessionResponse, incidentResponse, batchResponse, policyResponse, operationsResponse, revenueResponse, experimentResponse, revenueOperationsResponse] = await Promise.all([apiFetch('/session', { cache: 'no-store' }, token), apiFetch(`/incidents?${incidentQuery}`, { cache: 'no-store' }, token), apiFetch('/batches', { cache: 'no-store' }, token), apiFetch('/policies', { cache: 'no-store' }, token), apiFetch('/operations', { cache: 'no-store' }, token), apiFetch('/revenue/incidents?page=1&pageSize=100', { cache: 'no-store' }, token), apiFetch('/revenue/experiments', { cache: 'no-store' }, token), apiFetch('/revenue/operations', { cache: 'no-store' }, token)]);
      if ([sessionResponse, incidentResponse, batchResponse, policyResponse, operationsResponse, revenueResponse, experimentResponse, revenueOperationsResponse].some(response => response.status === 401)) { setError('AUTH_REQUIRED'); setSession(null); return; }
      if (!sessionResponse.ok || !incidentResponse.ok || !batchResponse.ok || !policyResponse.ok || !operationsResponse.ok || !revenueResponse.ok || !experimentResponse.ok || !revenueOperationsResponse.ok) throw new Error('API unavailable');
      const [sessionData, incidentData, batchData, policyData, operationsData, revenueData, experimentData, revenueOperationsData] = await Promise.all([sessionResponse.json(), incidentResponse.json(), batchResponse.json(), policyResponse.json(), operationsResponse.json(), revenueResponse.json(), experimentResponse.json(), revenueOperationsResponse.json()]);
      setSession(sessionData);
      setIncidents(incidentData.items); setIncidentPage({ total: incidentData.total, page: incidentData.page, pageSize: incidentData.pageSize, totalPages: incidentData.totalPages }); setBatches(batchData); setPolicy(policyData); setOperations(operationsData);
      setRevenueIncidents(revenueData.items); setRevenueExperiments(experimentData); setRevenueConfiguration(revenueOperationsData);
      setSelectedRevenueExperiment(current => experimentData.find((experiment: RevenueExperiment) => experiment.id === current?.id) ?? experimentData[0] ?? null);
      setSelectedBatch(current => batchData.find((batch: Batch) => batch.id === current?.id) ?? batchData[0] ?? null);
      setError('');
    } catch { setError('RecoveryOS could not reach the deployed API. Refresh the page and try again.'); }
    finally { setLoading(false); }
  };
  const open = async (id: string) => { const response = await apiFetch(`/incidents/${id}`); if (response.ok) setDetail(await response.json()); };
  const review = async (approved: boolean) => { if (!detail || !can(session, 'OPERATOR')) return; const response = await apiFetch(`/incidents/${detail.id}/${approved ? 'approve' : 'reject'}`, { method: 'POST' }); if (!response.ok) { setNotice('Operator authorization is required for this decision.'); return; } await open(detail.id); await load(); };
  const remediate = async (beneficiaryRef: string, note: string) => { if (!detail || !can(session, 'OPERATOR')) return; const response = await apiFetch(`/incidents/${detail.id}/remediate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beneficiaryRef, note }) }); const body = await response.json(); if (!response.ok) { setNotice(Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Remediation failed'); return; } setDetail(body); setNotice('Remediation recorded. A separate actor must approve the new retry task.'); await load(); };
  const openRevenue = async (id: string) => { const response = await apiFetch(`/revenue/incidents/${id}`); if (response.ok) setRevenueDetail(await response.json()); };
  const decideRevenue = async (approved: boolean) => { if (!revenueDetail || !can(session, 'OPERATOR')) return; const response = await apiFetch(`/revenue/incidents/${revenueDetail.id}/${approved ? 'approve' : 'reject'}`, { method: 'POST' }); const body = await response.json(); if (!response.ok) { setNotice(Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Revenue review failed'); return; } setRevenueDetail(body); await load(); };
  const runRevenueDemo = async () => { if (!can(session, 'OPERATOR')) return; const confirmed = window.confirm('Run a new eight-case controlled experiment? This creates synthetic incidents, uses hosted-model quota, and preserves the previous snapshot as immutable evidence. No live payment will be collected.'); if (!confirmed) return; setRevenueBusy(true); setRevenueError(''); try { const response = await apiFetch('/revenue/demo-runs', { method: 'POST' }); const body = await response.json(); if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Inbound revenue demonstration failed'); setRevenueRun(body); setSelectedRevenueExperiment(body.experiment); setRevenueIncidents(body.incidents); setRevenueDetail(body.incidents[0] ?? null); setNotice(`Completed immutable experiment ${body.experiment.name}`); await load(); } catch (error) { setRevenueError(error instanceof Error ? error.message : 'Inbound revenue demonstration failed'); } finally { setRevenueBusy(false); } };
  const createBatch = async () => { if (!incidents.length || !can(session, 'OPERATOR')) return; const response = await apiFetch('/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Operator filtered page ${new Date().toLocaleString()}`, incidentIds: incidents.map(incident => incident.id) }) }); if (response.ok) { const batch = await response.json(); setNotice(`Created ${batch.name}`); setSelectedBatch(batch); await load(); } else setNotice('Operator authorization is required to create a batch.'); };
  const savePolicy = async () => { if (!policy || !can(session, 'ADMIN')) return; const response = await apiFetch('/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) }); if (response.ok) { setPolicy(await response.json()); setNotice('Policy version activated.'); } else setNotice('Administrator authorization is required to update policy.'); };
  const connect = async () => { const token = tokenInput.trim(); if (!token) { setError('AUTH_REQUIRED'); return; } sessionStorage.setItem('recoveryos-token', token); setAuthToken(token); await load(token); };
  const disconnect = () => { sessionStorage.removeItem('recoveryos-token'); setAuthToken(''); setTokenInput(''); setSession(null); setError('AUTH_REQUIRED'); setLoading(false); };
  const downloadBatch = async (batch: Batch, format: 'csv' | 'json') => { const response = await apiFetch(`/batches/${batch.id}/export.${format}`); if (!response.ok) { setNotice('Authentication is required to download evidence.'); return; } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${batch.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`; anchor.click(); URL.revokeObjectURL(url); };
  const runDemo = async (scenario: string) => {
    if (!can(session, 'OPERATOR')) return;
    setDemoBusy(true); setDemoError('');
    try {
      const response = await apiFetch('/demo-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario }) });
      const body = await response.json();
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Live demonstration failed');
      setDemoRun(body); setSelectedBatch(body.batch); setNotice(`Started ${body.batch.name}`);
      await load();
    } catch (error) { setDemoError(error instanceof Error ? error.message : 'Live demonstration failed'); }
    finally { setDemoBusy(false); }
  };
  const runRazorpayTestDemo = async () => {
    const configuration = operations?.razorpayTestDemo;
    if (!configuration?.ready || !can(session, 'ADMIN')) return;
    setProviderConfirmationOpen(false);
    setRazorpayTestBusy(true); setRazorpayTestError('');
    try {
      const response = await apiFetch('/razorpayx-test-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: configuration.confirmation }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(' ') : body.message || 'RazorpayX Test Mode demonstration failed');
      setRazorpayTestRun(body); setSelectedBatch(body.batch);
      setNotice(`Policy-authorized ${money(body.amountPaise)} RazorpayX Test Mode retry scheduled.`);
      await load();
    } catch (error) { setRazorpayTestError(error instanceof Error ? error.message : 'RazorpayX Test Mode demonstration failed'); }
    finally { setRazorpayTestBusy(false); }
  };
  const openDemoIncident = async (incident: Detail) => {
    const runSearch = incident.razorpayPayoutId;
    setSearch(runSearch); setStatusFilter(''); setReviewOnly(false); setView('incidents'); setDetail(incident);
    await load(authToken, 1, { search: runSearch, statusFilter: '', reviewOnly: false });
  };
  useEffect(() => {
    const stored = sessionStorage.getItem('recoveryos-token') || '';
    setAuthToken(stored); setTokenInput(stored);
    if (!stored) { setError('AUTH_REQUIRED'); setLoading(false); return; }
    load(stored);
  }, []);
  useEffect(() => {
    if (view !== 'demo' || !demoRun || !demoRun.incidents.some(incident => ['AUTO_RETRY', 'EXECUTING'].includes(incident.status))) return;
    const timer = window.setInterval(async () => {
      try {
        const refreshed = await Promise.all(demoRun.incidents.map(async incident => { const response = await apiFetch(`/incidents/${incident.id}`); return response.ok ? response.json() : incident; }));
        const batchResponse = await apiFetch(`/batches/${demoRun.batch.id}`);
        const batch = batchResponse.ok ? await batchResponse.json() : demoRun.batch;
        setDemoRun(current => current?.runId === demoRun.runId ? { ...current, incidents: refreshed, batch } : current);
        setSelectedBatch(current => current?.id === batch.id ? batch : current);
      } catch {}
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [view, demoRun?.runId, demoRun?.incidents.map(incident => incident.status).join('|')]);
  useEffect(() => {
    if (view !== 'demo' || !razorpayTestRun || ['RECOVERED', 'FAILED', 'STOPPED', 'REVERSED'].includes(razorpayTestRun.incident.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const [incidentResponse, batchResponse] = await Promise.all([
          apiFetch(`/incidents/${razorpayTestRun.incident.id}`),
          apiFetch(`/batches/${razorpayTestRun.batch.id}`),
        ]);
        const incident = incidentResponse.ok ? await incidentResponse.json() : razorpayTestRun.incident;
        const batch = batchResponse.ok ? await batchResponse.json() : razorpayTestRun.batch;
        setRazorpayTestRun(current => current?.runId === razorpayTestRun.runId ? { ...current, incident, batch } : current);
        setSelectedBatch(current => current?.id === batch.id ? batch : current);
      } catch {}
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [view, razorpayTestRun?.runId, razorpayTestRun?.incident.status]);

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
  const sortedIncidents = useMemo(() => [...incidents].sort((left, right) => payoutSort === 'amount' ? right.amountPaise - left.amountPaise : payoutSort === 'status' ? left.status.localeCompare(right.status) : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()), [incidents, payoutSort]);

  return <><a className="skip-link" href="#main-content">Skip to main content</a><main id="main-content">
    <header><div><p className="eyebrow">RECOVERYOS · AI REVENUE RECOVERY</p><h1>Revenue recovery command center</h1><p className="subtle">Prioritize money at risk, review exceptions, and trace every automated decision.</p></div><div className="header-meta"><div className="simulation">● CONTROLLED SIMULATION / TEST MODE</div>{session && <div className="session-chip"><span>Signed in as</span><strong>{session.role.toLowerCase()}</strong></div>}</div></header>
    {error === 'AUTH_REQUIRED' && <section className="panel auth-panel" aria-labelledby="auth-title"><p className="eyebrow">INTERNAL DEMO ACCESS</p><h2 id="auth-title">Connect to RecoveryOS</h2><p>Use the viewer, operator, or administrator token supplied by the project owner. It is kept only in this browser tab.</p><label htmlFor="access-token">Access token</label><div><input id="access-token" type="password" autoComplete="off" value={tokenInput} onChange={event => setTokenInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') connect(); }} placeholder="Paste access token" /><button className="approve" onClick={connect}>Connect securely</button></div><small>This token screen is for the controlled demonstration. Production access should use organizational single sign-on.</small></section>}
    {error && error !== 'AUTH_REQUIRED' && <div className="empty panel" role="alert">{error}</div>}
    {!error && <>
    <nav className="nav" aria-label="Primary navigation"><button aria-current={view === 'revenue' ? 'page' : undefined} className={view === 'revenue' ? 'active' : ''} onClick={() => setView('revenue')}>Overview</button><button aria-current={view === 'incidents' ? 'page' : undefined} className={view === 'incidents' ? 'active' : ''} onClick={() => setView('incidents')}>Payout queue</button><button aria-current={view === 'batches' ? 'page' : undefined} className={view === 'batches' ? 'active' : ''} onClick={() => setView('batches')}>Evidence</button><button aria-current={view === 'demo' ? 'page' : undefined} className={view === 'demo' ? 'active' : ''} onClick={() => setView('demo')}>Guided demo</button><button aria-current={view === 'policy' ? 'page' : undefined} className={view === 'policy' ? 'active' : ''} onClick={() => setView('policy')}>Policy</button><button aria-current={view === 'operations' ? 'page' : undefined} className={view === 'operations' ? 'active' : ''} onClick={() => setView('operations')}>Operations</button><span>{view === 'revenue' ? 'Inbound revenue recovered' : selectedBatch ? `Evidence: ${selectedBatch.name}` : 'Live payout metrics'}</span>{authToken && <button onClick={disconnect}>Sign out</button>}</nav>
    {view !== 'revenue' && <><section className="metrics primary-metrics" aria-label="Payout recovery summary"><Metric label="Value at risk" value={money(metrics.valueAtRiskPaise)} /><Metric label="Recovered" value={money(metrics.recoveredValuePaise)} accent="green" /><Metric label="Eligible recovery" value={`${(metrics.eligibleRecoveryRate * 100).toFixed(1)}%`} accent="green" /><Metric label="Needs attention" value={String(metrics.unresolvedIncidents)} accent="orange" /></section><details className="secondary-metrics"><summary>View additional payout metrics</summary><section className="metrics"><Metric label="Gross recovery" value={`${(metrics.recoveryRate * 100).toFixed(1)}%`} /><Metric label="Eligible value" value={money(metrics.eligibleValuePaise)} /><Metric label="Pending recovery" value={money(metrics.pendingRecoveryValuePaise)} /><Metric label="Protected value" value={money(metrics.protectedValuePaise)} accent="orange" /></section></details></>}
    <div className="announcer" aria-live="polite">{loading ? 'Updating dashboard data.' : ''}</div>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')}>Dismiss</button></div>}
    {view === 'revenue' && <RevenueWorkspace configuration={revenueConfiguration} incidents={revenueIncidents} detail={revenueDetail} experiments={revenueExperiments} selectedExperiment={selectedRevenueExperiment} run={revenueRun} busy={revenueBusy} error={revenueError} session={session} onRun={runRevenueDemo} onOpen={openRevenue} onSelectExperiment={setSelectedRevenueExperiment} onReview={decideRevenue} />}
    {!error && view === 'incidents' && <section className="content"><div className="panel list"><div className="panel-head"><div><p className="eyebrow">OPERATOR QUEUE</p><h2>Payout incidents</h2><p>{loading ? 'Updating cases…' : `${incidentPage.total} cases · page ${incidentPage.page} of ${incidentPage.totalPages}`}</p></div><button onClick={() => load()}>Refresh</button></div><div className="filters"><input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') load(authToken, 1); }} placeholder="Search payout ID or reason" aria-label="Search incidents" /><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{['RECOVERED', 'AUTO_RETRY', 'ESCALATE', 'APPROVAL_REQUIRED', 'PROCESSING', 'STOPPED', 'EXECUTION_UNKNOWN', 'FAILED'].map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select><select value={payoutSort} onChange={event => setPayoutSort(event.target.value)} aria-label="Sort incidents"><option value="newest">Newest activity</option><option value="amount">Highest amount</option><option value="status">Status</option></select><label><input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} />Needs human review</label><button className="approve" onClick={() => load(authToken, 1)}>Apply</button><button onClick={() => { const cleared = { search: '', statusFilter: '', reviewOnly: false }; setSearch(''); setStatusFilter(''); setReviewOnly(false); load(authToken, 1, cleared); }}>Clear</button></div><div className="case-header" aria-hidden="true"><span>Payout</span><span>Status</span><span>Next action</span><span>Age</span><span>Amount</span></div><div className="rows">{sortedIncidents.map(incident => <button className={`row ${detail?.id === incident.id ? 'selected' : ''}`} aria-pressed={detail?.id === incident.id} key={incident.id} onClick={() => open(incident.id)}><span><strong>{incident.razorpayPayoutId}</strong><small>{incident.currentReason || 'No provider reason supplied'}</small><em className="source-label">{incident.razorpayPayoutId.includes('demo') ? 'SYNTHETIC' : 'PROVIDER EVENT'}</em></span><span className={`badge ${tone(incident.status)}`}>{incident.status.replaceAll('_', ' ')}</span><span className="row-action">{nextAction(incident.status)}</span><span className="row-age">{age(incident.updatedAt)}</span><strong>{money(incident.amountPaise)}</strong></button>)}{!loading && !incidents.length && <div className="empty">No incidents match these filters.</div>}</div><div className="pagination"><button disabled={incidentPage.page <= 1} onClick={() => load(authToken, incidentPage.page - 1)}>Previous</button><span>Showing {incidents.length} of {incidentPage.total}</span><button disabled={incidentPage.page >= incidentPage.totalPages} onClick={() => load(authToken, incidentPage.page + 1)}>Next</button></div></div><aside className="panel detail">{detail ? <IncidentDetail detail={detail} canOperate={can(session, 'OPERATOR')} onReview={review} onRemediate={remediate} /> : <div className="empty"><h2>Select a payout</h2><p>Inspect its recommendation, policy decision, execution and audit trail.</p></div>}</aside></section>}
    {!error && view === 'batches' && <BatchWorkspace batches={batches} selected={selectedBatch} canCreate={can(session, 'OPERATOR')} onSelect={setSelectedBatch} onCreate={createBatch} onDownload={downloadBatch} />}
    {!error && view === 'demo' && <DemoWorkspace operations={operations} run={demoRun} providerRun={razorpayTestRun} busy={demoBusy} providerBusy={razorpayTestBusy} error={demoError} providerError={razorpayTestError} canOperate={can(session, 'OPERATOR')} canAdmin={can(session, 'ADMIN')} onRun={runDemo} onRunProvider={() => setProviderConfirmationOpen(true)} onOpenIncident={openDemoIncident} onOpenBatch={batch => { setSelectedBatch(batch); setView('batches'); }} />}
    {!error && view === 'policy' && policy && <PolicyWorkspace policy={policy} canAdmin={can(session, 'ADMIN')} onChange={setPolicy} onSave={savePolicy} />}
    {!error && view === 'operations' && <OperationsWorkspace operations={operations} onRefresh={() => load()} />}
    </>}
  </main>{providerConfirmationOpen && operations?.razorpayTestDemo && <ProviderConfirmationDialog configuration={operations.razorpayTestDemo} onCancel={() => setProviderConfirmationOpen(false)} onConfirm={runRazorpayTestDemo} />}</>;
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) { return <article className={`metric ${accent || ''}`}><span>{label}</span><strong>{value}</strong></article>; }
function BaselineBars({ baseline }: { baseline: RevenueBaseline }) {
  const values = [baseline.noAction.recoveredValuePaise, baseline.rulesOnly.recoveredValuePaise, baseline.aiPolicy.recoveredValuePaise];
  const maximum = Math.max(...values, 1);
  const rows = [['No intervention', values[0]], ['Rules only', values[1]], ['AI + policy', values[2]]] as const;
  return <div className="bar-chart" aria-label="Recovered value comparison">{rows.map(([name, value], index) => <div className={index === 2 ? 'winner' : ''} key={name}><span>{name}</span><span className="bar-track"><i style={{ width: `${Math.max(value ? 4 : 0, value / maximum * 100)}%` }} /></span><strong>{money(value)}</strong></div>)}</div>;
}
function RevenueWorkspace({ configuration, incidents, detail, experiments, selectedExperiment, run, busy, error, session, onRun, onOpen, onSelectExperiment, onReview }: { configuration: RevenueConfiguration | null; incidents: RevenueIncident[]; detail: RevenueIncident | null; experiments: RevenueExperiment[]; selectedExperiment: RevenueExperiment | null; run: RevenueDemoRun | null; busy: boolean; error: string; session: Session | null; onRun: () => void; onOpen: (id: string) => void; onSelectExperiment: (experiment: RevenueExperiment) => void; onReview: (approved: boolean) => void }) {
  const [caseSearch, setCaseSearch] = useState('');
  const [caseStatus, setCaseStatus] = useState('');
  const [caseSort, setCaseSort] = useState('newest');
  const [casePage, setCasePage] = useState(1);
  const metrics = selectedExperiment?.metrics;
  const baseline = selectedExperiment?.baseline;
  const duplicateCount = metrics?.duplicateReplayCount ?? (run && run.experiment.id === selectedExperiment?.id ? Object.values(run.duplicateReplayVerified).filter(Boolean).length : undefined);
  const duplicateTotal = metrics?.duplicateReplayTotal ?? (run && run.experiment.id === selectedExperiment?.id ? Object.keys(run.duplicateReplayVerified).length : undefined);
  const visibleIncidents = useMemo(() => incidents.filter(incident => (!caseStatus || incident.status === caseStatus) && (!caseSearch.trim() || `${incident.sourcePaymentId} ${incident.failureCode} ${incident.failureDescription}`.toLowerCase().includes(caseSearch.trim().toLowerCase()))).sort((left, right) => caseSort === 'amount' ? right.amountPaise - left.amountPaise : caseSort === 'status' ? left.status.localeCompare(right.status) : new Date(right.updatedAt || right.detectedAt || 0).getTime() - new Date(left.updatedAt || left.detectedAt || 0).getTime()), [incidents, caseSearch, caseStatus, caseSort]);
  const caseTotalPages = Math.max(1, Math.ceil(visibleIncidents.length / 20));
  const pagedIncidents = visibleIncidents.slice((Math.min(casePage, caseTotalPages) - 1) * 20, Math.min(casePage, caseTotalPages) * 20);
  useEffect(() => setCasePage(1), [caseSearch, caseStatus, caseSort]);
  return <section className="revenue-workspace">
    <section className="panel revenue-hero">
      <div><p className="eyebrow">CONTROLLED INBOUND REVENUE</p><h2>See what needs attention—and what RecoveryOS handled safely</h2><p>AI diagnoses the persisted payment timeline and recommends a bounded first step. Deterministic policy remains the authorization boundary, and revenue is counted only after a captured-payment event.</p></div>
      <div className="revenue-hero-action"><span className={`badge ${configuration?.ready ? 'good' : 'warn'}`}>{configuration?.ready ? 'READY' : 'NOT READY'}</span><button className="approve" title={!can(session, 'OPERATOR') ? 'Operator access required' : ''} disabled={!configuration?.ready || busy || !can(session, 'OPERATOR')} onClick={onRun}>{busy ? 'Running eight evaluations…' : 'Run controlled experiment'}</button><small>8 synthetic cases · repeatable · no live collection</small>{!can(session, 'OPERATOR') && <small className="access-note">Viewer access is read-only.</small>}</div>
      {error && <div className="demo-error" role="alert">{error}</div>}
    </section>
    <section className="metrics revenue-metrics primary-metrics"><Metric label="Revenue at risk" value={money(metrics?.valueAtRiskPaise ?? 0)} /><Metric label="Revenue recovered" value={money(metrics?.recoveredValuePaise ?? 0)} accent="green" /><Metric label="Recovery rate" value={`${((metrics?.recoveryRate ?? 0) * 100).toFixed(1)}%`} accent="green" /><Metric label="Needs human review" value={String(metrics?.manualReviewRequired ?? 0)} accent="orange" /></section>
    <details className="secondary-metrics revenue-secondary"><summary>View safety and evidence metrics</summary><section className="metrics"><Metric label="Recovered payments" value={String(metrics?.recoveredIncidentCount ?? 0)} /><Metric label="Unsafe actions blocked" value={String(metrics?.unsafeActionsPrevented ?? 0)} /><Metric label="Evidence completeness" value={`${((metrics?.evidenceCompleteness ?? 0) * 100).toFixed(0)}%`} /><Metric label="Duplicate replays blocked" value={duplicateCount === undefined ? 'Not stored in this snapshot' : `${duplicateCount}/${duplicateTotal}`} /></section></details>
    <section className="revenue-comparison">
      <div className="panel"><div className="panel-head"><div><p className="eyebrow">IMMUTABLE EVIDENCE</p><h2>Baseline comparison</h2></div>{selectedExperiment && <span className="badge good">FROZEN</span>}</div>
        {selectedExperiment ? <><div className="baseline-grid"><article><span>No recovery</span><strong>{money(baseline?.noAction.recoveredValuePaise ?? 0)}</strong><small>Observed without an intervention</small></article><article><span>Rules only</span><strong>{money(baseline?.rulesOnly.recoveredValuePaise ?? 0)}</strong><small>Conservative static eligibility</small></article><article className="winner"><span>AI + policy</span><strong>{money(baseline?.aiPolicy.recoveredValuePaise ?? 0)}</strong><small>Incremental vs rules {money(baseline?.aiPolicy.incrementalVsRulesPaise ?? 0)}</small></article></div>{baseline && <BaselineBars baseline={baseline} />}<p className="metric-note">{baseline?.disclaimer}</p><details className="technical-details"><summary>Technical experiment metadata</summary><div className="experiment-meta"><span>Policy <strong>{selectedExperiment.policyVersion}</strong></span><span>Model <strong>{selectedExperiment.modelRef}</strong></span><span>Prompt <strong>{selectedExperiment.promptVersion}</strong></span><span>Fingerprint <strong>{selectedExperiment.cohortFingerprint.slice(0, 12)}…</strong></span></div></details></> : <div className="empty">Run the controlled cohort to create immutable comparison evidence.</div>}
      </div>
      <div className="panel experiment-list"><div className="panel-head"><div><p className="eyebrow">FROZEN HISTORY</p><h2>Experiment snapshots</h2><p>Older results remain immutable and are clearly marked</p></div></div>{experiments.length ? experiments.map((experiment, index) => { const state = index === 0 ? 'CURRENT' : experiment.metrics.evidenceCompleteness < 1 ? 'INVALIDATED' : 'SUPERSEDED'; return <button key={experiment.id} className={`batch-card ${selectedExperiment?.id === experiment.id ? 'selected' : ''}`} onClick={() => onSelectExperiment(experiment)}><span><span className={`badge ${state === 'CURRENT' ? 'good' : state === 'INVALIDATED' ? 'warn' : 'neutral'}`}>{state}</span><strong>{experiment.name}</strong><small>{new Date(experiment.completedAt).toLocaleString()} · {experiment.cohortSize} synthetic cases</small></span><strong>{money(experiment.metrics.recoveredValuePaise)}</strong></button>; }) : <div className="empty">No revenue experiments yet.</div>}</div>
    </section>
    <section className="content revenue-incidents"><div className="panel list"><div className="panel-head"><div><p className="eyebrow">CASE QUEUE</p><h2>Inbound payment incidents</h2><p>{visibleIncidents.length} of {incidents.length} timeline-grounded decisions</p></div></div><div className="filters revenue-filters"><label className="filter-field"><span>Search</span><input value={caseSearch} onChange={event => setCaseSearch(event.target.value)} placeholder="Payment ID, code, or description" /></label><label className="filter-field"><span>Status</span><select value={caseStatus} onChange={event => setCaseStatus(event.target.value)}><option value="">All statuses</option>{[...new Set(incidents.map(incident => incident.status))].sort().map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label><label className="filter-field"><span>Sort</span><select value={caseSort} onChange={event => setCaseSort(event.target.value)}><option value="newest">Newest activity</option><option value="amount">Highest amount</option><option value="status">Status</option></select></label></div><div className="case-header" aria-hidden="true"><span>Payment</span><span>Status</span><span>Next action</span><span>Age</span><span>Amount</span></div><div className="rows">{pagedIncidents.map(incident => <button className={`row ${detail?.id === incident.id ? 'selected' : ''}`} aria-pressed={detail?.id === incident.id} key={incident.id} onClick={() => onOpen(incident.id)}><span><strong>{incident.sourcePaymentId}</strong><small>{incident.failureCode} · {incident.failureDescription}</small><em className="source-label">{incident.sourcePaymentId.includes('demo') ? 'SYNTHETIC' : 'PROVIDER EVENT'}</em></span><span className={`badge ${tone(incident.status)}`}>{incident.status.replaceAll('_', ' ')}</span><span className="row-action">{nextAction(incident.status)}</span><span className="row-age">{age(incident.updatedAt || incident.detectedAt)}</span><strong>{money(incident.amountPaise)}</strong></button>)}{!visibleIncidents.length && <div className="empty">No incidents match the current filters.</div>}</div><div className="pagination"><button disabled={casePage <= 1} onClick={() => setCasePage(page => page - 1)}>Previous</button><span>Page {Math.min(casePage, caseTotalPages)} of {caseTotalPages}</span><button disabled={casePage >= caseTotalPages} onClick={() => setCasePage(page => page + 1)}>Next</button></div></div><aside className="panel detail">{detail ? <RevenueIncidentDetail detail={detail} canOperate={can(session, 'OPERATOR')} onReview={onReview} /> : <div className="empty"><h2>Select a failed payment</h2><p>Inspect its recommendation, policy decision, execution and audit trail.</p></div>}</aside></section>
  </section>;
}

function RevenueIncidentDetail({ detail, canOperate, onReview }: { detail: RevenueIncident; canOperate: boolean; onReview: (approved: boolean) => void }) {
  const analysis = detail.analyses.at(-1); const proposal = analysis?.outputJson; const policy = detail.policyDecisions.at(-1);
  return <><div className="panel-head"><div><p className="eyebrow">INBOUND PAYMENT INCIDENT</p><h2>{detail.sourcePaymentId}</h2></div><span className={`badge ${tone(detail.status)}`}>{detail.status.replaceAll('_', ' ')}</span></div><div className="facts"><span>Revenue at risk<strong>{money(detail.amountPaise)}</strong></span><span>Payment method<strong>{detail.paymentMethod}</strong></span><span>Failure<strong>{detail.failureCode}</strong></span><span>Contact consent<strong>{detail.consentToContact ? 'PRESENT' : 'ABSENT'}</strong></span></div>
    {proposal && <section className="evidence"><div className="evidence-head"><p className="eyebrow">AI RECOMMENDATION · ADVISORY ONLY</p><span className="badge neutral">{analysis.modelRef}</span></div><strong>{proposal.category.replaceAll('_', ' ')} → {proposal.recommendedAction.replaceAll('_', ' ')}</strong><p>{proposal.diagnosis}</p><small>Confidence {Math.round(proposal.confidence * 100)}%</small><details className="technical-details"><summary>View cited evidence and model metadata</summary><div className="cited-evidence">{proposal.evidence.map(item => <div key={`${item.eventId}-${item.fact}`}><code>{item.eventId}</code><span>{item.fact}</span></div>)}</div><small>Timeline {analysis.timelineDigest.slice(0, 12)}… · Prompt {analysis.promptVersion}</small></details></section>}
    {proposal && <details className="playbook technical-details"><summary>View proposed recovery playbook</summary><p className="eyebrow">BOUNDED STEPS</p>{proposal.playbook.map(step => <div key={`${step.order}-${step.action}`}><span>{step.order}</span><p><strong>{step.action.replaceAll('_', ' ')}</strong><small>{step.delayMinutes} minute delay · {step.requiresHuman ? 'human required' : 'automated if policy allows'}</small>{step.rationale}</p></div>)}</details>}
    {policy && <section className="evidence policy"><p className="eyebrow">DETERMINISTIC AUTHORIZATION</p><strong>{policy.finalAction.replaceAll('_', ' ')}</strong><p>{policy.reasonsJson.join(' ')}</p><small>{policy.policyVersion} · {policy.authorized ? 'FIRST STEP AUTHORIZED' : 'NO AUTOMATIC MONEY ACTION'}</small></section>}
    {detail.status === 'APPROVAL_REQUIRED' && <div className="actions sticky-action"><span><strong>Human decision required</strong><small>Policy blocked automatic execution.</small></span><button className="approve" disabled={!canOperate} title={!canOperate ? 'Operator access required' : ''} onClick={() => onReview(true)}>Approve first step</button><button className="danger" disabled={!canOperate} title={!canOperate ? 'Operator access required' : ''} onClick={() => onReview(false)}>Reject</button></div>}
    {!!detail.actions?.length && <section className="action-ledger"><p className="eyebrow">ACTION & ATTRIBUTION</p>{detail.actions.map(action => <div key={action.id}><span>{action.actionType.replaceAll('_', ' ')}</span><strong>{action.outcome}</strong><small>Attributed {money(action.attributedRevenuePaise)}</small></div>)}</section>}
    <details className="timeline technical-details"><summary>View complete audit timeline</summary>{detail.auditEvents?.map(event => <div className="event" key={event.id}><i></i><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><p>{event.rationale}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></div>)}</details></>;
}
function BatchWorkspace({ batches, selected, canCreate, onSelect, onCreate, onDownload }: { batches: Batch[]; selected: Batch | null; canCreate: boolean; onSelect: (batch: Batch) => void; onCreate: () => void; onDownload: (batch: Batch, format: 'csv' | 'json') => void }) {
  return <section className="workspace"><div className="panel batch-list"><div className="panel-head"><div><p className="eyebrow">FROZEN EVIDENCE</p><h2>Evaluation batches</h2><p>Versioned outcomes that never change later</p></div><button disabled={!canCreate} title={!canCreate ? 'Operator access required' : ''} onClick={onCreate}>Create from queue</button></div>{batches.length ? batches.map((batch, index) => <button key={batch.id} className={`batch-card ${selected?.id === batch.id ? 'selected' : ''}`} onClick={() => onSelect(batch)}><span><span className={`badge ${index === 0 ? 'good' : 'neutral'}`}>{index === 0 ? 'CURRENT' : 'ARCHIVED'}</span><strong>{batch.name}</strong><small>{new Date(batch.startedAt).toLocaleString()} · {batch.cohortSize} cases · {batch.immutable ? 'immutable' : 'legacy'}</small></span><strong>Eligible {(batch.metrics.eligibleRecoveryRate * 100).toFixed(1)}%</strong></button>) : <div className="empty">No batches yet. Create one from the current incident queue.</div>}</div><aside className="panel batch-detail">{selected ? <><div className="panel-head"><div><p className="eyebrow">BATCH EVIDENCE</p><h2>{selected.name}</h2></div><span className={`badge ${selected.immutable ? 'good' : 'warn'}`}>{selected.immutable ? 'IMMUTABLE' : 'LEGACY SNAPSHOT'}</span></div><div className="batch-stats expanded"><span>Gross recovered<strong>{money(selected.metrics.recoveredValuePaise)}</strong></span><span>Eligible recovered<strong>{money(selected.metrics.recoveredEligibleValuePaise)}</strong></span><span>Eligible recovery<strong>{(selected.metrics.eligibleRecoveryRate * 100).toFixed(1)}%</strong></span><span>Pending recovery<strong>{money(selected.metrics.pendingRecoveryValuePaise)}</strong></span><span>Protected value<strong>{money(selected.metrics.protectedValuePaise)}</strong></span><span>Recorded interventions<strong>{selected.metrics.manualInterventions}</strong></span></div><div className="metric-note">New batches freeze outcomes, intervention counts, safety decisions, model, prompt, policy and cohort fingerprint at completion. Later incident changes do not rewrite these metrics.</div>{selected.immutable && <details className="technical-details"><summary>Version and cohort fingerprint</summary><div className="experiment-meta"><span>Policy <strong>{selected.policyVersion}</strong></span><span>Model <strong>{selected.modelRef}</strong></span><span>Prompt <strong>{selected.promptVersion}</strong></span><span>Fingerprint <strong>{selected.cohortFingerprint?.slice(0, 12)}…</strong></span></div></details>}<div className="distribution"><p className="eyebrow">OUTCOME DISTRIBUTION</p>{Object.entries(selected.metrics.statusDistribution).map(([status, count]) => <div key={status}><span>{status.replaceAll('_', ' ')}</span><strong>{count}</strong></div>)}</div><div className="actions"><button className="approve" onClick={() => onDownload(selected, 'csv')}>Download CSV</button><button onClick={() => onDownload(selected, 'json')}>Download JSON</button></div></> : <div className="empty">Select a batch to inspect its evidence.</div>}</aside></section>;
}
function DemoWorkspace({ operations, run, providerRun, busy, providerBusy, error, providerError, canOperate, canAdmin, onRun, onRunProvider, onOpenIncident, onOpenBatch }: { operations: Operations | null; run: DemoRun | null; providerRun: RazorpayTestDemoRun | null; busy: boolean; providerBusy: boolean; error: string; providerError: string; canOperate: boolean; canAdmin: boolean; onRun: (scenario: string) => void; onRunProvider: () => void; onOpenIncident: (incident: Detail) => void; onOpenBatch: (batch: Batch) => void }) {
  const demo = operations?.demo;
  const providerDemo = operations?.razorpayTestDemo;
  const providerExecution = providerRun?.incident.executions?.find(execution => execution.actionType === 'RAZORPAYX_TEST_PAYOUT');
  const providerPayoutId = providerExecution?.responseJson?.id;
  const providerStatus = providerExecution?.responseJson?.status;
  const preflight = [
    ['Simulation safety', Boolean(operations?.simulationMode), 'ENABLED'],
    ['Groq hosted model', Boolean(operations?.ai.configured), operations?.ai.model || 'UNAVAILABLE'],
    ['PostgreSQL', Boolean(operations?.services.database), 'READY'],
    ['Private Redis / BullMQ', Boolean(operations?.services.redis), 'READY'],
  ] as const;
  return <section className="demo-workspace">
    <div className="panel demo-control">
      <div className="panel-head"><div><p className="eyebrow">PRESENTER CONSOLE</p><h2>Live AI decision demonstration</h2><p>Every run creates normal incidents, policy evidence, queue actions, and an auditable batch.</p></div><span className={`badge ${demo?.ready ? 'good' : 'warn'}`}>{demo?.ready ? 'READY' : 'NOT READY'}</span></div>
      <div className="demo-preflight">{preflight.map(([label, ready, detail]) => <article key={label}><span>{label}</span><strong className={ready ? 'state-good' : 'state-warn'}>● {ready ? detail : 'UNAVAILABLE'}</strong></article>)}</div>
      {!demo?.enabled && <div className="demo-warning">Live demo controls are disabled on the API. Set <code>ENABLE_LIVE_DEMO=true</code> only while simulation mode is enabled.</div>}
      <section className="razorpay-test-card">
        <div className="razorpay-test-head"><div><p className="eyebrow">REAL PROVIDER · TEST MODE</p><h3>RazorpayX automatic retry</h3><p>AI recommends and policy authorizes a fixed ₹10,000 retry. The worker then creates an actual RazorpayX Test Mode payout to the configured dummy fund account.</p></div><span className={`badge ${providerDemo?.ready ? 'good' : 'warn'}`}>{providerDemo?.ready ? 'READY' : 'NOT READY'}</span></div>
        <div className="razorpay-test-facts"><span>Amount<strong>{money(providerDemo?.amountPaise ?? 1_000_000)}</strong></span><span>Fund account<strong>{providerDemo?.fundAccountDisplay || 'CONFIGURED DUMMY'}</strong></span><span>Authorization<strong>ADMIN + POLICY</strong></span></div>
        <button className="approve" title={!canAdmin ? 'Administrator access required' : ''} disabled={!providerDemo?.ready || providerBusy || busy || !canAdmin} onClick={onRunProvider}>{providerBusy ? 'Calling AI and scheduling retry…' : 'Review ₹10,000 RazorpayX test retry'}</button>
        {!canAdmin && <small className="access-note">Administrator access is required for provider-backed test actions.</small>}
        <small>The confirmation shows the exact amount, dummy fund account, idempotency protection, and {providerDemo?.cooldownSeconds ?? 300}-second cooldown.</small>
        {providerError && <div className="demo-error">{providerError}</div>}
        {providerRun && <div className="razorpay-test-result"><div><span>RecoveryOS incident</span><strong className={tone(providerRun.incident.status) === 'good' ? 'state-good' : 'state-warn'}>{providerRun.incident.status.replaceAll('_', ' ')}</strong></div><div><span>RazorpayX payout</span><strong>{providerPayoutId ? `pout_…${providerPayoutId.slice(-6)}` : 'QUEUED'}</strong></div><div><span>Provider status</span><strong>{providerStatus?.toUpperCase() || 'WAITING'}</strong></div><div><span>Duplicate replay</span><strong>{providerRun.duplicateReplayVerified ? 'BLOCKED' : 'VERIFYING'}</strong></div><p>{providerRun.incident.status === 'RECOVERED' ? 'RazorpayX confirmed the payout as processed. RecoveryOS closed the same incident.' : providerStatus === 'processing' ? 'The payout is visible in RazorpayX Test Mode. Advance it to processed there; the signed webhook will update this card automatically.' : 'RecoveryOS is running AI classification, deterministic authorization, and the durable retry action.'}</p><div className="actions compact"><button onClick={() => onOpenIncident(providerRun.incident)}>Open incident</button><button onClick={() => onOpenBatch(providerRun.batch)}>Open evidence</button></div></div>}
      </section>
      <div className="demo-scenarios">{demo?.scenarios.map(scenario => <article key={scenario.key} className="demo-scenario"><div><p className="eyebrow">{scenario.humanRequired ? 'HUMAN GATE' : 'AUTONOMOUS PATH'}</p><h3>{scenario.title}</h3><p>{scenario.description}</p></div><dl><div><dt>Amount</dt><dd>{money(scenario.amountPaise)}</dd></div><div><dt>AI proposes</dt><dd>{scenario.expectedAiAction}</dd></div><div><dt>Policy decides</dt><dd>{scenario.expectedPolicyDecision.replaceAll('_', ' ')}</dd></div></dl><button title={!canOperate ? 'Operator access required' : ''} disabled={!demo.ready || busy || !canOperate} onClick={() => onRun(scenario.key)}>{busy ? 'Running…' : 'Run scenario'}</button></article>)}</div>
      <div className="demo-run-all"><button className="approve" disabled={!demo?.ready || busy || !canOperate} onClick={() => onRun('ALL')}>{busy ? 'Calling Groq and evaluating policy…' : 'Run all four scenarios'}</button><span>Autonomous retries use transparent simulation time compression: policy delay → {demo?.retryDelaySeconds ?? 5} seconds.</span></div>
      {error && <div className="demo-error">{error}</div>}
    </div>
    <div className="panel demo-output">
      {!run ? <div className="empty"><h2>No live run yet</h2><p>Select a scenario to watch the actual AI, policy, queue, and audit outputs appear here.</p></div> : <>
        <div className="panel-head"><div><p className="eyebrow">LIVE RUN {run.runId}</p><h2>{run.batch.name}</h2><p>{run.incidents.length} persisted incident{run.incidents.length === 1 ? '' : 's'} · duplicate replay verified</p></div><button onClick={() => onOpenBatch(run.batch)}>Open batch</button></div>
        <div className="demo-results">{run.incidents.map(incident => {
          const analysis = incident.analyses.at(-1);
          const proposal = analysis?.outputJson;
          const decision = incident.policyDecisions.at(-1);
          const scenarioKey = incident.razorpayPayoutId.split(`${run.runId}_`)[1]?.toUpperCase() || '';
          const duplicateSafe = run.duplicateReplayVerified[scenarioKey];
          return <article className="demo-result" key={incident.id}>
            <div className="demo-result-head"><div><p className="eyebrow">{scenarioKey.replaceAll('_', ' ')}</p><h3>{incident.razorpayPayoutId}</h3></div><span className={`badge ${tone(incident.status)}`}>{incident.status.replaceAll('_', ' ')}</span></div>
            <div className="demo-decision-grid"><section><span>AI advisory</span><strong>{proposal ? `${proposal.category.replaceAll('_', ' ')} → ${proposal.recommendedAction}` : 'Pending'}</strong><small>{analysis?.modelRef || 'Waiting for hosted model'}</small></section><section><span>Policy decision</span><strong>{decision?.finalDecision.replaceAll('_', ' ') || 'Pending'}</strong><small>{decision?.reasonsJson.join(' ') || 'Waiting for deterministic policy'}</small></section><section><span>Safety evidence</span><strong>{duplicateSafe ? 'DUPLICATE BLOCKED' : 'VERIFYING'}</strong><small>{incident.executions?.length || 0} durable action record(s)</small></section></div>
            <div className="demo-timeline"><p className="eyebrow">ACTUAL AUDIT EVENTS</p>{incident.auditEvents.map(event => <div key={event.id}><i></i><span><strong>{event.eventType.replaceAll('_', ' ')}</strong><small>{event.rationale}</small></span></div>)}</div>
            <button onClick={() => onOpenIncident(incident)}>Open full incident</button>
          </article>;
        })}</div>
      </>}
    </div>
  </section>;
}
function PolicyWorkspace({ policy, canAdmin, onChange, onSave }: { policy: Policy; canAdmin: boolean; onChange: (policy: Policy) => void; onSave: () => void }) { const numeric = (key: keyof Policy, value: string) => onChange({ ...policy, [key]: Number(value) }); return <section className="panel policy-workspace"><div className="panel-head"><div><p className="eyebrow">AUTHORIZATION BOUNDARY</p><h2>Deterministic recovery policy</h2><p>AI can recommend. Only these versioned rules can authorize execution.</p></div><span className="badge neutral">FAIL CLOSED</span></div>{!canAdmin && <div className="role-banner"><strong>Read-only policy view</strong><span>Administrator access is required to activate a policy version.</span></div>}<div className="policy-form"><label>Policy version<input disabled={!canAdmin} value={policy.version} onChange={event => onChange({ ...policy, version: event.target.value })} /></label><label>Maximum automatic retries<input disabled={!canAdmin} type="number" min="0" max="10" value={policy.maxAutoRetryAttempts} onChange={event => numeric('maxAutoRetryAttempts', event.target.value)} /></label><label>Autonomous amount limit (paise)<input disabled={!canAdmin} type="number" min="1" value={policy.maxAutonomousAmountPaise} onChange={event => numeric('maxAutonomousAmountPaise', event.target.value)} /></label><label>Minimum retry delay (minutes)<input disabled={!canAdmin} type="number" min="0" value={policy.minimumRetryDelayMinutes} onChange={event => numeric('minimumRetryDelayMinutes', event.target.value)} /></label><div className="policy-warning"><strong>Activation is immediate.</strong><p>Create a new version identifier for every material rule change. Existing audit events retain the policy version that authorized them.</p></div><button className="approve" disabled={!canAdmin} onClick={onSave}>Activate policy version</button></div></section>; }
function OperationsWorkspace({ operations, onRefresh }: { operations: Operations | null; onRefresh: () => void }) {
  if (!operations) return <section className="panel operations"><div className="empty">Operational status is loading.</div></section>;
  return <section className="panel operations">
    <div className="panel-head">
      <div><h2>Operational readiness</h2><p>Credential-free service, worker queue, and advisory-provider status.</p></div>
      <div className="actions compact"><span className={`badge ${operations.status === 'ready' ? 'good' : 'warn'}`}>{operations.status.toUpperCase()}</span><button onClick={onRefresh}>Refresh</button></div>
    </div>
    <div className="service-grid">
      <ServiceState label="Neon PostgreSQL" ready={operations.services.database} />
      <ServiceState label="Private Redis / BullMQ" ready={operations.services.redis} />
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
function IncidentDetail({ detail, canOperate, onReview, onRemediate }: { detail: Detail; canOperate: boolean; onReview: (approved: boolean) => void; onRemediate: (beneficiaryRef: string, note: string) => void }) {
  const [beneficiaryRef, setBeneficiaryRef] = useState(''); const [remediationNote, setRemediationNote] = useState('');
  const analysisRecord = detail.analyses.at(-1); const analysis = analysisRecord?.outputJson; const decision = detail.policyDecisions.at(-1); const deterministic = analysisRecord?.modelRef === 'deterministic-simulator';
  return <><div className="panel-head"><div><p className="eyebrow">PAYOUT INCIDENT DETAILS</p><h2>{detail.razorpayPayoutId}</h2></div><span className={`badge ${tone(detail.status)}`}>{detail.status.replaceAll('_', ' ')}</span></div><div className="facts"><span>Amount <strong>{money(detail.amountPaise)}</strong></span><span>Attempts <strong>{detail.attempts}</strong></span><span>Reason <strong>{detail.currentReason || '—'}</strong></span></div>{analysis && <section className="evidence"><div className="evidence-head"><p className="eyebrow">{deterministic ? 'DETERMINISTIC ADVISORY' : 'AI ADVISORY'}</p><span className="badge neutral">{analysisRecord?.modelRef}</span></div><strong>{analysis.category.replaceAll('_', ' ')}</strong><p>{analysis.evidenceSummary}</p><small>Confidence {Math.round(analysis.confidence * 100)}% · Proposed {analysis.recommendedAction} · Prompt {analysisRecord?.promptVersion}</small></section>}{decision && <section className="evidence policy"><p className="eyebrow">POLICY DECISION</p><strong>{decision.finalDecision.replaceAll('_', ' ')}</strong><p>{decision.reasonsJson.join(' ')}</p></section>}
    {detail.status === 'APPROVAL_REQUIRED' && <div className="actions sticky-action"><span><strong>Bounded retry needs approval</strong><small>Review the advisory and policy evidence before deciding.</small></span><button className="approve" disabled={!canOperate} title={!canOperate ? 'Operator access required' : ''} onClick={() => onReview(true)}>Approve retry</button><button className="danger" disabled={!canOperate} title={!canOperate ? 'Operator access required' : ''} onClick={() => onReview(false)}>Reject</button></div>}
    {detail.status === 'ESCALATE' && <section className="remediation"><p className="eyebrow">REMEDIATION REQUIRED · RETRY IS BLOCKED</p><p>An escalation cannot be approved directly. Record a validated replacement beneficiary; a separate actor must then approve the new retry task.</p><label>Replacement beneficiary reference<input disabled={!canOperate} value={beneficiaryRef} onChange={event => setBeneficiaryRef(event.target.value)} /></label><label>Verification evidence and remediation note<textarea disabled={!canOperate} value={remediationNote} onChange={event => setRemediationNote(event.target.value)} /></label><div className="actions compact"><button className="approve" disabled={!canOperate || beneficiaryRef.trim().length < 3 || remediationNote.trim().length < 10} onClick={() => onRemediate(beneficiaryRef, remediationNote)}>Record remediation</button><button className="danger" disabled={!canOperate} onClick={() => onReview(false)}>Reject and stop</button></div>{!canOperate && <p className="access-note">Operator access is required to record remediation.</p>}</section>}
    <details className="timeline technical-details"><summary>View complete audit timeline</summary>{detail.auditEvents.map(event => <div className="event" key={event.id}><i></i><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><p>{event.rationale}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></div>)}</details></>;
}

function ProviderConfirmationDialog({ configuration, onCancel, onConfirm }: { configuration: Operations['razorpayTestDemo']; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="provider-confirm-title"><p className="eyebrow">CONFIRM CONTROLLED PROVIDER ACTION</p><h2 id="provider-confirm-title">Schedule a RazorpayX Test Mode payout?</h2><p>This calls the real RazorpayX API with Test Mode credentials. A payout record will appear in the test dashboard, but no live money will move.</p><dl className="confirm-facts"><div><dt>Amount</dt><dd>{money(configuration.amountPaise)}</dd></div><div><dt>Fund account</dt><dd>{configuration.fundAccountDisplay || 'Configured dummy account'}</dd></div><div><dt>Authorization</dt><dd>Administrator + deterministic policy</dd></div><div><dt>Duplicate safety</dt><dd>Server-generated idempotency key</dd></div><div><dt>Cooldown</dt><dd>{configuration.cooldownSeconds} seconds</dd></div></dl><div className="modal-actions"><button onClick={onCancel}>Cancel</button><button className="provider-confirm" onClick={onConfirm}>Schedule {money(configuration.amountPaise)} test payout</button></div></section></div>;
}
