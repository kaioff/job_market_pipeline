import { resolvedBoards } from "./resolver.js";

/**
 * Which company boards to poll, per ATS.
 *
 * Derived, not curated. The list comes from resolver.js — every company
 * seen in LinkedIn search results that we managed to map onto a supported
 * ATS. That's what keeps this from being a hand-maintained target list:
 * discovery stays broad (LinkedIn sees every employer), while delivery
 * stays fast (ATS boards publish instantly).
 *
 * Env vars still win, for pinning a company the resolver can't find or for
 * running a fixed set in a test.
 */

const ATS = ["greenhouse", "ashby", "lever", "smartrecruiters", "workable"];

const ENV = {
  greenhouse: "BOARD_GREENHOUSE",
  ashby: "BOARD_ASHBY",
  lever: "BOARD_LEVER",
  smartrecruiters: "BOARD_SMARTRECRUITERS",
  workable: "BOARD_WORKABLE",
};

function fromEnv(ats) {
  const raw = process.env[ENV[ats]];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Read through to the resolver on every access rather than snapshotting at
 * import time — the map grows while the process runs, as discovery finds
 * companies, and a newly resolved board should join the next poll without
 * a restart.
 */
export const COMPANIES = Object.fromEntries(
  ATS.map((ats) => [
    ats,
    {
      get length() {
        return this.list().length;
      },
      list() {
        const env = fromEnv(ats);
        const resolved = resolvedBoards()[ats] || [];
        return [...new Set([...env, ...resolved])];
      },
      [Symbol.iterator]() {
        return this.list()[Symbol.iterator]();
      },
    },
  ])
);
