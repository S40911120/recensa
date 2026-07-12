import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-level error boundary. A render throw — e.g. a malformed session record that a message
 * component doesn't expect — otherwise unmounts the whole React tree to a blank page. This
 * catches it and shows a recoverable message so the viewer never dies silently.
 *
 * Class component is the only React API that can catch render errors, so this is the documented
 * exception to the function-component rule.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[recensa] render error:', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold text-destructive">Something went wrong rendering this view</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          A session record may be malformed. Try again, or reload the page — your data on disk is untouched.
        </p>
        <pre className="max-w-lg overflow-x-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => globalThis.location.reload()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
