// Toast host + context (spec §4). Success/error/info with an optional action
// (used by review triage's Undo). Ports the old toast contract.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastAction { label: string; run: () => void }
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  push: (kind: ToastKind, message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi['push']>((kind, message, action) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { id, kind, message, action }]);
    window.setTimeout(() => dismiss(id), DISMISS_MS);
  }, [dismiss]);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto animate-[toastin_180ms_ease-out] rounded-lg border border-deep-700 bg-deep-800/95 px-4 py-3 text-sm text-ink shadow-lg shadow-black/40 backdrop-blur"
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className={
                  'mt-1 h-2 w-2 shrink-0 rounded-full ' +
                  (t.kind === 'success' ? 'bg-flow-400' : t.kind === 'error' ? 'bg-deny' : 'bg-kind-file')
                }
              />
              <span className="flex-1 leading-snug">{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                  className="shrink-0 font-mono text-xs text-flow-300 hover:text-flow-400"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                aria-label="dismiss"
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-ink-faint hover:text-ink"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
