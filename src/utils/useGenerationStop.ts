import { useEffect, useRef, useState } from "react";
import type { Meeting } from "../types";

/** The pending acknowledgement belongs to one selection, never the next meeting. */
export function useGenerationStop(meeting: Meeting | null, stop: (id: string) => Promise<void>) {
  const identity = useRef({ id: meeting?.id });
  if (identity.current.id !== meeting?.id) identity.current = { id: meeting?.id };
  const inFlight = useRef<object | null>(null);
  const [pending, setPending] = useState<object | null>(null);
  const [failure, setFailure] = useState<{ identity: object; message: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState<object | null>(null);
  const rerunRef = useRef<HTMLButtonElement>(null);
  const selection = identity.current;
  const stopping = pending === selection || meeting?.status === "cancelling";

  useEffect(() => {
    if (meeting?.status === "cancelled" && !stopping &&
      (acknowledged === selection || failure?.identity === selection)) {
      rerunRef.current?.focus();
      setFailure(null);
    }
  }, [meeting?.status, stopping, acknowledged, failure, selection]);

  const requestStop = async () => {
    if (!meeting || inFlight.current === selection) return;
    const id = meeting.id;
    inFlight.current = selection;
    setPending(selection);
    setFailure(null);
    try {
      await stop(id);
      if (identity.current !== selection) return;
      setAcknowledged(selection);
    } catch (error) {
      if (identity.current !== selection) return;
      setFailure({ identity: selection, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inFlight.current === selection) inFlight.current = null;
      if (identity.current === selection) setPending(null);
    }
  };

  return { stopping, requestPending: pending === selection, requestStop, rerunRef, stopError: failure?.identity === selection ? failure.message : "" };
}
