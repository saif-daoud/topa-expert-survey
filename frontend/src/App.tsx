import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Manifest = {
  components: string[];
  methods: { id: string; name: string; file: string }[];
};

type Descriptions = Record<string, string>;

const API_BASE = import.meta.env.VITE_API_BASE as string;

const APP_DESC = `
<div className="intro">

<strong>Welcome, and thank you for contributing your expertise to this study.</strong><br><br>
We are developing an AI system designed to <strong>simulate a mental health provider delivering Cognitive Behavioral Therapy (CBT).</strong><br>
To do this responsibly, we automatically extract key components of CBT interventions from clinical textbooks. Your role is to help us evaluate the quality of these extracted components.<br><br>
In this study, you will review three types of outputs the system generates:<br>
    <strong>1. Macro Actions –</strong> high-level therapeutic moves (e.g., cognitive restructuring, problem-solving, agenda setting).<br>
    <strong>2. Conversation State –</strong> the system’s moment-to-moment understanding of the client’s thoughts, feelings, behaviors, and therapeutic progress.<br>
    <strong>3. Knowledge Graph –</strong> structured clinical concepts and their relationships, used to guide the AI’s reasoning and intervention planning.<br><br>
For each of these components, you will see <strong>side-by-side results produced by different extraction methods.</strong><br>
Your task is to <strong>choose the option that best reflects accurate, clinically meaningful CBT practice.</strong> There are no right or wrong answers — we are seeking your clinical judgment.<br><br>
Your evaluations will help us refine an AI agent that behaves in a way that is safer, more consistent, and more aligned with real CBT interventions.<br><br>
When you’re ready, click <strong>Start</strong> to begin.

</div>
`;


function nowUtc() {
  return new Date().toISOString();
}

async function postJSON(url: string, payload: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(txt);
  } catch {}
  if (!r.ok) throw new Error(j?.error || txt || `HTTP ${r.status}`);
  return j;
}

