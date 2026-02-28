import { useState, useEffect, useCallback, useRef } from "react";
import type { RunState, StageInfo, VisitedStage, DiagnosisResult } from "../lib/types";

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

  // Fetch diagnosis (stages) from kilroy-dash proxy
  const fetchDiagnosis = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/diagnose`);
      if (!res.ok) return;
      const data: DiagnosisResult = await res.json();
      if (data.stages) setStages(data.stages);
    } catch {
      // diagnosis is optional — kilroy-dash may not be running
    }
  }, []);

  // Fetch DOT content from kilroy-dash proxy
  const fetchDot = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/dot`);
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data?.dot === "string") setDot(data.dot);
      else if (typeof data === "string") setDot(data);
    } catch {
      // DOT is optional
    }
  }, []);

  const connect = useCallback((id: string) => {
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
        // For attractor format: dot, stages, and stageHistory come directly in the RunState
        if (state.dot) setDot(state.dot);
        if (state.stages?.length) setStages(state.stages);
        if (state.stageHistory?.length) setStageHistory(state.stageHistory);
        // For kilroy-dash format: fetch from proxy
        if (!state.dot && state.run?.id) fetchDot(state.run.id);
        if (!state.stages?.length && state.run?.id) fetchDiagnosis(state.run.id);
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Exponential backoff retry
      const delay = RETRY_DELAY_MS[Math.min(retryCount.current, RETRY_DELAY_MS.length - 1)];
      retryCount.current++;
      retryTimer.current = setTimeout(() => connect(id), delay);
    };
  }, [dot, fetchDiagnosis, fetchDot]);

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

    connect(runId);
    // Eagerly fetch from kilroy-dash proxy as fallback (attractor format
    // will override these when the first SSE message arrives with dot/stages)
    fetchDiagnosis(runId);
    fetchDot(runId);

    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [runId]);

  return { runState, stages, stageHistory, dot, loading, error, connected };
}
