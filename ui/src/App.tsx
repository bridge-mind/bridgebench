import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Check, ChevronLeft, ChevronRight, FileText, Gavel, Play, RefreshCw,
  ShieldCheck, TriangleAlert, Trophy, Wifi, WifiOff, X,
} from 'lucide-react';

import {
  fetchState, startArenaRun, type ArenaEvent, type BenchmarkCategory, type DashboardArena,
  type DashboardModel, type DashboardState, type DashboardTask, type MatchResult,
} from './api';

const LOGO_URL = '/bridgemind-logo.png';

type View = 'arena' | 'leaderboard' | 'matches';
type DetailTab = 'overview' | 'task' | 'responses' | 'judges';

interface LiveResponse {
  text: string;
  done: boolean;
  success: boolean;
}

interface LiveResponses {
  matchId: string | null;
  sides: Partial<Record<'A' | 'B', LiveResponse>>;
}

const EMPTY_LIVE: LiveResponses = { matchId: null, sides: {} };

const VENDOR_NAMES: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', minimax: 'MiniMax', moonshotai: 'Moonshot AI',
  google: 'Google', 'x-ai': 'xAI', 'z-ai': 'Z.ai',
};

function vendorName(vendor: string): string {
  return VENDOR_NAMES[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

function modelName(models: DashboardModel[], id: string | null | undefined): string {
  if (!id) return 'Pending';
  return models.find((model) => model.id === id)?.displayName ?? id;
}

function clusterLabel(cluster: string): string {
  const text = cluster.replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function eventLabel(event: ArenaEvent, models: DashboardModel[]): string {
  switch (event.type) {
    case 'run.started':
      return `Run started — ${String(event.data.matches)} ${typeof event.data.category === 'string' ? `${event.data.category} ` : ''}matches scheduled`;
    case 'match.started': return `${modelName(models, String(event.data.modelA))} vs ${modelName(models, String(event.data.modelB))}`;
    case 'competitor.delta': return `${modelName(models, String(event.data.modelId))} is responding`;
    case 'competitors.completed': return 'Both responses in';
    case 'judging.started': return 'Anonymous responses sent to the panel';
    case 'judge.completed': {
      const judge = modelName(models, String(event.data.judgeModelId));
      // votedFor is the resolved model; the judge's raw MODEL_A/MODEL_B label
      // is per-judge permuted and would mislead next to the match card.
      return event.data.votedFor
        ? `${judge} voted for ${modelName(models, String(event.data.votedFor))}`
        : `${judge} abstained`;
    }
    case 'match.completed': return event.data.winnerModelId
      ? `${modelName(models, String(event.data.winnerModelId))} takes ${String(event.data.taskId)}`
      : `No contest on ${String(event.data.taskId)}`;
    case 'run.budget-stopped': return 'Run stopped at the budget cap';
    case 'run.completed': return 'Run complete — reports rebuilt';
    case 'run.failed': return String(event.data.error ?? 'Run failed');
  }
}

/** Renders the public task exactly as competitors receive it: summary, prompt, artifacts. */
function TaskBrief({ task, withSummary = true }: { task: DashboardTask; withSummary?: boolean }) {
  return (
    <div className="task-brief">
      {withSummary && <p className="task-summary">{task.summary}</p>}
      <div className="task-tags">
        <span className="task-tag task-tag-difficulty">{task.difficulty}</span>
        <span className="task-tag">{clusterLabel(task.cluster)}</span>
        {task.tags.map((tag) => <span className="task-tag" key={tag}>{tag}</span>)}
      </div>
      <h3 className="task-section-title">Prompt</h3>
      <p className="task-prompt">{task.prompt}</p>
      <h3 className="task-section-title">Artifacts ({task.artifacts.length})</h3>
      {task.artifacts.map((artifact) => (
        <details className="artifact" key={artifact.id}>
          <summary>
            <code>{artifact.id}</code>
            <span className="artifact-label">{artifact.label}</span>
            <span className="artifact-type">{artifact.type}</span>
          </summary>
          <pre>{artifact.content}</pre>
        </details>
      ))}
      <p className="task-footnote">
        Both models receive this exact context — title, summary, prompt, and artifacts — with identical system instructions.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: DashboardState['run']['status'] }) {
  const labels = { idle: 'Idle', running: 'Live', completed: 'Complete', 'budget-stopped': 'Budget stop', failed: 'Failed' };
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{labels[status]}</span>;
}

function BrandMark() {
  return (
    <span className="brand">
      <img src={LOGO_URL} alt="" width={26} height={26} />
      <span className="brand-name">BridgeBench</span>
      <span className="brand-version">V3 Arena</span>
    </span>
  );
}

function RunPanel({ data, category, arena, onStarted }: { data: DashboardState; category: BenchmarkCategory; arena: DashboardArena; onStarted: () => void }) {
  const [seed, setSeed] = useState('bridgebench-v3-mvp');
  const [matches, setMatches] = useState(12);
  const [budget, setBudget] = useState(25);
  const [resume, setResume] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = data.run.status === 'running';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await startArenaRun({ category, seed, matches, maxCostUsd: budget, resume });
      onStarted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start run');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card run-panel" onSubmit={submit} aria-labelledby="run-panel-title">
      <h2 id="run-panel-title">New {arena.meta.label.toLowerCase()} run</h2>
      <p className="card-sub">Seeded and replayable — the same seed schedules the same matches in this arena.</p>
      {!data.hasApiKey && (
        <div className="note note-warn" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Set <code>OPENROUTER_API_KEY</code> in the dashboard process to start runs.</span>
        </div>
      )}
      <label className="field">
        <span>Seed</span>
        <input value={seed} onChange={(event) => setSeed(event.target.value)} pattern="[a-zA-Z0-9._-]+" maxLength={100} disabled={running} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Matches</span>
          <input type="number" min={1} max={336} value={matches} onChange={(event) => setMatches(Number(event.target.value))} disabled={running} />
        </label>
        <label className="field">
          <span>Budget cap</span>
          <div className="input-prefix">
            <span aria-hidden="true">$</span>
            <input type="number" min={0.01} max={1000} step={1} value={budget} onChange={(event) => setBudget(Number(event.target.value))} disabled={running} />
          </div>
        </label>
      </div>
      <label className="check-field">
        <input type="checkbox" checked={resume} onChange={(event) => setResume(event.target.checked)} disabled={running} />
        <span><strong>Resume schedule</strong><small>Skips match IDs already in the journal.</small></span>
      </label>
      {error && <div className="note note-error" role="alert"><X size={16} aria-hidden="true" /><span>{error}</span></div>}
      <button className="button button-primary" type="submit" disabled={running || submitting || !data.hasApiKey}>
        {running ? <><Activity size={17} aria-hidden="true" />Run in progress</>
          : submitting ? <><RefreshCw className="spin" size={17} aria-hidden="true" />Starting</>
          : <><Play size={17} fill="currentColor" aria-hidden="true" />Start run</>}
      </button>
      <p className="run-footnote">Judges never see model names.</p>
    </form>
  );
}

function RosterPanel({ models }: { models: DashboardModel[] }) {
  const competitors = models.filter((model) => model.role === 'competitor');
  const judges = models.filter((model) => model.role === 'judge');
  return (
    <section className="card roster-panel" aria-labelledby="roster-title">
      <h2 id="roster-title">Roster</h2>
      <p className="card-sub">{competitors.length} competitors, judged by a fixed cross-vendor panel.</p>
      <ul className="roster-list">
        {competitors.map((model) => (
          <li key={model.id}>
            <span className="avatar">{model.displayName.slice(0, 2).toUpperCase()}</span>
            <span className="roster-name">{model.displayName}</span>
            <span className="roster-vendor">{vendorName(model.vendor)}</span>
          </li>
        ))}
      </ul>
      <h3 className="roster-judges-title"><Gavel size={14} aria-hidden="true" />Judge panel</h3>
      <ul className="roster-list roster-judges">
        {judges.map((judge) => (
          <li key={judge.id}>
            <span className="avatar avatar-judge">{judge.displayName.slice(0, 2).toUpperCase()}</span>
            <span className="roster-name">{judge.displayName}</span>
            <span className="roster-vendor">{vendorName(judge.vendor)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HowItWorks({ judges, arena, category }: { judges: DashboardModel[]; arena: DashboardArena; category: BenchmarkCategory }) {
  const panel = judges.map((judge) => judge.displayName).join(', ');
  return (
    <section className="card stage" aria-labelledby="how-title">
      <h2 id="how-title">The {arena.meta.label.toLowerCase()} arena</h2>
      <p className="card-sub">{arena.meta.tagline}</p>
      <p className="card-sub">Autonomous, blind, and journaled — with its own task pack and its own Elo ladder. Configure a run on the right, then watch it here.</p>
      <ol className="steps">
        <li>
          <span className="step-number" aria-hidden="true">1</span>
          <div><h3>Same task, two models</h3><p>{category === 'hallucination'
            ? 'Both competitors face the same trap-laden task — false premises, missing evidence, fabrication bait. Neither knows its opponent.'
            : 'Both competitors answer the same fully determinable reasoning task. Neither knows its opponent.'}</p></div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">2</span>
          <div><h3>Three judges, blind</h3><p>{panel || 'Three cross-vendor judges'} score the anonymous responses independently. Names, vendors, and ratings are redacted.</p></div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">3</span>
          <div><h3>Majority moves the Elo</h3><p>Two votes decide the winner — one point, one rating update, journaled to disk.</p></div>
        </li>
      </ol>
    </section>
  );
}

function StandingsSoFar({ arena, onViewLeaderboard }: { arena: DashboardArena; onViewLeaderboard: () => void }) {
  const { leaderboard, matches } = arena.snapshot;
  if (matches.length === 0) return null;
  const leader = leaderboard[0];
  const totalCost = matches.reduce((sum, match) => sum + match.matchCostUsd, 0);
  return (
    <section className="card recap" aria-labelledby="recap-title">
      <h2 id="recap-title">{arena.meta.label} standings so far</h2>
      <p className="card-sub">{matches.length} matches journaled for {formatMoney(totalCost)}.</p>
      {leader && leader.matches > 0 && (
        <p className="recap-leader">
          <span className="rank rank-leader" aria-hidden="true"><Trophy size={13} /></span>
          <span><strong>{leader.displayName}</strong> leads at <strong className="recap-elo">{leader.elo.toFixed(0)}</strong></span>
        </p>
      )}
      <button className="button button-ghost" type="button" onClick={onViewLeaderboard}>See standings</button>
    </section>
  );
}

function sideState(live: LiveResponse | undefined, responsesIn: boolean, hasMatch: boolean): string {
  if (live?.done) return live.success ? 'Response in' : 'Request failed';
  if (live?.text) return 'Writing response';
  if (responsesIn) return 'Response in';
  if (hasMatch) return 'Reasoning in private';
  return 'Waiting';
}

function StreamPane({ side, model, live }: { side: 'A' | 'B'; model: string; live: LiveResponse | undefined }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [live?.text]);

  return (
    <article className={`stream-pane ${live?.done ? 'is-done' : live?.text ? 'is-streaming' : ''}`} aria-label={`Model ${side} live response`}>
      <header>
        <span>Model {side} · {model}</span>
        {live?.text && <small>{live.text.length.toLocaleString()} chars{live.done ? '' : '…'}</small>}
      </header>
      <pre ref={ref}>{live?.text || 'Reasoning in private — visible text streams here as the model writes its answer.'}</pre>
    </article>
  );
}

function LiveStage({ data, runArena, live }: { data: DashboardState; runArena: DashboardArena; live: LiveResponses }) {
  const current = data.run.currentMatch;
  const task = current?.taskId ? runArena.tasks.find((item) => item.id === current.taskId) : undefined;
  const matchEvents = current?.matchId ? data.events.filter((event) => event.data.matchId === current.matchId) : [];
  const judging = matchEvents.some((event) => event.type === 'judging.started');
  const responsesIn = matchEvents.some((event) => event.type === 'competitors.completed');
  const judgeEvents = matchEvents.filter((event) => event.type === 'judge.completed');
  const judges = data.models.filter((model) => model.role === 'judge');
  const progress = data.run.total > 0 ? data.run.completed / data.run.total : 0;
  const budget = data.run.config?.maxCostUsd;
  const liveSides = current?.matchId && live.matchId === current.matchId ? live.sides : {};

  return (
    <section className="card stage" aria-labelledby="stage-title">
      <div className="stage-header">
        <span className="live-flag"><span className="live-dot" aria-hidden="true" />Live</span>
        <span className="stage-count">{runArena.meta.label} · Match {Math.min(data.run.completed + 1, data.run.total)} of {data.run.total}</span>
        <span className="stage-spend">{formatMoney(data.run.costUsd)}{budget ? ` of ${formatMoney(budget)}` : ''} spent</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <h2 id="stage-title" className="stage-task">{current?.taskTitle ?? 'Scheduling next matchup'}</h2>
      {current?.taskId && <p className="stage-task-id">{current.taskId}</p>}
      {task && (
        <>
          <p className="stage-task-summary">{task.summary}</p>
          <details className="stage-task-detail">
            <summary><FileText size={14} aria-hidden="true" />See the full task both models received</summary>
            <TaskBrief task={task} withSummary={false} />
          </details>
        </>
      )}
      <div className="versus">
        <div className="fighter">
          <span className="fighter-side">Model A</span>
          <strong>{modelName(data.models, current?.modelA)}</strong>
          <small>{sideState(liveSides.A, responsesIn, Boolean(current))}</small>
        </div>
        <span className="versus-divider" aria-hidden="true">vs</span>
        <div className="fighter">
          <span className="fighter-side">Model B</span>
          <strong>{modelName(data.models, current?.modelB)}</strong>
          <small>{sideState(liveSides.B, responsesIn, Boolean(current))}</small>
        </div>
      </div>
      {current && (
        <div className="live-responses">
          <StreamPane side="A" model={modelName(data.models, current.modelA)} live={liveSides.A} />
          <StreamPane side="B" model={modelName(data.models, current.modelB)} live={liveSides.B} />
        </div>
      )}
      <div className="bench">
        <span className="bench-label">{judging ? 'Panel is voting' : responsesIn ? 'Preparing anonymous panel' : 'Panel on standby'}</span>
        <div className="bench-judges">
          {judges.map((judge) => {
            const vote = judgeEvents.find((event) => event.data.judgeModelId === judge.id);
            const working = judging && !vote;
            return (
              <span className={`judge-chip ${vote ? 'is-done' : working ? 'is-working' : ''}`} key={judge.id}>
                {vote ? <Check size={13} aria-hidden="true" /> : <span className="chip-dot" aria-hidden="true" />}
                {judge.displayName}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RunSummary({ data, onViewLeaderboard }: { data: DashboardState; onViewLeaderboard: () => void }) {
  const { status, completed, costUsd, error, config } = data.run;
  const failed = status === 'failed';
  return (
    <section className="card stage" aria-labelledby="summary-title">
      <h2 id="summary-title">{failed ? 'Run failed' : status === 'budget-stopped' ? 'Run stopped at the budget cap' : 'Run complete'}</h2>
      {failed && error ? (
        <div className="note note-error" role="alert"><X size={16} aria-hidden="true" /><span>{error}</span></div>
      ) : (
        <p className="card-sub">{completed} {config ? `${config.category} ` : ''}matches judged for {formatMoney(costUsd)}. Ratings and reports are on disk.</p>
      )}
      <button className="button button-ghost" type="button" onClick={onViewLeaderboard}>
        <Trophy size={16} aria-hidden="true" />See standings
      </button>
    </section>
  );
}

function ActivityFeed({ data }: { data: DashboardState }) {
  const visible = [...data.events].slice(-10).reverse();
  if (visible.length === 0) return null;
  return (
    <section className="card activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      <ol className="activity-list">
        {visible.map((event) => (
          <li key={event.id}>
            <span className={`activity-mark activity-${event.type.split('.')[0]}`} aria-hidden="true">
              {event.type === 'judge.completed' ? <Gavel size={13} /> : event.type.includes('completed') ? <Check size={13} /> : <ChevronRight size={13} />}
            </span>
            <span className="activity-text">{eventLabel(event, data.models)}</span>
            <time className="activity-time" dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ArenaView({ data, category, arena, runArena, live, onViewLeaderboard, onStarted }: {
  data: DashboardState;
  category: BenchmarkCategory;
  arena: DashboardArena;
  runArena: DashboardArena;
  live: LiveResponses;
  onViewLeaderboard: () => void;
  onStarted: () => void;
}) {
  const { status } = data.run;
  const judges = data.models.filter((model) => model.role === 'judge');
  return (
    <div className="arena-grid">
      <div className="arena-main">
        {status === 'running' ? <LiveStage data={data} runArena={runArena} live={live} />
          : status === 'idle' ? <HowItWorks judges={judges} arena={arena} category={category} />
          : <RunSummary data={data} onViewLeaderboard={onViewLeaderboard} />}
        {status === 'idle' && <StandingsSoFar arena={arena} onViewLeaderboard={onViewLeaderboard} />}
        <ActivityFeed data={data} />
      </div>
      <div className="arena-rail">
        <RunPanel data={data} category={category} arena={arena} onStarted={onStarted} />
        <RosterPanel models={data.models} />
      </div>
    </div>
  );
}

function LeaderboardView({ arena }: { arena: DashboardArena }) {
  const { leaderboard, matches, initialElo, kFactor } = arena.snapshot;
  const decisive = matches.filter((match) => match.winnerModelId).length;
  const unanimous = matches.filter((match) => match.panel?.agreement === 'unanimous').length;
  const totalCost = matches.reduce((sum, match) => sum + match.matchCostUsd, 0);
  const elos = leaderboard.map((entry) => entry.elo);
  const minElo = Math.min(...elos);
  const maxElo = Math.max(...elos);
  const spread = maxElo - minElo;

  return (
    <section aria-labelledby="standings-title">
      <div className="view-header">
        <div>
          <h2 id="standings-title">{arena.meta.label} standings</h2>
          <p className="card-sub">A separate ladder for this arena — Elo moves once per judged match, everyone opens at {initialElo}, K-factor {kFactor}.</p>
        </div>
        <p className="summary-line">
          <span><strong>{matches.length}</strong> matches</span>
          <span><strong>{decisive}</strong> decisive</span>
          <span><strong>{unanimous}</strong> unanimous</span>
          <span><strong>{formatMoney(totalCost)}</strong> spent</span>
        </p>
      </div>
      <div className="table-scroll">
        <table className="standings">
          <thead>
            <tr><th>Rank</th><th>Model</th><th className="th-elo">Elo</th><th>Record</th><th>Win rate</th><th className="th-extra">Unanimous</th><th className="th-extra th-cost">Cost</th></tr>
          </thead>
          <tbody>
            {leaderboard.map((entry) => {
              const share = spread > 0 ? 0.12 + 0.88 * ((entry.elo - minElo) / spread) : 0.5;
              const leader = entry.rank === 1 && entry.matches > 0;
              return (
                <tr key={entry.modelId}>
                  <td><span className={`rank ${leader ? 'rank-leader' : ''}`}>{leader ? <Trophy size={13} aria-hidden="true" /> : entry.rank}</span></td>
                  <td><span className="standings-model"><strong>{entry.displayName}</strong><small>{entry.modelId}</small></span></td>
                  <td className="td-elo">
                    <span className="elo-cell">
                      <strong>{entry.elo.toFixed(0)}</strong>
                      <span className={`elo-bar ${leader ? 'elo-bar-leader' : ''}`} aria-hidden="true"><span style={{ transform: `scaleX(${share})` }} /></span>
                    </span>
                  </td>
                  <td className="td-mono">{entry.wins}–{entry.losses}</td>
                  <td className="td-mono">{entry.matches > 0 ? `${entry.winRate.toFixed(0)}%` : '—'}</td>
                  <td className="td-mono th-extra">{entry.unanimousWins}</td>
                  <td className="td-mono th-extra th-cost">{formatMoney(entry.totalCostUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {matches.length === 0 && <p className="table-footnote">No judged matches yet — the ladder starts moving with the first run.</p>}
    </section>
  );
}

function MatchList({ data, arena, onSelect }: { data: DashboardState; arena: DashboardArena; onSelect: (id: string) => void }) {
  const matches = [...arena.snapshot.matches].reverse();
  if (matches.length === 0) {
    return (
      <div className="empty">
        <Gavel size={22} aria-hidden="true" />
        <h3>No matches yet</h3>
        <p>Start a run from the Arena tab. Finished matches land here with full responses and judge votes.</p>
      </div>
    );
  }
  return (
    <ul className="match-list">
      {matches.map((match) => {
        const winner = modelName(data.models, match.winnerModelId);
        const loserId = match.winnerModelId === match.competitors.modelA ? match.competitors.modelB : match.competitors.modelA;
        return (
          <li key={match.matchId}>
            <button className="match-row" type="button" onClick={() => onSelect(match.matchId)}>
              <span className={`outcome outcome-${match.outcome}`}>{match.outcome === 'judged' ? <Trophy size={14} aria-hidden="true" /> : match.outcome === 'forfeit' ? <X size={14} aria-hidden="true" /> : <Gavel size={14} aria-hidden="true" />}</span>
              <span className="match-primary">
                <strong>
                  {match.winnerModelId
                    ? <>{winner} <span className="match-def">def.</span> {modelName(data.models, loserId)}</>
                    : <>{modelName(data.models, match.competitors.modelA)} <span className="match-def">vs</span> {modelName(data.models, match.competitors.modelB)} — no contest</>}
                </strong>
                <small>{match.task.id} · {clusterLabel(match.task.cluster)}</small>
              </span>
              {match.panel && <span className={`agreement agreement-${match.panel.agreement}`}>{match.panel.agreement}</span>}
              <span className="match-meta">{formatMoney(match.matchCostUsd)}</span>
              <time className="match-meta" dateTime={match.timestamp}>{formatDateTime(match.timestamp)}</time>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MatchDetail({ match, data, arena, onBack }: { match: MatchResult; data: DashboardState; arena: DashboardArena; onBack: () => void }) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const task = arena.tasks.find((item) => item.id === match.task.id);
  const winner = modelName(data.models, match.winnerModelId);
  const responses = [
    { side: 'Model A', id: match.competitors.modelA, response: match.competitors.responseA },
    { side: 'Model B', id: match.competitors.modelB, response: match.competitors.responseB },
  ];

  return (
    <section className="match-detail" aria-labelledby="detail-title">
      <button className="button button-ghost back-button" type="button" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />All matches
      </button>
      <div className="card detail-card">
        <div className="detail-header">
          <div>
            <h2 id="detail-title">{task?.title ?? match.task.id}</h2>
            <p className="card-sub">{clusterLabel(match.task.cluster)} · {formatDateTime(match.timestamp)} · <code>{match.matchId}</code></p>
            {task && <p className="detail-summary">{task.summary}</p>}
          </div>
          {match.winnerModelId && (
            <div className="winner-flag">
              <Trophy size={16} aria-hidden="true" />
              <span><small>Winner</small><strong>{winner}</strong></span>
            </div>
          )}
        </div>
        <div className="segmented" role="tablist" aria-label="Match detail views">
          {(['overview', 'task', 'responses', 'judges'] as DetailTab[]).map((item) => (
            <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'is-active' : ''} onClick={() => setTab(item)}>
              {item === 'judges' ? 'Judge votes' : item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <dl className="detail-grid">
            {responses.map(({ side, id, response }) => (
              <div key={side}>
                <dt>{side}</dt>
                <dd>
                  <strong>{modelName(data.models, id)}</strong>
                  <small>
                    {response.success
                      ? `${formatDuration(response.latencyMs)} · ${response.outputTokens.toLocaleString()} output tokens${response.reasoningTokens != null ? ` · ${response.reasoningTokens.toLocaleString()} reasoning` : ''}`
                      : response.error ?? 'Failed'}
                  </small>
                </dd>
              </div>
            ))}
            <div>
              <dt>Panel</dt>
              <dd><strong>{match.panel ? `${match.panel.validVotes}/3 valid votes` : 'Not invoked'}</strong><small>{match.panel?.agreement ?? match.outcome}</small></dd>
            </div>
            <div>
              <dt>Elo movement</dt>
              <dd>
                {[match.competitors.modelA, match.competitors.modelB].map((id) => (
                  <small className="elo-move" key={id}>
                    {modelName(data.models, id)}: {match.eloBefore[id]?.toFixed(0)} → <strong>{match.eloAfter[id]?.toFixed(0)}</strong>
                  </small>
                ))}
              </dd>
            </div>
            <div>
              <dt>Match cost</dt>
              <dd><strong>{formatMoney(match.matchCostUsd)}</strong><small>Competitors and judges combined</small></dd>
            </div>
            <div>
              <dt>Provenance</dt>
              <dd><strong>{match.methodologyVersion}</strong><small>Seed {match.seed}</small></dd>
            </div>
          </dl>
        )}

        {tab === 'task' && (
          <div className="task-pane">
            {task ? (
              <>
                {task.publicHash !== match.task.publicHash && (
                  <div className="note note-warn" role="status">
                    <TriangleAlert size={16} aria-hidden="true" />
                    <span>
                      The task file on disk (v{task.version}) has changed since this match ran (v{match.task.version}).
                      What is shown below may differ from what the models received.
                    </span>
                  </div>
                )}
                {/* withSummary=false: the detail header already shows the summary on every tab. */}
                <TaskBrief task={task} withSummary={false} />
              </>
            ) : (
              <div className="empty empty-compact">
                <FileText size={18} aria-hidden="true" />
                <p><code>{match.task.id}</code> is no longer in the local task set — the journal keeps only its content hashes.</p>
              </div>
            )}
          </div>
        )}

        {tab === 'responses' && (
          <div className="response-columns">
            {responses.map(({ side, id, response }) => (
              <article key={side}>
                <header>
                  <span>{side}{match.winnerModelId === id ? ' · winner' : ''}</span>
                  <strong>{modelName(data.models, id)}</strong>
                </header>
                <pre>{response.content || response.error || 'No response recorded.'}</pre>
              </article>
            ))}
          </div>
        )}

        {tab === 'judges' && (
          <div className="vote-list">
            {match.panel?.votes.map((vote) => (
              <article key={vote.judgeModelId}>
                <header>
                  <strong>{modelName(data.models, vote.judgeModelId)}</strong>
                  <span className="vote-verdict">
                    {vote.verdict
                      ? `Voted ${vote.winnerModelId ? modelName(data.models, vote.winnerModelId) : vote.verdict.winner.replace('_', ' ')} · ${Math.round(vote.verdict.confidence * 100)}%`
                      : 'Abstained'}
                  </span>
                </header>
                <p>{vote.verdict?.rationale ?? vote.error ?? 'No valid verdict was returned.'}</p>
                {vote.verdict && (
                  <dl>
                    <div><dt>Correctness</dt><dd>{vote.verdict.criteria.correctness}</dd></div>
                    <div><dt>Grounding</dt><dd>{vote.verdict.criteria.grounding}</dd></div>
                    <div><dt>Constraints</dt><dd>{vote.verdict.criteria.constraintHandling}</dd></div>
                    <div><dt>Completeness</dt><dd>{vote.verdict.criteria.completeness}</dd></div>
                  </dl>
                )}
              </article>
            ))}
            {!match.panel && <div className="empty empty-compact"><Gavel size={18} aria-hidden="true" /><p>The panel was not invoked for this {match.outcome}.</p></div>}
          </div>
        )}
      </div>
    </section>
  );
}

function MatchesView({ data, arena }: { data: DashboardState; arena: DashboardArena }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => arena.snapshot.matches.find((match) => match.matchId === selectedId) ?? null,
    [arena, selectedId],
  );

  if (selected) return <MatchDetail match={selected} data={data} arena={arena} onBack={() => setSelectedId(null)} />;

  return (
    <section aria-labelledby="matches-title">
      <div className="view-header">
        <div>
          <h2 id="matches-title">{arena.meta.label} matches</h2>
          <p className="card-sub">Every response, vote, and rating change is journaled per arena. Pick a match to audit it.</p>
        </div>
      </div>
      <MatchList data={data} arena={arena} onSelect={setSelectedId} />
    </section>
  );
}

function LoadingShell() {
  return (
    <div className="loading-shell" aria-hidden="true">
      <div className="skeleton skeleton-bar" />
      <div className="loading-grid">
        <div className="skeleton skeleton-stage" />
        <div className="skeleton skeleton-rail" />
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [live, setLive] = useState<LiveResponses>(EMPTY_LIVE);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('arena');
  const [category, setCategory] = useState<BenchmarkCategory>('reasoning');

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState();
      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load dashboard');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('offline');
    source.addEventListener('arena', (message) => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as ArenaEvent;
        if (event.type === 'competitor.delta') {
          const { matchId, side, text, done, success } = event.data as {
            matchId: string; side: 'A' | 'B'; text: string; done: boolean; success: boolean;
          };
          setLive((previous) => ({
            matchId,
            sides: { ...(previous.matchId === matchId ? previous.sides : {}), [side]: { text, done, success } },
          }));
          return; // Deltas only feed the live panes; full state is unchanged.
        }
        if (event.type === 'match.started') setLive(EMPTY_LIVE);
      } catch {
        // Unparseable payloads still trigger a plain refresh below.
      }
      void refresh();
    });
    return () => source.close();
  }, [refresh]);

  if (!data && !error) return <LoadingShell />;
  if (!data) {
    return (
      <main className="fatal">
        <WifiOff size={26} aria-hidden="true" />
        <h1>Dashboard unavailable</h1>
        <p>{error}</p>
        <button className="button button-ghost" onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />Retry</button>
      </main>
    );
  }

  const running = data.run.status === 'running';
  const current = data.run.currentMatch;
  const arena = data.arenas[category];
  // The live stage always resolves tasks from the arena the RUN belongs to,
  // even while the viewer is browsing the other category.
  const runCategory = data.run.config?.category ?? category;
  const runArena = data.arenas[runCategory];

  return (
    <div className="shell">
      <header className="topbar">
        <BrandMark />
        <nav className="view-nav category-nav" aria-label="Arena category">
          {data.categories.map((item) => (
            <button
              key={item}
              type="button"
              className={category === item ? 'is-active' : ''}
              aria-current={category === item ? 'true' : undefined}
              onClick={() => setCategory(item)}
            >
              {data.arenas[item].meta.label}
            </button>
          ))}
        </nav>
        <nav className="view-nav" aria-label="Dashboard sections">
          {(['arena', 'leaderboard', 'matches'] as View[]).map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? 'is-active' : ''}
              aria-current={view === item ? 'page' : undefined}
              onClick={() => setView(item)}
            >
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="topbar-status">
          <span className={`connection connection-${connection}`} title={`Event stream ${connection}`}>
            {connection === 'live' ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
            <span className="connection-label">{connection === 'live' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting'}</span>
          </span>
          <StatusPill status={data.run.status} />
        </div>
      </header>

      {running && (view !== 'arena' || category !== runCategory) && (
        <button className="live-ribbon" type="button" onClick={() => { setCategory(runCategory); setView('arena'); }}>
          <span className="live-dot" aria-hidden="true" />
          <span>Live {runArena.meta.label.toLowerCase()} — match {Math.min(data.run.completed + 1, data.run.total)} of {data.run.total}{current ? `: ${modelName(data.models, current.modelA)} vs ${modelName(data.models, current.modelB)}` : ''}</span>
          <span className="ribbon-cta">Watch</span>
        </button>
      )}

      {data.run.error && data.run.status === 'failed' && view !== 'arena' && (
        <div className="note note-error page-note" role="alert"><X size={16} aria-hidden="true" /><span>{data.run.error}</span></div>
      )}

      <main className="content">
        {view === 'arena' && (
          <ArenaView
            data={data}
            category={category}
            arena={arena}
            runArena={runArena}
            live={live}
            onViewLeaderboard={() => setView('leaderboard')}
            onStarted={() => void refresh()}
          />
        )}
        {view === 'leaderboard' && <LeaderboardView arena={arena} />}
        {view === 'matches' && <MatchesView data={data} arena={arena} />}
      </main>

      <footer className="footer">
        <span>BridgeBench V3 · {arena.snapshot.methodologyVersion}</span>
        <span>
          {data.categories.map((item) => `${data.arenas[item].tasks.length} ${item} tasks`).join(' · ')} · local-only at 127.0.0.1
        </span>
      </footer>
    </div>
  );
}
