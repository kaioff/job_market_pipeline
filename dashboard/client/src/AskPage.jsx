import { useState, useRef, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

const EXAMPLES = [
  "What are the 10 most in-demand skills right now?",
  "Which skills appear most often alongside dbt?",
  "How many years of experience do Spark roles ask for?",
  "Which companies post the most data engineering jobs?",
  "Which skills grew the most over the last month?",
];

// What each MCP tool is doing, in reader terms.
const TOOL_LABELS = {
  top_keywords: "Checking the latest skill ranking",
  keyword_trends: "Pulling skill trends over time",
  describe_tables: "Looking at the available tables",
  run_sql: "Querying the warehouse",
  recent_postings: "Reading the live job board",
  board_stats: "Checking the live board",
};

/**
 * Reads the /api/ask SSE stream. It's a POST (the question and history go
 * in the body), so EventSource can't be used; frames are parsed by hand.
 */
async function streamAsk(body, onEvent, signal) {
  const res = await fetch(`${API_BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

export default function AskPage() {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Patch the in-progress (last) turn.
  const updateLast = (fn) =>
    setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  async function submit(question) {
    const q = question.trim();
    if (!q || busy) return;

    // Prior finished answers give the model context for follow-ups.
    const history = turns
      .filter((t) => t.answer && !t.error)
      .flatMap((t) => [
        { role: "user", content: t.question },
        { role: "assistant", content: t.answer },
      ]);

    setInput("");
    setBusy(true);
    setTurns((ts) => [...ts, { question: q, answer: "", steps: [], error: null }]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAsk(
        { question: q, history },
        (event, data) => {
          if (event === "text") {
            updateLast((t) => ({ ...t, answer: t.answer + data.delta }));
          } else if (event === "tool") {
            updateLast((t) => ({
              ...t,
              steps: [...t.steps, { id: data.id, name: data.name, input: data.input, state: "running" }],
            }));
          } else if (event === "tool_done") {
            updateLast((t) => ({
              ...t,
              steps: t.steps.map((s) =>
                s.id === data.id ? { ...s, state: data.error ? "failed" : "done" } : s
              ),
            }));
          } else if (event === "error") {
            updateLast((t) => ({ ...t, error: data.message }));
          }
        },
        controller.signal
      );
    } catch (err) {
      updateLast((t) => ({
        ...t,
        error: controller.signal.aborted ? "Stopped." : err.message || "Couldn't reach the API.",
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="hero hero--compact">
        <div className="hero-scanline" aria-hidden="true" />
        <div className="hero-content">
          <span className="eyebrow">ASK THE DATA · CLAUDE + MCP</span>
          <h1>
            Ask anything.
            <br />
            <span className="accent">Answered from the warehouse.</span>
          </h1>
          <p className="hero-sub">
            Claude queries the same gold and silver tables behind this
            dashboard, read-only, and answers with the real numbers.
          </p>
        </div>
      </header>

      <main className="content">
        <section className="panel ask-panel">
          {turns.length === 0 && (
            <div className="ask-empty">
              <p className="panel-caption">Try one of these, or ask your own:</p>
              <div className="skill-suggestions">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="skill-chip" onClick={() => submit(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => {
            const running = busy && i === turns.length - 1;
            return (
              <article key={i} className="ask-turn">
                <p className="ask-question">{t.question}</p>

                {t.steps.length > 0 && (
                  <ul className="ask-steps">
                    {t.steps.map((s) => (
                      <li key={s.id} className={`ask-step ask-step--${s.state}`}>
                        <span className="ask-step-dot" aria-hidden="true" />
                        {TOOL_LABELS[s.name] || s.name}
                        {s.state === "failed" && " — retrying"}
                        {s.name === "run_sql" && s.input?.sql && (
                          <details>
                            <summary>SQL</summary>
                            <pre>{s.input.sql}</pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {t.answer.trim() && (
                  <div className="ask-answer">
                    <Markdown remarkPlugins={[remarkGfm]}>{t.answer.trim()}</Markdown>
                  </div>
                )}

                {running && !t.answer.trim() && (
                  <div className="status-panel">
                    <div className="pulse-dot" />
                    {t.steps.length ? "Working it out…" : "Thinking…"}
                  </div>
                )}

                {t.error && <div className="status-panel status-error">{t.error}</div>}
              </article>
            );
          })}
          <div ref={endRef} />

          <form
            className="skill-search ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <input
              className="skill-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={turns.length ? "Ask a follow-up…" : "e.g. What share of postings mention Kafka?"}
              maxLength={2000}
              aria-label="Your question"
            />
            {busy ? (
              <button className="skill-submit" type="button" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="skill-submit" type="submit" disabled={!input.trim()}>
                Ask
              </button>
            )}
          </form>
          {turns.length > 0 && !busy && (
            <button type="button" className="ask-clear" onClick={() => setTurns([])}>
              New conversation
            </button>
          )}
        </section>
      </main>
    </>
  );
}
