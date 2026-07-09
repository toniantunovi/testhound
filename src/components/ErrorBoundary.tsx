import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors from any screen so a single broken component shows
 * a readable message instead of blanking the whole window to black.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-text-primary">
          Something went wrong
        </h1>
        <pre className="selectable max-w-xl overflow-auto rounded-card border border-border-subtle bg-bg-surface p-3 text-left font-mono text-xs text-status-failed">
          {error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="rounded-control border border-border-subtle px-3 py-1.5 text-sm text-text-primary hover:border-border-strong"
        >
          Dismiss
        </button>
      </div>
    );
  }
}
