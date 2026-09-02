import { ResponsiveCirclePacking } from "@nivo/circle-packing";
import { useMemo } from "react";

function shapeForBubbles(rows, topN = 20) {
  const children = rows.slice(0, topN).map((r) => ({
    id: r.keyword,
    value: r.pct ?? r.posting_count,
    pct: r.pct,
    count: r.posting_count,
  }));
  return { id: "root", children };
}

// Custom label: sizes font to the circle radius and only renders if the
// text realistically fits. Long multi-word terms wrap onto two lines.
function FittedLabel({ node, label }) {
  const r = node.radius;
  // Rough char-width heuristic for monospace: ~0.6em per char.
  const words = String(label).split(" ");
  const longest = Math.max(...words.map((w) => w.length));

  // Font size scaled to radius, capped so big bubbles don't get huge text.
  let fontSize = Math.min(r * 0.42, 16);

  // If the longest word can't fit even at a small size, skip the label.
  const fitsAt = (fs) => longest * fs * 0.62 <= r * 1.85;
  if (!fitsAt(fontSize)) fontSize = (r * 1.85) / (longest * 0.62);
  if (fontSize < 7) return null; // too small to be legible — rely on tooltip

  const multiline = words.length > 1 && longest * fontSize * 0.62 > r * 1.4;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      style={{ pointerEvents: "none" }}
    >
      {multiline ? (
        words.map((w, i) => (
          <text
            key={i}
            textAnchor="middle"
            dominantBaseline="central"
            y={(i - (words.length - 1) / 2) * fontSize * 1.15}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize,
              fontWeight: 600,
              fill: "#0a0f1e",
            }}
          >
            {w}
          </text>
        ))
      ) : (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize,
            fontWeight: 600,
            fill: "#0a0f1e",
          }}
        >
          {label}
        </text>
      )}
    </g>
  );
}

export default function BubbleChart({ rows }) {
  const data = useMemo(() => shapeForBubbles(rows), [rows]);

  if (!rows || rows.length === 0) {
    return <div className="empty-state">No signal data yet.</div>;
  }

  return (
    <div style={{ height: 560 }}>
      <ResponsiveCirclePacking
        data={data}
        id="id"
        value="value"
        padding={6}
        leavesOnly={true}
        enableLabels={false}
        colors={{ scheme: "oranges" }}
        colorBy="id"
        borderWidth={1}
        borderColor="#0a0f1e"
        layers={[
          "circles",
          ({ nodes }) => (
            <g>
              {nodes
                .filter((n) => n.height === 0)
                .map((node) => (
                  <FittedLabel key={node.id} node={node} label={node.id} />
                ))}
            </g>
          ),
        ]}
        tooltip={({ id, data }) => (
          <div
            style={{
              background: "#121a2e",
              color: "#e8eaf0",
              padding: "8px 12px",
              border: "1px solid #212c47",
              borderRadius: 6,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >
            <strong>{id}</strong>
            <br />
            {data.pct != null && <span>{data.pct}% of postings</span>}
            {data.count != null && <span> · {data.count} listings</span>}
          </div>
        )}
        animate={true}
        motionConfig="gentle"
      />
    </div>
  );
}