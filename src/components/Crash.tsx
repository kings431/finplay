import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportCrash } from "../crash";

type State = { error: Error | null };

/** Without this, one render error unmounts the whole tree and leaves an empty window. */
export class Crash extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Finplay crashed", error);
    reportCrash("Crash screen", error, (info.componentStack ?? "").trim().split("\n").slice(0, 6).join(" ← "));
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>{error.message || String(error)}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Reload Finplay
        </button>
      </div>
    );
  }
}
