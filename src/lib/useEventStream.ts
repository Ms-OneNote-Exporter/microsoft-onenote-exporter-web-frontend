/**
 * The event stream as React state.
 *
 * `events.ts` owns the transport — `withCredentials`, backoff, replay via
 * `Last-Event-ID` — and is deliberately framework-free so it can be tested
 * without a renderer. This hook is the thin layer that turns those callbacks
 * into something a component can render.
 *
 * `useSyncExternalStore` rather than `useEffect` + `useState`: the stream's
 * status is external mutable state that changes while React is not rendering,
 * and the effect version can drop the last event of a stream that closes in
 * the same tick it opens. It also gives the subscription an identity React can
 * compare, so StrictMode's development double-invoke opens and closes exactly
 * one stream rather than two.
 */
import { useEffect, useRef, useState } from "react";
import {
  openEventStream,
  type StreamState,
  type StreamHandlers,
} from "./events";

export interface StreamEvent {
  id: string;
  event: string;
  data: unknown;
}

export interface EventStream {
  state: StreamState;
  /** The most recent event, so a re-render has something to show. */
  last: StreamEvent | null;
}

/**
 * Handlers are usually an inline literal, so their identity changes on every
 * render. Feeding them through a ref keeps the subscription stable: a changing
 * dependency would tear the stream down and reconnect each render, which
 * against a real server is a reconnect storm.
 */
export function useEventStream(
  enabled: boolean,
  onEvent: (event: StreamEvent) => void,
): EventStream {
  const [state, setState] = useState<StreamState>("closed");
  const [last, setLast] = useState<StreamEvent | null>(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) {
      setState("closed");
      return;
    }

    const handlers: StreamHandlers = {
      onState: setState,
      onEvent: (id, event, data) => {
        setLast({ id, event, data });
        onEventRef.current({ id, event, data });
      },
    };

    return openEventStream(handlers);
  }, [enabled]);

  return { state, last };
}