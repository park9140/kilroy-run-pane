import { useState, useEffect, useCallback, useRef } from "react";
import type { RunState, StageInfo, VisitedStage, ComputedStatus } from "../lib/types";

interface RunMonitorState {
  runState: RunState | null;
  stages: StageInfo[];
  stageHistory: VisitedStage[];
  dot: string;
  loading: boolean;
  error: string | null;
  connected: boolean;
}

const RETRY_DELAY_MS = [1000, 2000, 4000, 8000, 15000];
const TERMINAL: Set<ComputedStatus> = new Set(["completed", "failed", "interrupted"]);
/** How long to wait after the tab goes hidden before disconnecting SSE. */
const VISIBILITY_GRACE_MS = 60_000;

export function useRunMonitor(runId: string | undefined): RunMonitorState {
  const [runState, setRunState] = useState<RunState | null>(null);
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [stageHistory, setStageHistory] = useState<VisitedStage[]>([]);
  const [dot, setDot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const retryCount = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last known computed status so we can skip reconnects for terminal runs.
  const lastStatus = useRef<ComputedStatus | null>(null);
  // Timer for the visibility grace period.
  const visibilityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disconnect = useCallback(() => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setConnected(false);
  }, []);

  const connect = useCallback((id: string) => {
    // Don't reconnect if run is terminal — nothing will change.
    if (lastStatus.current && TERMINAL.has(lastStatus.current)) return;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
      retryCount.current = 0;
      setLoading(false);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          setError(data.error);
          return;
        }
        const state = data as RunState;
        setRunState(state);
        setLoading(false);
        if (state.dot) setDot(state.dot);
        if (state.stages?.length) setStages(state.stages);
        if (state.stageHistory?.length) setStageHistory(state.stageHistory);
        // Track status for terminal detection.
        if (state.computedStatus) lastStatus.current = state.computedStatus;
        // If run just became terminal, close the SSE — no more updates expected.
        if (state.computedStatus && TERMINAL.has(state.computedStatus)) {
          es.close();
          esRef.current = null;
          // Leave connected=true-ish: the state is final, no reconnect needed.
          // The green dot going away signals "no live connection" which is correct.
          setConnected(false);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Don't retry if terminal.
      if (lastStatus.current && TERMINAL.has(lastStatus.current)) return;
      // Exponential backoff retry
      const delay = RETRY_DELAY_MS[Math.min(retryCount.current, RETRY_DELAY_MS.length - 1)];
      retryCount.current++;
      retryTimer.current = setTimeout(() => connect(id), delay);
    };
  }, []);

  // ── Main effect: connect on mount, clean up on unmount / runId change ──
  useEffect(() => {
    if (!runId) {
      setLoading(false);
      setError("No run ID provided");
      return;
    }

    setLoading(true);
    setError(null);
    setRunState(null);
    setStages([]);
    setStageHistory([]);
    setDot("");
    retryCount.current = 0;
    lastStatus.current = null;

    connect(runId);

    return () => {
      disconnect();
      if (visibilityTimer.current) { clearTimeout(visibilityTimer.current); visibilityTimer.current = null; }
    };
  }, [runId]);

  // ── Page visibility: pause SSE when tab is hidden, resume when visible ──
  useEffect(() => {
    if (!runId) return;

    const onVisibilityChange = () => {
      if (document.hidden) {
        // Tab went to background — start grace period before disconnecting.
        if (visibilityTimer.current) clearTimeout(visibilityTimer.current);
        visibilityTimer.current = setTimeout(() => {
          visibilityTimer.current = null;
          // Only disconnect if still hidden (user might have switched back).
          if (document.hidden) {
            disconnect();
          }
        }, VISIBILITY_GRACE_MS);
      } else {
        // Tab came back — cancel pending disconnect and reconnect if needed.
        if (visibilityTimer.current) { clearTimeout(visibilityTimer.current); visibilityTimer.current = null; }
        if (!esRef.current) {
          retryCount.current = 0;
          connect(runId);
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (visibilityTimer.current) { clearTimeout(visibilityTimer.current); visibilityTimer.current = null; }
    };
  }, [runId, connect, disconnect]);

  return { runState, stages, stageHistory, dot, loading, error, connected };
}
