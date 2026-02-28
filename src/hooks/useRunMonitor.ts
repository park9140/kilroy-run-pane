import { useState, useEffect, useCallback, useRef } from "react";
import type { RunState, StageInfo, VisitedStage } from "../lib/types";

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
        if (state.dot) setDot(state.dot);
        if (state.stages?.length) setStages(state.stages);
        if (state.stageHistory?.length) setStageHistory(state.stageHistory);
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
  }, []);

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
