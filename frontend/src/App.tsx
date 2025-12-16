import { useEffect, useMemo, useState } from "react";
import JsonView from "@uiw/react-json-view";

type Manifest = {
  components: string[];
  methods: { id: string; name: string; file: string }[];
};

const API_BASE = import.meta.env.VITE_API_BASE as string; // e.g. https://xxx.workers.dev/api

function nowUtc() { return new Date().toISOString(); }

async function postJSON(url: string, payload: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  let j: any = null;
  try { j = JSON.parse(txt); } catch {}
  if (!r.ok) throw new Error(j?.error || txt || `HTTP ${r.status}`);
  return j;
}

// champion vs unseen challengers (simple tournament)
function nextPair(pid: string, component: string, methodIds: string[], history: any[]) {
  if (methodIds.length < 2) return null;

  const rows = history.filter(r => r.participant_id === pid && r.component === component);

  if (rows.length === 0) return [methodIds[0], methodIds[1]];

  const last = rows[rows.length - 1];
  const champion = last.preferred === "left" ? last.left_method_id : last.right_method_id;

  const appeared = new Set<string>();
  for (const r of rows) { appeared.add(r.left_method_id); appeared.add(r.right_method_id); }

  const unseen = methodIds.filter(m => !appeared.has(m) && m !== champion);
  if (unseen.length === 0) return null;

  return [champion, unseen[rows.length % unseen.length]];
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [dataByMethod, setDataByMethod] = useState<Record<string, any>>({});

  const [participantId, setParticipantId] = useState(() =>
    localStorage.getItem("pid") || `P${Math.floor(Math.random()*1e6).toString().padStart(6,"0")}`
  );

  const [code, setCode] = useState("");
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [status, setStatus] = useState("");

  const [activeComponent, setActiveComponent] = useState("action_space");
  const [history, setHistory] = useState<any[]>(() => {
    const raw = localStorage.getItem("votes");
    return raw ? JSON.parse(raw) : [];
  });

  useEffect(() => localStorage.setItem("pid", participantId), [participantId]);
  useEffect(() => localStorage.setItem("votes", JSON.stringify(history)), [history]);

  useEffect(() => {
    (async () => {
      const m: Manifest = await (await fetch("./data/manifest.json")).json();
      setManifest(m);
      setActiveComponent(m.components[0] || "action_space");

      const loaded: Record<string, any> = {};
      for (const method of m.methods) {
        loaded[method.id] = await (await fetch("./data/" + method.file)).json();
      }
      setDataByMethod(loaded);
    })();
  }, []);

  const methodIds = useMemo(() => {
    if (!manifest) return [];
    return manifest.methods
      .map(x => x.id)
      .filter(id => dataByMethod[id] && (activeComponent in dataByMethod[id]));
  }, [manifest, dataByMethod, activeComponent]);

  const pair = useMemo(() => nextPair(participantId, activeComponent, methodIds, history), [
    participantId, activeComponent, methodIds, history
  ]);

  const leftId = pair?.[0] || "";
  const rightId = pair?.[1] || "";
  const leftObj = leftId ? dataByMethod[leftId]?.[activeComponent] : null;
  const rightObj = rightId ? dataByMethod[rightId]?.[activeComponent] : null;

  const trialId = useMemo(() => {
    const rows = history.filter(r => r.participant_id === participantId);
    return rows.reduce((mx, r) => Math.max(mx, r.trial_id), 0) + 1;
  }, [history, participantId]);

  async function startSurvey() {
    try {
      setStatus("Checking code…");
      const res = await postJSON(`${API_BASE}/start`, { code });
      localStorage.setItem("token", res.token);
      setToken(res.token);
      setStatus("✅ Access granted.");
    } catch (e: any) {
      setStatus(`❌ ${e.message}`);
    }
  }

  async function vote(preferred: "left" | "right") {
    if (!pair) return;

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

    // always save locally first
    setHistory(prev => [...prev, voteObj]);

    try {
      setStatus("Submitting…");
      await postJSON(`${API_BASE}/vote`, { token, vote: voteObj });
      setStatus("✅ Submitted.");
    } catch (e: any) {
      setStatus(`⚠️ Submit failed (saved locally): ${e.message}`);
    }
  }

  if (!manifest) return <div style={{ padding: 16 }}>Loading…</div>;

  // gate
  if (!token) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
        <h2>TOPA Expert Survey</h2>
        <p>Enter your access code to start.</p>
        <input value={code} onChange={e => setCode(e.target.value)} style={{ padding: 8, width: 260 }} />
        <button onClick={startSurvey} style={{ marginLeft: 10, padding: "8px 12px" }}>Start</button>
        <div style={{ marginTop: 12, opacity: 0.85 }}>{status}</div>
      </div>
    );
  }

  const complete = pair === null;

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h2>TOPA Expert Survey</h2>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label>
          Participant ID{" "}
          <input value={participantId} onChange={e => setParticipantId(e.target.value)} style={{ padding: 6, width: 180 }} />
        </label>
        <button
          onClick={() => { localStorage.removeItem("token"); setToken(""); }}
          style={{ padding: "6px 10px" }}
        >
          Log out
        </button>
      </div>

      <div style={{ marginTop: 10, opacity: 0.85 }}>{status}</div>

      {/* tabs */}
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {manifest.components.map(c => (
          <button
            key={c}
            onClick={() => setActiveComponent(c)}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #444",
              background: c === activeComponent ? "#222" : "transparent",
              color: "inherit",
              cursor: "pointer"
            }}
          >
            {c}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {complete ? (
          <div style={{ padding: 12, border: "1px solid #444", borderRadius: 12 }}>
            ✅ Completed comparisons for <b>{activeComponent}</b>.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ border: "1px solid #444", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Option {leftId}</div>
                <JsonView value={leftObj ?? {}} collapsed={1} />
              </div>
              <div style={{ border: "1px solid #444", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Option {rightId}</div>
                <JsonView value={rightObj ?? {}} collapsed={1} />
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button onClick={() => vote("left")} style={{ padding: "10px 12px" }}>Prefer LEFT</button>
              <button onClick={() => vote("right")} style={{ padding: "10px 12px" }}>Prefer RIGHT</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