// ---------- small deterministic RNG for stable pairs ----------
function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function stableShuffle<T>(arr: T[], seedStr: string) {
  const a = [...arr];
  const rnd = mulberry32(hash32(seedStr));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// champion vs unseen challengers (simple tournament)
function nextPair(pid: string, component: string, methodIds: string[], history: any[]) {
  if (!pid || methodIds.length < 2) return null;

  const rows = history
    .filter((r) => r.participant_id === pid && r.component === component)
    .sort((a, b) => (a.trial_id ?? 0) - (b.trial_id ?? 0));

  if (rows.length === 0) {
    const shuffled = stableShuffle(methodIds, `${pid}::${component}`);
    return [shuffled[0], shuffled[1]];
  }

  const last = rows[rows.length - 1];
  const champion = last.preferred === "left" ? last.left_method_id : last.right_method_id;

  const appeared = new Set<string>();
  for (const r of rows) {
    appeared.add(r.left_method_id);
    appeared.add(r.right_method_id);
  }

  const unseen = methodIds.filter((m) => !appeared.has(m) && m !== champion);
  if (unseen.length === 0) return null;

  const rnd = mulberry32(hash32(`${pid}::${component}::${appeared.size}`));
  const challenger = unseen[Math.floor(rnd() * unseen.length)];
  return [champion, challenger];
}

function prettify(s: string) {
  return (s || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function normKey(s: string) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function stripPlural(s: string) {
  return s.endsWith("s") ? s.slice(0, -1) : s;
}

function bestMatchingKey(obj: any, desired: string): string | null {
  if (!obj || typeof obj !== "object") return null;

  const target = normKey(desired);
  const targetS = stripPlural(target);

  let best: { key: string; score: number } | null = null;

  for (const k of Object.keys(obj)) {
    const nk = normKey(k);
    const nkS = stripPlural(nk);

    let score = 0;
    if (nk === target) score = 100;
    else if (nkS === targetS) score = 95; // handles conversation_state vs Conversation_states
    else if (nk.includes(target) || target.includes(nk)) score = 70;
    else if (nkS.includes(targetS) || targetS.includes(nkS)) score = 60;

    if (score > 0 && (!best || score > best.score)) best = { key: k, score };
  }

  return best?.key ?? null;
}

function getComponentValue(methodData: any, component: string) {
  const k = bestMatchingKey(methodData, component);
  return k ? methodData[k] : null;
}

function getDescription(descs: Record<string, string>, component: string) {
  if (!descs) return "";
  if (descs[component]) return descs[component];
  const k = bestMatchingKey(descs, component);
  return k ? descs[k] : "";
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// minimal markdown: **bold** + newlines
function renderMiniMarkdown(md: string) {
  const safe = escapeHtml(md || "");
  const withBold = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return withBold.replace(/\n/g, "<br/>");
}

function isRecord(x: any): x is Record<string, any> {
  return x && typeof x === "object" && !Array.isArray(x);
}

function clipText(x: any, max = 500) {
  if (typeof x !== "string") return x;
  return x.length > max ? x.slice(0, max - 1) + "…" : x;
}

// ---------- viewers ----------
function ActionSpaceView({ data }: { data: any }) {
  const macros = Array.isArray(data) ? data : [];
  const MAX = 80;
  const shown = macros.slice(0, MAX);

  return (
    <div className="stack">
      {macros.length > MAX && (
        <div className="note">
          Showing first <b>{MAX}</b> macro actions out of <b>{macros.length}</b>. (Rendering huge lists can slow the page.)
        </div>
      )}

      {shown.map((m: any, idx: number) => {
        const name = m?.name ?? `Macro action ${idx + 1}`;
        const goal = m?.goal;
        const desc = m?.description;
        const micros = Array.isArray(m?.micro_actions) ? m.micro_actions : [];

        return (
          <details className="accordion" key={idx}>
            <summary className="accordionSummary">
              <div className="accTitle">{clipText(name, 160)}</div>
              {goal ? <div className="accMeta">{clipText(goal, 200)}</div> : <div className="accMeta">Click to expand micro actions</div>}
            </summary>

            <div className="accordionBody">
              {(goal || desc) && (
                <div className="stack">
                  {goal && (
                    <div>
                      <div className="label">Goal</div>
                      <div className="text">{clipText(goal, 600)}</div>
                    </div>
                  )}
                  {desc && (
                    <div>
                      <div className="label">Description</div>
                      <div className="text">{clipText(desc, 800)}</div>
                    </div>
                  )}
                </div>
              )}

              <div className="divider" />

              <div className="label">Micro actions</div>
              {micros.length === 0 ? (
                <div className="note">No micro actions provided.</div>
              ) : (
                <ul className="microList">
                  {micros.slice(0, 120).map((mi: any, j: number) => (
                    <li key={j} className="microItem">
                      <div className="microName">{clipText(mi?.name ?? `Micro action ${j + 1}`, 160)}</div>
                      {mi?.description && <div className="microDesc">{clipText(mi.description, 900)}</div>}
                    </li>
                  ))}
                  {micros.length > 120 && <li className="note">Showing first 120 micro actions.</li>}
                </ul>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function TableView({ data }: { data: any }) {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return <div className="note">No rows.</div>;

  const MAX_ROWS = 220;
  const shown = rows.slice(0, MAX_ROWS);

  // union keys (bounded)
  const cols: string[] = [];
  for (const r of shown.slice(0, 80)) {
    if (isRecord(r)) {
      for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    }
  }
  const finalCols = cols.length ? cols : ["value"];

  return (
    <div className="tableWrap">
      {rows.length > MAX_ROWS && (
        <div className="note">
          Showing first <b>{MAX_ROWS}</b> rows out of <b>{rows.length}</b>.
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            {finalCols.map((c) => (
              <th key={c}>{prettify(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r: any, i: number) => (
            <tr key={i}>
              {finalCols.map((c) => {
                const v = isRecord(r) ? r[c] : c === "value" ? r : undefined;
                const cell =
                  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null
                    ? String(clipText(v ?? "", 500))
                    : JSON.stringify(v);
                return <td key={c}>{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueView({ data }: { data: any }) {
  if (!isRecord(data)) return <div className="note">Unexpected format.</div>;
  const entries = Object.entries(data);

  return (
    <div className="kv">
      {entries.map(([k, v]) => (
        <div key={k} className="kvRow">
          <div className="kvKey">{prettify(k)}</div>
          <div className="kvVal">
            {typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null ? (
              <span>{String(clipText(v ?? "", 1200))}</span>
            ) : Array.isArray(v) ? (
              <TableView data={v} />
            ) : (
              <pre className="pre">{JSON.stringify(v, null, 2)}</pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ComponentViewer({ component, value }: { component: string; value: any }) {
  if (component === "action_space") return <ActionSpaceView data={value} />;
  if (Array.isArray(value)) return <TableView data={value} />;
  if (isRecord(value)) return <KeyValueView data={value} />;
  return <pre className="pre">{JSON.stringify(value, null, 2)}</pre>;
}

function OptionCard({
  methodId,
  methodName,
  component,
  value,
}: {
  methodId: string;
  methodName: string;
  component: string;
  value: any;
}) {
  return (
    <div className="card optionCard">
      <div className="optionHeader">
        <div>
          <div className="optionTitle">Option {methodId}</div>
          <div className="optionSub">{methodName}</div>
        </div>
      </div>

      <div className="optionBody">
        <ComponentViewer component={component} value={value} />
      </div>
    </div>
  );
}


export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [descriptions, setDescriptions] = useState<Descriptions>({});
  const [dataByMethod, setDataByMethod] = useState<Record<string, any>>({});

  const [code, setCode] = useState("");
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [participantId, setParticipantId] = useState(() => localStorage.getItem("pid") || "");

  const [status, setStatus] = useState<string>("");
  const [activeComponent, setActiveComponent] = useState<string>("");

  const [history, setHistory] = useState<any[]>(() => {
    const raw = localStorage.getItem("votes");
    return raw ? JSON.parse(raw) : [];
  });

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => localStorage.setItem("votes", JSON.stringify(history)), [history]);

  useEffect(() => {
    (async () => {
      const m: Manifest = await (await fetch("./data/manifest.json")).json();
      setManifest(m);

      const desc: Descriptions = await (await fetch("./data/component_descriptions.json")).json().catch(() => ({}));
      setDescriptions(desc);

      const loaded: Record<string, any> = {};
      for (const method of m.methods) {
        loaded[method.id] = await (await fetch("./data/" + method.file)).json();
      }
      setDataByMethod(loaded);

      setActiveComponent(m.components[0] || "");
    })().catch((e) => setStatus(`❌ Failed to load data: ${e.message}`));
  }, []);

  const methodNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const x of manifest?.methods ?? []) m[x.id] = x.name;
    return m;
  }, [manifest]);

  const methodIds = useMemo(() => {
  if (!manifest || !activeComponent) return [];
  return manifest.methods
    .map((x) => x.id)
    .filter((id) => dataByMethod[id] && bestMatchingKey(dataByMethod[id], activeComponent));
}, [manifest, dataByMethod, activeComponent]);

  const pair = useMemo(() => nextPair(participantId, activeComponent, methodIds, history), [
    participantId,
    activeComponent,
    methodIds,
    history,
  ]);

  const leftId = pair?.[0] || "";
  const rightId = pair?.[1] || "";
  const leftObj = leftId ? getComponentValue(dataByMethod[leftId], activeComponent) : null;
  const rightObj = rightId ? getComponentValue(dataByMethod[rightId], activeComponent) : null;

  const progress = useMemo(() => {
    const rows = history.filter((r) => r.participant_id === participantId && r.component === activeComponent);
    const seen = rows.length;
    const total = Math.max(methodIds.length - 1, 0);
    return { seen, total };
  }, [history, participantId, activeComponent, methodIds.length]);

  async function startSurvey() {
    try {
      setSubmitting(true);
      setStatus("Checking access code…");
      const res = await postJSON(`${API_BASE}/start`, { code });

      localStorage.setItem("token", res.token);
      localStorage.setItem("pid", res.participant_id);

      setToken(res.token);
      setParticipantId(res.participant_id);

      setStatus("✅ Access granted. Your session is saved in this browser.");
    } catch (e: any) {
      setStatus(`❌ ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function vote(preferred: "left" | "right") {
    if (!pair || !token || !participantId) return;

    const trialId =
      history
        .filter((r) => r.participant_id === participantId)
        .reduce((mx, r) => Math.max(mx, r.trial_id ?? 0), 0) + 1;

    const voteObj = {
      participant_id: participantId,
      component: activeComponent,
      trial_id: trialId,
      left_method_id: leftId,
      right_method_id: rightId,
      preferred,
      timestamp_utc: nowUtc(),
      user_agent: navigator.userAgent,
      page_url: window.location.href,
    };

    setHistory((prev) => [...prev, voteObj]);

    try {
      setSubmitting(true);
      setStatus("Submitting…");
      await postJSON(`${API_BASE}/vote`, { token, vote: voteObj });
      setStatus("✅ Submitted.");
    } catch (e: any) {
      setStatus(`⚠️ Submit failed (saved locally): ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("pid");
    setToken("");
    setParticipantId("");
    setStatus("Logged out.");
  }

  if (!manifest) {
    return (
      <div className="app">
        <div className="container">
          <div className="card">
            <div className="title">Loading…</div>
            <div className="note">Fetching manifest and method outputs.</div>
          </div>
        </div>
      </div>
    );
  }

  // gate
  if (!token || !participantId) {
    return (
      <div className="app">
        <div className="container narrow">
          <div className="card">
            <div className="title">TOPA Expert Survey</div>
            <div
              className="intro"
              dangerouslySetInnerHTML={{ __html: APP_DESC }}
            />

            <form
              className="formRow"
              onSubmit={(e) => {
                e.preventDefault();
                if (code && !submitting) startSurvey();
              }}
            >
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Access code"
                autoComplete="one-time-code"
              />
              <button className="btn btnPrimary" type="submit" disabled={!code || submitting}>
                {submitting ? "Starting…" : "Start"}
              </button>
            </form>

            {status && <div className="status">{status}</div>}
          </div>
        </div>
      </div>
    );
  }

  const hasEnoughMethods = methodIds.length >= 2;
  const complete = hasEnoughMethods ? pair === null : false;
  const compDesc = getDescription(descriptions, activeComponent);

  return (
    <div className="app">
      <div className="container">
        <div className="topbar">
          <div>
            <div className="title">TOPA Expert Survey</div>
            <div className="subtitle">Choose the option that best reflects clinically meaningful CBT practice.</div>
          </div>

          <div className="topbarRight">
            <button className="btn btnGhost" onClick={logout}>
              Log out
            </button>
          </div>
        </div>

        {status && <div className="status">{status}</div>}

        <div className="toolbar">
          <div className="toolbarBlock">
            <div className="label">Component</div>
            <select className="select" value={activeComponent} onChange={(e) => setActiveComponent(e.target.value)}>
              {manifest.components.map((c) => (
                <option key={c} value={c}>
                  {prettify(c)}
                </option>
              ))}
            </select>
          </div>

          <div className="toolbarBlock">
            <div className="label">Progress</div>
            <div className="pill">
              {progress.seen}/{progress.total} comparisons
            </div>
          </div>

          <div className="toolbarBlock grow">
            <div className="label">Description</div>
            <div
              className="descBox"
              dangerouslySetInnerHTML={{
                __html: compDesc
                  ? renderMiniMarkdown(compDesc)
                  : "<span class='note'>No description found for this component.</span>",
              }}
            />
          </div>
        </div>

        {!hasEnoughMethods && (
          <div className="card">
            <div className="titleSm">⚠️ Component not available</div>
            <div className="text">
              This component doesn’t exist in at least two method outputs (or the keys don’t match).
              Check your JSON keys vs manifest, or rely on the automatic matching logic we added.
            </div>
          </div>
        )}

        {activeComponent === "action_space" && (
          <div className="callout">
            <div className="calloutBody">
              <b>Tip:</b> In <b>Action Space</b>, click a <b>macro action</b> to expand and view its <b>micro actions</b>.
            </div>
          </div>
        )}

        {complete ? (
          <div className="card">
            <div className="titleSm">✅ Completed</div>
            <div className="text">
              You’ve completed comparisons for <b>{prettify(activeComponent)}</b>. You can switch to another component using the dropdown.
            </div>
          </div>
        ) : (
          <>
            <div className="grid2">
              <OptionCard
                methodId={leftId}
                methodName={methodNameById[leftId] || "Method"}
                component={activeComponent}
                value={leftObj}
              />
              <OptionCard
                methodId={rightId}
                methodName={methodNameById[rightId] || "Method"}
                component={activeComponent}
                value={rightObj}
              />
            </div>

            <div className="voteBar">
              <button className="btn btnPrimary" onClick={() => vote("left")} disabled={submitting}>
                Prefer LEFT
              </button>
              <button className="btn btnPrimary" onClick={() => vote("right")} disabled={submitting}>
                Prefer RIGHT
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
